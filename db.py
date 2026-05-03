#!/usr/bin/env python3
"""
Connexion SQLite, initialisation du schéma et helpers d'authentification.
Importe depuis game.py — pas de dépendances HTTP.
"""
from __future__ import annotations

import hashlib
import hmac
import sqlite3
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler

from game import (
    ApiError,
    DATA_DIR,
    DB_PATH,
    STARTING_CREDITS,
    now,
    refill_user,
)


# ---------------------------------------------------------------------------
# Connexion
# ---------------------------------------------------------------------------

def db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


# ---------------------------------------------------------------------------
# Schéma & migrations additives
# ---------------------------------------------------------------------------

def init_db() -> None:
    ts = now()
    with db() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                key_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS inventory (
                user_id INTEGER NOT NULL,
                item_id TEXT NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, item_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS rolls (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                item_id TEXT NOT NULL,
                opened INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS trades (
                id TEXT PRIMARY KEY,
                from_user_id INTEGER NOT NULL,
                to_user_id INTEGER NOT NULL,
                offer_item_id TEXT NOT NULL,
                request_item_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at INTEGER NOT NULL,
                resolved_at INTEGER,
                FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS collection_state (
                user_id INTEGER NOT NULL,
                item_id TEXT NOT NULL,
                seen INTEGER NOT NULL DEFAULT 0,
                favorite INTEGER NOT NULL DEFAULT 0,
                watchlist INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, item_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """
        )
        # Migrations additives — safe sur une DB existante
        user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "credits" not in user_cols:
            conn.execute(
                f"ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT {STARTING_CREDITS}"
            )
        if "last_credit_refill_at" not in user_cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN last_credit_refill_at INTEGER NOT NULL DEFAULT 0"
            )
            conn.execute(
                "UPDATE users SET credits = ?, last_credit_refill_at = ? WHERE last_credit_refill_at = 0",
                (STARTING_CREDITS, ts),
            )
        cs_cols = {r["name"] for r in conn.execute("PRAGMA table_info(collection_state)").fetchall()}
        if "favorite" not in cs_cols:
            conn.execute(
                "ALTER TABLE collection_state ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0"
            )
        if "watchlist" not in cs_cols:
            conn.execute(
                "ALTER TABLE collection_state ADD COLUMN watchlist INTEGER NOT NULL DEFAULT 0"
            )


# ---------------------------------------------------------------------------
# Authentification
# ---------------------------------------------------------------------------

def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def normalize_username(username: str) -> str:
    username = (username or "").strip()
    if not 3 <= len(username) <= 24:
        raise ApiError(HTTPStatus.BAD_REQUEST, "Le nom doit contenir entre 3 et 24 caracteres.")
    if not all(c.isalnum() or c in "_-" for c in username):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Utilise seulement lettres, chiffres, _ ou -.")
    return username


def require_user(handler: SimpleHTTPRequestHandler, conn: sqlite3.Connection) -> sqlite3.Row:
    username = handler.headers.get("X-Username", "")
    key = handler.headers.get("X-Connection-Key", "")
    if not username or not key:
        raise ApiError(HTTPStatus.UNAUTHORIZED, "Connexion requise.")
    row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    if not row or not hmac.compare_digest(row["key_hash"], hash_key(key)):
        raise ApiError(HTTPStatus.UNAUTHORIZED, "Identifiants invalides.")
    return refill_user(conn, row["id"])
