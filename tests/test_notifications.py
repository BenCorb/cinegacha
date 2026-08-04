from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


_TEMP_DIR = tempfile.TemporaryDirectory()
os.environ["GACHA_DB"] = os.path.join(_TEMP_DIR.name, "notifications.sqlite")
ROOT = Path(__file__).resolve().parents[1]

import game  # noqa: E402
import server  # noqa: E402
from db import db, init_db  # noqa: E402


class QuietHandler(server.Handler):
    def log_message(self, format: str, *args) -> None:
        pass


class NotificationIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)
        _TEMP_DIR.cleanup()

    def setUp(self) -> None:
        with db() as conn:
            conn.execute("DELETE FROM users")

    def request(self, path: str, *, auth: dict | None = None, body: dict | None = None):
        headers = {"Content-Type": "application/json"}
        if auth:
            headers.update({
                "X-Username": auth["username"],
                "X-Connection-Key": auth["connectionKey"],
            })
        payload = json.dumps(body).encode() if body is not None else None
        request = Request(
            self.base_url + path,
            data=payload,
            headers=headers,
            method="POST" if body is not None else "GET",
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def create_user(self, username: str) -> dict:
        status, payload = self.request("/api/users", body={"username": username})
        self.assertEqual(status, 201)
        return payload

    def give_duplicate(self, username: str, item_id: str) -> None:
        with db() as conn:
            user_id = conn.execute(
                "SELECT id FROM users WHERE username = ?", (username,)
            ).fetchone()["id"]
            game.add_item(conn, user_id, item_id, 2)

    def test_schema_is_additive_without_notification_backfill(self) -> None:
        migration_db = Path(_TEMP_DIR.name) / "migration.sqlite"
        migration_env = os.environ.copy()
        migration_env["GACHA_DB"] = str(migration_db)
        init_command = [sys.executable, "-c", "from db import init_db; init_db()"]
        subprocess.run(init_command, cwd=ROOT, env=migration_env, check=True)

        item_id = next(iter(game.ITEMS))
        with sqlite3.connect(migration_db) as conn:
            conn.execute("DROP TABLE notifications")
            conn.executemany(
                """
                INSERT INTO users
                    (username, key_hash, created_at, credits, last_credit_refill_at, total_sells)
                VALUES (?, 'hash', 1, 2000, 1, 0)
                """,
                [("legacy-sender",), ("legacy-receiver",)],
            )
            conn.execute(
                """
                INSERT INTO trades
                    (id, from_user_id, to_user_id, offer_item_id, request_item_id, status, created_at)
                VALUES ('legacy-trade', 1, 2, ?, ?, 'sent', 1)
                """,
                (item_id, item_id),
            )
        subprocess.run(init_command, cwd=ROOT, env=migration_env, check=True)

        with sqlite3.connect(migration_db) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(notifications)")}
            count = conn.execute("SELECT COUNT(*) FROM notifications").fetchone()[0]
            legacy_trade = conn.execute(
                "SELECT COUNT(*) FROM trades WHERE id = 'legacy-trade'"
            ).fetchone()[0]
        self.assertTrue({"type", "source_id", "payload_json", "read_at"}.issubset(columns))
        self.assertEqual(count, 0)
        self.assertEqual(legacy_trade, 1)

    def test_card_and_achievement_notifications_and_read_isolation(self) -> None:
        sender = self.create_user("sender")
        receiver = self.create_user("receiver")
        item_id = next(iter(game.ITEMS))
        self.give_duplicate(sender["username"], item_id)

        status, _ = self.request(
            "/api/trades",
            auth=sender,
            body={"toUsername": receiver["username"], "offerItemId": item_id},
        )
        self.assertEqual(status, 201)

        _, receiver_data = self.request("/api/notifications", auth=receiver)
        receiver_types = [item["type"] for item in receiver_data["notifications"]]
        self.assertIn("card_received", receiver_types)
        self.assertIn("achievement_unlocked", receiver_types)
        self.assertEqual(receiver_data["unreadCount"], len(receiver_data["notifications"]))

        _, sender_data = self.request("/api/notifications", auth=sender)
        self.assertNotIn("card_received", [item["type"] for item in sender_data["notifications"]])

        card_id = next(
            item["id"] for item in receiver_data["notifications"]
            if item["type"] == "card_received"
        )
        _, forbidden_read = self.request(
            "/api/notifications/read", auth=sender, body={"ids": [card_id]}
        )
        self.assertEqual(forbidden_read["updated"], 0)

        with db() as conn:
            receiver_id = conn.execute(
                "SELECT id FROM users WHERE username = ?", (receiver["username"],)
            ).fetchone()["id"]
            game.create_notification(
                conn,
                receiver_id,
                "achievement_unlocked",
                "arrived-after-fetch",
                {"achievement": {"name": "Plus tard", "description": "", "reward": 0}},
            )

        old_ids = [item["id"] for item in receiver_data["notifications"]]
        _, read_result = self.request(
            "/api/notifications/read", auth=receiver, body={"ids": old_ids}
        )
        self.assertEqual(read_result["updated"], len(old_ids))
        self.assertEqual(read_result["unreadCount"], 1)

    def test_achievements_do_not_duplicate_and_reset_clears_notifications(self) -> None:
        user = self.create_user("player")
        with db() as conn:
            user_id = conn.execute(
                "SELECT id FROM users WHERE username = ?", (user["username"],)
            ).fetchone()["id"]
            item_id = next(iter(game.ITEMS))
            conn.execute(
                "INSERT INTO rolls (id, user_id, item_id, opened, created_at) VALUES (?, ?, ?, 1, ?)",
                ("first-roll", user_id, item_id, game.now()),
            )
            first = game.check_and_unlock_achievements(conn, user_id)
            first_count = conn.execute(
                "SELECT COUNT(*) FROM notifications WHERE user_id = ?", (user_id,)
            ).fetchone()[0]
            second = game.check_and_unlock_achievements(conn, user_id)
            second_count = conn.execute(
                "SELECT COUNT(*) FROM notifications WHERE user_id = ?", (user_id,)
            ).fetchone()[0]
        self.assertGreater(len(first), 0)
        self.assertEqual(second, [])
        self.assertEqual(second_count, first_count)

        status, _ = self.request("/api/collection/reset", auth=user, body={})
        self.assertEqual(status, 200)
        _, notifications = self.request("/api/notifications", auth=user)
        self.assertEqual(notifications["notifications"], [])
        self.assertEqual(notifications["unreadCount"], 0)

    def test_clear_notifications_is_isolated_and_idempotent(self) -> None:
        first_user = self.create_user("first-user")
        second_user = self.create_user("second-user")
        with db() as conn:
            users = {
                row["username"]: row["id"]
                for row in conn.execute("SELECT id, username FROM users").fetchall()
            }
            for source_id in ("first-one", "first-two"):
                game.create_notification(
                    conn,
                    users[first_user["username"]],
                    "achievement_unlocked",
                    source_id,
                    {"achievement": {"name": source_id, "description": "", "reward": 0}},
                )
            game.create_notification(
                conn,
                users[second_user["username"]],
                "achievement_unlocked",
                "second-one",
                {"achievement": {"name": "second-one", "description": "", "reward": 0}},
            )

        status, cleared = self.request("/api/notifications/clear", auth=first_user, body={})
        self.assertEqual(status, 200)
        self.assertEqual(cleared, {"deleted": 2, "unreadCount": 0})

        _, first_notifications = self.request("/api/notifications", auth=first_user)
        _, second_notifications = self.request("/api/notifications", auth=second_user)
        self.assertEqual(first_notifications["notifications"], [])
        self.assertEqual(len(second_notifications["notifications"]), 1)

        _, cleared_again = self.request("/api/notifications/clear", auth=first_user, body={})
        self.assertEqual(cleared_again, {"deleted": 0, "unreadCount": 0})


if __name__ == "__main__":
    unittest.main()
