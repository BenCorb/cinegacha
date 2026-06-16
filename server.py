#!/usr/bin/env python3
"""
Serveur HTTP — routing uniquement.
Toute la logique métier est dans game.py et db.py.
"""
from __future__ import annotations

import gzip
import hmac
import json
import os
import secrets
import socket
import sqlite3
import sys
import threading
from http import HTTPStatus
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import unquote, urlparse

from game import (
    ApiError,
    CAPSULES,
    DATA_DIR,
    DATASET,
    ITEMS,
    RARITY_WEIGHTS,
    REFILL_CAP,
    ROLL_COST,
    SELL_PRICES,
    SHOWCASE_LIMIT,
    STARTING_CREDITS,
    STATIC_DIR,
    achievements_for_user,
    add_item,
    check_and_unlock_achievements,
    collection_summary,
    inventory_count,
    item_payload,
    leaderboard,
    next_full_hour,
    now,
    owned_collection_for,
    pick_weighted_item,
    poster_svg,
    refill_user,
    trade_payload,
    user_payload,
)
from db import (
    db,
    hash_key,
    init_db,
    normalize_username,
    require_user,
    start_database_backups,
)


# ---------------------------------------------------------------------------
# Utilitaires HTTP
# ---------------------------------------------------------------------------

MAX_BODY = 64 * 1024
ROLL_COUNTS = {1, 5, 10}
RARITY_POWER = {"C": 0, "UC": 1, "R": 2, "UR": 3, "L": 4}
GZIP_MIN_BYTES = 1024
GZIP_STATIC_SUFFIXES = (".js", ".css", ".html", ".json", ".svg")


def _unlock_achievements(conn: sqlite3.Connection, user: dict) -> list[dict]:
    new_achievements = check_and_unlock_achievements(conn, user["id"])
    if new_achievements:
        user["credits"] = int(user["credits"]) + sum(a["reward"] for a in new_achievements)
    return new_achievements


def _showcase_slot(value) -> int | None:
    if value is None:
        return None
    try:
        slot = int(value)
    except (TypeError, ValueError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Emplacement de vitrine invalide.")
    if slot < 1 or slot > SHOWCASE_LIMIT:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Emplacement de vitrine invalide.")
    return slot


def _set_showcase_slot(
    conn: sqlite3.Connection,
    user_id: int,
    item_id: str,
    slot: int | None,
) -> None:
    state_row = conn.execute(
        "SELECT showcase_slot FROM collection_state WHERE user_id = ? AND item_id = ?",
        (user_id, item_id),
    ).fetchone()
    current_slot = (
        int(state_row["showcase_slot"])
        if state_row and state_row["showcase_slot"] is not None
        else None
    )

    if slot is None:
        conn.execute(
            "UPDATE collection_state SET showcase_slot = NULL WHERE user_id = ? AND item_id = ?",
            (user_id, item_id),
        )
        return

    if current_slot == slot:
        return

    target_row = conn.execute(
        "SELECT item_id FROM collection_state WHERE user_id = ? AND showcase_slot = ?",
        (user_id, slot),
    ).fetchone()

    if current_slot is None:
        showcased = conn.execute(
            "SELECT COUNT(*) AS total FROM collection_state WHERE user_id = ? AND showcase_slot IS NOT NULL",
            (user_id,),
        ).fetchone()["total"]
        if int(showcased) >= SHOWCASE_LIMIT:
            raise ApiError(HTTPStatus.CONFLICT, "Ta vitrine est deja pleine.")
        if target_row:
            raise ApiError(HTTPStatus.CONFLICT, "Cet emplacement de vitrine est deja occupe.")
        conn.execute(
            """
            INSERT INTO collection_state (user_id, item_id, showcase_slot)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id, item_id) DO UPDATE SET showcase_slot = excluded.showcase_slot
            """,
            (user_id, item_id, slot),
        )
        return

    if target_row and target_row["item_id"] != item_id:
        target_item_id = target_row["item_id"]
        conn.execute(
            "UPDATE collection_state SET showcase_slot = NULL WHERE user_id = ? AND item_id IN (?, ?)",
            (user_id, item_id, target_item_id),
        )
        conn.execute(
            "UPDATE collection_state SET showcase_slot = ? WHERE user_id = ? AND item_id = ?",
            (slot, user_id, item_id),
        )
        conn.execute(
            "UPDATE collection_state SET showcase_slot = ? WHERE user_id = ? AND item_id = ?",
            (current_slot, user_id, target_item_id),
        )
        return

    conn.execute(
        "UPDATE collection_state SET showcase_slot = ? WHERE user_id = ? AND item_id = ?",
        (slot, user_id, item_id),
    )


def read_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0"))
    if length == 0:
        return {}
    if length > MAX_BODY:
        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Corps trop volumineux.")
    try:
        return json.loads(handler.rfile.read(length).decode("utf-8"))
    except json.JSONDecodeError:
        raise ApiError(HTTPStatus.BAD_REQUEST, "JSON invalide.")


def lan_addresses(port: int) -> list[str]:
    addresses = {"127.0.0.1"}
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                addresses.add(ip)
    except OSError:
        pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if not ip.startswith("127."):
                addresses.add(ip)
    except OSError:
        pass
    return [f"http://{ip}:{port}" for ip in sorted(addresses)]


def start_terminal_commands(server: ThreadingHTTPServer) -> None:
    if not sys.stdin or not sys.stdin.isatty():
        return

    def listen() -> None:
        for line in sys.stdin:
            if line.strip().lower() == "exit":
                print("Commande exit recue, arret du serveur...")
                server.shutdown()
                return

    thread = threading.Thread(target=listen, name="terminal-commands", daemon=True)
    thread.start()


# ---------------------------------------------------------------------------
# Handler
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    server_version = "CineGacha/1.0"

    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        clean_path = unquote(parsed.path)
        if clean_path.startswith("/dataset/"):
            dataset_root = (DATA_DIR / "dataset").resolve()
            candidate = (DATA_DIR / "dataset" / clean_path.removeprefix("/dataset/")).resolve()
            if candidate.is_relative_to(dataset_root):
                return str(candidate)
            return str(STATIC_DIR / "index.html")
        if clean_path == "/":
            return str(STATIC_DIR / "index.html")
        static_root = STATIC_DIR.resolve()
        candidate = (STATIC_DIR / clean_path.removeprefix("/")).resolve()
        if candidate.is_relative_to(static_root) and candidate.exists():
            return str(candidate)
        return str(STATIC_DIR / "index.html")

    def end_headers(self) -> None:
        if self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        super().end_headers()

    def _accepts_gzip(self) -> bool:
        return "gzip" in self.headers.get("Accept-Encoding", "")

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if len(body) >= GZIP_MIN_BYTES and self._accepts_gzip():
            body = gzip.compress(body, compresslevel=6)
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_svg(self, body: bytes) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def maybe_serve_gzip_static(self) -> bool:
        """Sert un fichier texte statique compresse. Retourne True si gere ici.

        Repli (return False) -> super().do_GET() pour Range et revalidation
        conditionnelle (304), que le parent gere deja correctement.
        """
        if not self._accepts_gzip() or "Range" in self.headers:
            return False
        if self.headers.get("If-Modified-Since") or self.headers.get("If-None-Match"):
            return False
        fs_path = self.translate_path(self.path)
        if not fs_path.endswith(GZIP_STATIC_SUFFIXES):
            return False
        try:
            with open(fs_path, "rb") as handle:
                raw = handle.read()
            mtime = os.stat(fs_path).st_mtime
        except OSError:
            return False
        if len(raw) < GZIP_MIN_BYTES:
            return False
        body = gzip.compress(raw, compresslevel=6)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", self.guess_type(fs_path))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Last-Modified", self.date_time_string(int(mtime)))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return True

    # -----------------------------------------------------------------------
    # GET
    # -----------------------------------------------------------------------

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)

            if parsed.path.startswith("/api/poster/"):
                self.send_svg(poster_svg(parsed.path.rsplit("/", 1)[-1]))
                return
            if not parsed.path.startswith("/api/"):
                if self.maybe_serve_gzip_static():
                    return
                return super().do_GET()

            with db() as conn:
                if parsed.path == "/api/state":
                    user = None
                    try:
                        user = require_user(self, conn)
                    except ApiError:
                        pass
                    self.send_json({
                        "dataset": {
                            "id": DATASET["id"],
                            "name": DATASET["name"],
                            "count": len(DATASET["items"]),
                        },
                        "user": user_payload(user),
                        "dropRates": DATASET.get("dropRates", RARITY_WEIGHTS),
                    })
                    return

                user = require_user(self, conn)

                if parsed.path == "/api/collection":
                    summary = collection_summary(conn, user["id"])
                    self.send_json({
                        "items": owned_collection_for(conn, user["id"]),
                        "summary": summary,
                        "owned": summary["owned"],
                        "total": summary["total"],
                        **(user_payload(user) or {}),
                    })
                    return

                if parsed.path == "/api/users":
                    rows = conn.execute(
                        "SELECT username FROM users WHERE id != ? ORDER BY username COLLATE NOCASE",
                        (user["id"],),
                    ).fetchall()
                    self.send_json({"users": [row["username"] for row in rows]})
                    return

                if parsed.path == "/api/leaderboard":
                    self.send_json({"leaderboard": leaderboard(conn)})
                    return

                if parsed.path.startswith("/api/users/") and parsed.path.endswith("/collection"):
                    parts = parsed.path.strip("/").split("/")
                    if len(parts) == 4 and parts[1] == "users" and parts[3] == "collection":
                        username = unquote(parts[2])
                        target = conn.execute(
                            "SELECT id, username FROM users WHERE username = ?", (username,)
                        ).fetchone()
                        if not target:
                            raise ApiError(HTTPStatus.NOT_FOUND, "Joueur introuvable.")
                        self.send_json({
                            "username": target["username"],
                            "summary": collection_summary(conn, target["id"]),
                            "items": owned_collection_for(conn, target["id"]),
                        })
                        return

                if parsed.path == "/api/achievements":
                    self.send_json({"achievements": achievements_for_user(conn, user["id"])})
                    return

                if parsed.path == "/api/trades":
                    rows = conn.execute(
                        """
                        SELECT * FROM trades
                        WHERE from_user_id = ? OR to_user_id = ?
                        ORDER BY created_at DESC
                        """,
                        (user["id"], user["id"]),
                    ).fetchall()
                    self.send_json({"trades": [trade_payload(conn, row) for row in rows]})
                    return

            raise ApiError(HTTPStatus.NOT_FOUND, "Route inconnue.")
        except ApiError as e:
            self.send_json({"error": e.message}, e.status)

    # -----------------------------------------------------------------------
    # POST
    # -----------------------------------------------------------------------

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            body = read_json_body(self)

            with db() as conn:
                # --- Inscription ---
                if parsed.path == "/api/users":
                    username = normalize_username(body.get("username", ""))
                    key = "gacha-" + secrets.token_urlsafe(18)
                    ts = now()
                    try:
                        conn.execute(
                            """
                            INSERT INTO users (username, key_hash, created_at, credits, last_credit_refill_at)
                            VALUES (?, ?, ?, ?, ?)
                            """,
                            (username, hash_key(key), ts, STARTING_CREDITS, ts),
                        )
                    except sqlite3.IntegrityError:
                        raise ApiError(HTTPStatus.CONFLICT, "Ce nom est deja pris.")
                    self.send_json({
                        "username": username,
                        "connectionKey": key,
                        "credits": STARTING_CREDITS,
                        "nextCreditAt": next_full_hour(ts),
                        "refillCap": REFILL_CAP,
                        "serverNow": ts,
                    }, HTTPStatus.CREATED)
                    return

                # --- Connexion ---
                if parsed.path == "/api/session":
                    username = normalize_username(body.get("username", ""))
                    key = body.get("connectionKey", "")
                    row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
                    if not row or not hmac.compare_digest(row["key_hash"], hash_key(key)):
                        raise ApiError(HTTPStatus.UNAUTHORIZED, "Identifiants invalides.")
                    row = refill_user(conn, row["id"])
                    self.send_json(user_payload(row))
                    return

                user = require_user(self, conn)

                # --- Regénérer la clé ---
                if parsed.path == "/api/session/key":
                    key = "gacha-" + secrets.token_urlsafe(18)
                    conn.execute("UPDATE users SET key_hash = ? WHERE id = ?", (hash_key(key), user["id"]))
                    refreshed = refill_user(conn, user["id"])
                    self.send_json({"connectionKey": key, **(user_payload(refreshed) or {})})
                    return

                # --- Tourner ---
                if parsed.path == "/api/gacha/roll":
                    try:
                        roll_count = int(body.get("count", 1))
                    except (TypeError, ValueError):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Nombre de tirages invalide.")
                    if roll_count not in ROLL_COUNTS:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Nombre de tirages invalide.")
                    credits = int(user["credits"])
                    total_cost = ROLL_COST * roll_count
                    if credits < total_cost:
                        raise ApiError(HTTPStatus.PAYMENT_REQUIRED, "Credits insuffisants pour tourner la manette.")
                    items = [pick_weighted_item() for _ in range(roll_count)]
                    roll_ids = [secrets.token_urlsafe(12) for _ in range(roll_count)]
                    created_at = now()
                    new_credits = credits - total_cost
                    conn.execute("UPDATE users SET credits = ? WHERE id = ?", (new_credits, user["id"]))
                    conn.executemany(
                        "INSERT INTO rolls (id, user_id, item_id, opened, created_at) VALUES (?, ?, ?, 0, ?)",
                        [
                            (roll_id, user["id"], item["id"], created_at)
                            for roll_id, item in zip(roll_ids, items)
                        ],
                    )
                    top_item = max(items, key=lambda item: RARITY_POWER.get(item["rarity"], 0))
                    user["credits"] = new_credits
                    new_ach = _unlock_achievements(conn, user)
                    self.send_json({
                        "rollId": roll_ids[0],
                        "rollIds": roll_ids,
                        "count": roll_count,
                        "rarity": top_item["rarity"],
                        "capsule": CAPSULES.get(top_item["rarity"], CAPSULES["C"]),
                        "newAchievements": new_ach,
                        **(user_payload(user) or {}),
                    }, HTTPStatus.CREATED)
                    return

                # --- Ouvrir une capsule ---
                if parsed.path == "/api/gacha/open":
                    body_roll_ids = body.get("rollIds")
                    if isinstance(body_roll_ids, list):
                        roll_ids = [str(roll_id) for roll_id in body_roll_ids if str(roll_id)]
                    else:
                        roll_id = body.get("rollId", "")
                        roll_ids = [str(roll_id)] if roll_id else []
                    if len(roll_ids) not in ROLL_COUNTS or len(set(roll_ids)) != len(roll_ids):
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Capsule invalide.")

                    placeholders = ",".join("?" for _ in roll_ids)
                    rows = conn.execute(
                        f"SELECT * FROM rolls WHERE id IN ({placeholders}) AND user_id = ?",
                        (*roll_ids, user["id"]),
                    ).fetchall()
                    if len(rows) != len(roll_ids):
                        raise ApiError(HTTPStatus.NOT_FOUND, "Capsule introuvable.")
                    rows_by_id = {row["id"]: row for row in rows}
                    rolls = [rows_by_id[roll_id] for roll_id in roll_ids]
                    if any(roll["opened"] for roll in rolls):
                        raise ApiError(HTTPStatus.CONFLICT, "Cette capsule est deja ouverte.")
                    results = []
                    for roll in rolls:
                        before = inventory_count(conn, user["id"], roll["item_id"])
                        add_item(conn, user["id"], roll["item_id"], 1)
                        results.append({
                            "item": item_payload(roll["item_id"], before + 1),
                            "isDuplicate": before > 0,
                        })
                    conn.execute(
                        f"UPDATE rolls SET opened = 1 WHERE id IN ({placeholders})",
                        tuple(roll_ids),
                    )
                    new_ach = _unlock_achievements(conn, user)
                    self.send_json({
                        "items": results,
                        "item": results[0]["item"],
                        "isDuplicate": results[0]["isDuplicate"],
                        "newAchievements": new_ach,
                        **(user_payload(user) or {}),
                    })
                    return

                # --- Vendre un doublon ---
                if parsed.path == "/api/collection/sell":
                    item_id = body.get("itemId")
                    if item_id not in ITEMS:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Film inconnu.")
                    count = inventory_count(conn, user["id"], item_id)
                    if count < 2:
                        raise ApiError(HTTPStatus.CONFLICT, "Tu peux vendre seulement une carte en double.")
                    earned = SELL_PRICES.get(ITEMS[item_id]["rarity"], 0)
                    add_item(conn, user["id"], item_id, -1)
                    new_credits = int(user["credits"]) + earned
                    conn.execute("UPDATE users SET credits = ? WHERE id = ?", (new_credits, user["id"]))
                    conn.execute("UPDATE users SET total_sells = total_sells + 1 WHERE id = ?", (user["id"],))
                    user["credits"] = new_credits
                    new_ach = _unlock_achievements(conn, user)
                    self.send_json({
                        "itemId": item_id,
                        "count": count - 1,
                        "earned": earned,
                        "newAchievements": new_ach,
                        **(user_payload(user) or {}),
                    })
                    return

                # --- Réinitialiser la collection ---
                if parsed.path == "/api/collection/reset":
                    ts = now()
                    conn.execute("DELETE FROM inventory WHERE user_id = ?", (user["id"],))
                    conn.execute("DELETE FROM collection_state WHERE user_id = ?", (user["id"],))
                    conn.execute("DELETE FROM rolls WHERE user_id = ?", (user["id"],))
                    conn.execute("DELETE FROM user_achievements WHERE user_id = ?", (user["id"],))
                    conn.execute(
                        "DELETE FROM trades WHERE from_user_id = ? OR to_user_id = ?",
                        (user["id"], user["id"]),
                    )
                    conn.execute(
                        """
                        UPDATE users
                        SET credits = ?, last_credit_refill_at = ?, total_sells = 0
                        WHERE id = ?
                        """,
                        (STARTING_CREDITS, ts, user["id"]),
                    )
                    user["credits"] = STARTING_CREDITS
                    user["last_credit_refill_at"] = ts
                    user["total_sells"] = 0
                    self.send_json({"ok": True, **(user_payload(user) or {})})
                    return

                # --- Marquer comme vu ---
                if parsed.path == "/api/collection/seen":
                    item_id = body.get("itemId")
                    if item_id not in ITEMS:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Film inconnu.")
                    if inventory_count(conn, user["id"], item_id) < 1:
                        raise ApiError(HTTPStatus.CONFLICT, "Tu dois obtenir ce film avant de le marquer comme vu.")
                    seen = 1 if body.get("seen") else 0
                    conn.execute(
                        """
                        INSERT INTO collection_state (user_id, item_id, seen)
                        VALUES (?, ?, ?)
                        ON CONFLICT(user_id, item_id) DO UPDATE SET seen = excluded.seen
                        """,
                        (user["id"], item_id, seen),
                    )
                    new_ach = _unlock_achievements(conn, user)
                    self.send_json({"itemId": item_id, "seen": bool(seen), "newAchievements": new_ach})
                    return

                # --- Vitrine ---
                if parsed.path == "/api/collection/showcase":
                    item_id = body.get("itemId")
                    if item_id not in ITEMS:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Film inconnu.")
                    if "slot" not in body:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Emplacement de vitrine manquant.")
                    slot = _showcase_slot(body.get("slot"))
                    if slot is not None and inventory_count(conn, user["id"], item_id) < 1:
                        raise ApiError(HTTPStatus.CONFLICT, "Tu dois obtenir ce film avant de le mettre en vitrine.")
                    _set_showcase_slot(conn, user["id"], item_id, slot)
                    new_ach = _unlock_achievements(conn, user)
                    self.send_json({
                        "itemId": item_id,
                        "showcaseSlot": slot,
                        "items": owned_collection_for(conn, user["id"]),
                        "newAchievements": new_ach,
                        **(user_payload(user) or {}),
                    })
                    return

                # --- Favori ---
                if parsed.path == "/api/collection/favorite":
                    item_id = body.get("itemId")
                    if item_id not in ITEMS:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Film inconnu.")
                    if inventory_count(conn, user["id"], item_id) < 1:
                        raise ApiError(HTTPStatus.CONFLICT, "Tu dois obtenir ce film avant de le mettre en favori.")
                    favorite = 1 if body.get("favorite") else 0
                    conn.execute(
                        """
                        INSERT INTO collection_state (user_id, item_id, favorite, watchlist)
                        VALUES (?, ?, ?, 0)
                        ON CONFLICT(user_id, item_id) DO UPDATE SET
                            favorite = excluded.favorite,
                            watchlist = CASE WHEN excluded.favorite = 1 THEN 0 ELSE collection_state.watchlist END
                        """,
                        (user["id"], item_id, favorite),
                    )
                    cs = conn.execute(
                        "SELECT favorite, watchlist FROM collection_state WHERE user_id = ? AND item_id = ?",
                        (user["id"], item_id),
                    ).fetchone()
                    new_ach = _unlock_achievements(conn, user)
                    self.send_json({
                        "itemId": item_id,
                        "favorite": bool(cs["favorite"]),
                        "watchlist": bool(cs["watchlist"]),
                        "newAchievements": new_ach,
                    })
                    return

                # --- Watchlist ---
                if parsed.path == "/api/collection/watchlist":
                    item_id = body.get("itemId")
                    if item_id not in ITEMS:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Film inconnu.")
                    if inventory_count(conn, user["id"], item_id) < 1:
                        raise ApiError(HTTPStatus.CONFLICT, "Tu dois obtenir ce film avant de le mettre en watchlist.")
                    watchlist = 1 if body.get("watchlist") else 0
                    conn.execute(
                        """
                        INSERT INTO collection_state (user_id, item_id, watchlist, favorite)
                        VALUES (?, ?, ?, 0)
                        ON CONFLICT(user_id, item_id) DO UPDATE SET
                            watchlist = excluded.watchlist,
                            favorite = CASE WHEN excluded.watchlist = 1 THEN 0 ELSE collection_state.favorite END
                        """,
                        (user["id"], item_id, watchlist),
                    )
                    cs = conn.execute(
                        "SELECT favorite, watchlist FROM collection_state WHERE user_id = ? AND item_id = ?",
                        (user["id"], item_id),
                    ).fetchone()
                    new_ach = _unlock_achievements(conn, user)
                    self.send_json({
                        "itemId": item_id,
                        "favorite": bool(cs["favorite"]),
                        "watchlist": bool(cs["watchlist"]),
                        "newAchievements": new_ach,
                    })
                    return

                # --- Envoyer une carte ---
                if parsed.path == "/api/trades":
                    to_username = normalize_username(body.get("toUsername", ""))
                    offer_item_id = body.get("offerItemId")
                    if offer_item_id not in ITEMS:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Film inconnu.")
                    to_user = conn.execute(
                        "SELECT * FROM users WHERE username = ?", (to_username,)
                    ).fetchone()
                    if not to_user or to_user["id"] == user["id"]:
                        raise ApiError(HTTPStatus.BAD_REQUEST, "Destinataire invalide.")
                    if inventory_count(conn, user["id"], offer_item_id) < 2:
                        raise ApiError(HTTPStatus.CONFLICT, "Tu peux envoyer seulement une carte en double.")
                    trade_id = secrets.token_urlsafe(10)
                    add_item(conn, user["id"], offer_item_id, -1)
                    add_item(conn, to_user["id"], offer_item_id, 1)
                    conn.execute(
                        """
                        INSERT INTO trades (id, from_user_id, to_user_id, offer_item_id, request_item_id, status, created_at)
                        VALUES (?, ?, ?, ?, ?, 'sent', ?)
                        """,
                        (trade_id, user["id"], to_user["id"], offer_item_id, offer_item_id, now()),
                    )
                    row = conn.execute("SELECT * FROM trades WHERE id = ?", (trade_id,)).fetchone()
                    new_ach = _unlock_achievements(conn, user)
                    # Le destinataire ne fait pas d'action ici : on verifie ses succes pour
                    # debloquer "Cadeau surprise" et tout succes declenche par la carte recue
                    # (collection, max_copies...). Credits/deblocage cote serveur, visibles a
                    # son prochain rafraichissement.
                    check_and_unlock_achievements(conn, to_user["id"])
                    self.send_json({
                        "trade": trade_payload(conn, row),
                        "newAchievements": new_ach,
                    }, HTTPStatus.CREATED)
                    return

            raise ApiError(HTTPStatus.NOT_FOUND, "Route inconnue.")
        except ApiError as e:
            self.send_json({"error": e.message}, e.status)


# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    init_db()
    start_database_backups()
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "0.0.0.0")
    print(f"CinéGacha écoute sur {host}:{port}")
    for url in lan_addresses(port):
        print(f"  {url}")
    with ThreadingHTTPServer((host, port), Handler) as server:
        start_terminal_commands(server)
        if sys.stdin and sys.stdin.isatty():
            print("Tape 'exit' puis Entrée pour arrêter le serveur.")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nArret du serveur...")
