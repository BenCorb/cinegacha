#!/usr/bin/env python3
"""
Serveur HTTP — routing uniquement.
Toute la logique métier est dans game.py et db.py.
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import socket
import sqlite3
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
    STARTING_CREDITS,
    STATIC_DIR,
    add_item,
    collection_for,
    collection_summary,
    inventory_count,
    item_payload,
    leaderboard,
    next_full_hour,
    now,
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

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_svg(self, body: bytes) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
                    owned = conn.execute(
                        "SELECT COUNT(*) AS total FROM inventory WHERE user_id = ? AND count > 0",
                        (user["id"],),
                    ).fetchone()["total"]
                    self.send_json({
                        "items": collection_for(conn, user["id"]),
                        "owned": owned,
                        "total": len(ITEMS),
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
                            "items": collection_for(conn, target["id"]),
                        })
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
                    credits = int(user["credits"])
                    if credits < ROLL_COST:
                        raise ApiError(HTTPStatus.PAYMENT_REQUIRED, "Credits insuffisants pour tourner la manette.")
                    item = pick_weighted_item()
                    roll_id = secrets.token_urlsafe(12)
                    new_credits = credits - ROLL_COST
                    conn.execute("UPDATE users SET credits = ? WHERE id = ?", (new_credits, user["id"]))
                    conn.execute(
                        "INSERT INTO rolls (id, user_id, item_id, opened, created_at) VALUES (?, ?, ?, 0, ?)",
                        (roll_id, user["id"], item["id"], now()),
                    )
                    user["credits"] = new_credits
                    self.send_json({
                        "rollId": roll_id,
                        "rarity": item["rarity"],
                        "capsule": CAPSULES.get(item["rarity"], CAPSULES["C"]),
                        **(user_payload(user) or {}),
                    }, HTTPStatus.CREATED)
                    return

                # --- Ouvrir une capsule ---
                if parsed.path == "/api/gacha/open":
                    roll_id = body.get("rollId", "")
                    roll = conn.execute(
                        "SELECT * FROM rolls WHERE id = ? AND user_id = ?", (roll_id, user["id"])
                    ).fetchone()
                    if not roll:
                        raise ApiError(HTTPStatus.NOT_FOUND, "Capsule introuvable.")
                    if roll["opened"]:
                        raise ApiError(HTTPStatus.CONFLICT, "Cette capsule est deja ouverte.")
                    before = inventory_count(conn, user["id"], roll["item_id"])
                    add_item(conn, user["id"], roll["item_id"], 1)
                    conn.execute("UPDATE rolls SET opened = 1 WHERE id = ?", (roll_id,))
                    self.send_json({
                        "item": item_payload(roll["item_id"], before + 1),
                        "isDuplicate": before > 0,
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
                    user["credits"] = new_credits
                    self.send_json({
                        "itemId": item_id,
                        "count": count - 1,
                        "earned": earned,
                        **(user_payload(user) or {}),
                    })
                    return

                # --- Réinitialiser la collection ---
                if parsed.path == "/api/collection/reset":
                    conn.execute("DELETE FROM inventory WHERE user_id = ?", (user["id"],))
                    conn.execute("DELETE FROM collection_state WHERE user_id = ?", (user["id"],))
                    conn.execute("DELETE FROM rolls WHERE user_id = ?", (user["id"],))
                    conn.execute(
                        "DELETE FROM trades WHERE from_user_id = ? OR to_user_id = ?",
                        (user["id"], user["id"]),
                    )
                    conn.execute("UPDATE users SET credits = ? WHERE id = ?", (STARTING_CREDITS, user["id"]))
                    self.send_json({"ok": True})
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
                    self.send_json({"itemId": item_id, "seen": bool(seen)})
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
                    state = conn.execute(
                        "SELECT favorite, watchlist FROM collection_state WHERE user_id = ? AND item_id = ?",
                        (user["id"], item_id),
                    ).fetchone()
                    self.send_json({
                        "itemId": item_id,
                        "favorite": bool(state["favorite"]),
                        "watchlist": bool(state["watchlist"]),
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
                    state = conn.execute(
                        "SELECT favorite, watchlist FROM collection_state WHERE user_id = ? AND item_id = ?",
                        (user["id"], item_id),
                    ).fetchone()
                    self.send_json({
                        "itemId": item_id,
                        "favorite": bool(state["favorite"]),
                        "watchlist": bool(state["watchlist"]),
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
                    self.send_json({"trade": trade_payload(conn, row)}, HTTPStatus.CREATED)
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
    ThreadingHTTPServer((host, port), Handler).serve_forever()
