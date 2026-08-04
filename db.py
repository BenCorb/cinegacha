#!/usr/bin/env python3
"""
Connexion SQLite, initialisation du schéma et helpers d'authentification.
Importe depuis game.py — pas de dépendances HTTP.
"""
from __future__ import annotations

import contextlib
import hashlib
import hmac
import sqlite3
import threading
import time
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from queue import Empty, Full, Queue

from game import (
    ApiError,
    DATA_DIR,
    DB_PATH,
    SHOWCASE_LIMIT,
    STARTING_CREDITS,
    now,
    refill_user,
)

BACKUP_DIR = DATA_DIR / "backups"
BACKUP_KEEP = 24
BACKUP_INTERVAL_SECONDS = 60 * 60
BACKUP_OFFSET_SECONDS = 45 * 60


# ---------------------------------------------------------------------------
# Connexion (pool borne, reutilisee entre requetes)
# ---------------------------------------------------------------------------

_POOL_SIZE = 8
_pool: "Queue[sqlite3.Connection]" = Queue(maxsize=_POOL_SIZE)


def _new_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


@contextlib.contextmanager
def db():
    """Connexion SQLite empruntee a un pool borne.

    Reprend la semantique transactionnelle de sqlite3 (commit en sortie normale,
    rollback sur exception) mais recycle la connexion au lieu de la rouvrir + PRAGMA
    a chaque requete. `check_same_thread=False` est sûr : le pool garantit qu'une
    connexion n'est detenue que par un seul thread a la fois.
    """
    try:
        conn = _pool.get_nowait()
    except Empty:
        conn = _new_connection()
    try:
        yield conn
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        try:
            _pool.put_nowait(conn)
        except Full:
            conn.close()


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
                created_at INTEGER NOT NULL,
                letterboxd_username TEXT
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
                showcase_slot INTEGER,
                PRIMARY KEY (user_id, item_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                actor_user_id INTEGER,
                payload_json TEXT NOT NULL DEFAULT '{}',
                read_at INTEGER,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE (user_id, type, source_id)
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
        if "letterboxd_username" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN letterboxd_username TEXT")
        cs_cols = {r["name"] for r in conn.execute("PRAGMA table_info(collection_state)").fetchall()}
        if "favorite" not in cs_cols:
            conn.execute(
                "ALTER TABLE collection_state ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0"
            )
        if "watchlist" not in cs_cols:
            conn.execute(
                "ALTER TABLE collection_state ADD COLUMN watchlist INTEGER NOT NULL DEFAULT 0"
            )
        if "showcase_slot" not in cs_cols:
            conn.execute("ALTER TABLE collection_state ADD COLUMN showcase_slot INTEGER")
        conn.execute(
            """
            UPDATE collection_state
            SET showcase_slot = NULL
            WHERE showcase_slot IS NOT NULL
              AND (showcase_slot < 1 OR showcase_slot > ?)
            """,
            (SHOWCASE_LIMIT,),
        )
        conn.execute(
            """
            UPDATE collection_state
            SET showcase_slot = NULL
            WHERE showcase_slot IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM inventory
                WHERE inventory.user_id = collection_state.user_id
                  AND inventory.item_id = collection_state.item_id
                  AND inventory.count > 0
              )
            """
        )
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS user_achievements (
                user_id        INTEGER NOT NULL,
                achievement_id TEXT    NOT NULL,
                unlocked_at    INTEGER NOT NULL,
                PRIMARY KEY (user_id, achievement_id),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_inventory_user   ON inventory(user_id);
            CREATE INDEX IF NOT EXISTS idx_rolls_user       ON rolls(user_id);
            CREATE INDEX IF NOT EXISTS idx_trades_from      ON trades(from_user_id);
            CREATE INDEX IF NOT EXISTS idx_trades_to        ON trades(to_user_id);
            CREATE INDEX IF NOT EXISTS idx_cstate_user      ON collection_state(user_id);
            CREATE INDEX IF NOT EXISTS idx_achievements_user ON user_achievements(user_id);
            CREATE INDEX IF NOT EXISTS idx_notifications_user_created
                ON notifications(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
                ON notifications(user_id, created_at DESC)
                WHERE read_at IS NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_cstate_showcase_slot
                ON collection_state(user_id, showcase_slot)
                WHERE showcase_slot IS NOT NULL;
            """
        )
        if "total_sells" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN total_sells INTEGER NOT NULL DEFAULT 0")


# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------

def backup_database() -> Path:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H")
    backup_path = BACKUP_DIR / f"gachapon-{stamp}.sqlite"
    tmp_path = backup_path.with_suffix(".sqlite.tmp")

    with sqlite3.connect(DB_PATH) as source, sqlite3.connect(tmp_path) as target:
        source.backup(target)
    tmp_path.replace(backup_path)
    prune_database_backups()
    return backup_path


def prune_database_backups(keep: int = BACKUP_KEEP) -> None:
    backups = sorted(BACKUP_DIR.glob("gachapon-*.sqlite"), key=lambda path: path.name)
    for backup in backups[:-keep]:
        backup.unlink(missing_ok=True)


def seconds_until_next_backup() -> int:
    now_seconds = int(time.time())
    elapsed_this_hour = now_seconds % BACKUP_INTERVAL_SECONDS
    delay = BACKUP_OFFSET_SECONDS - elapsed_this_hour
    if delay <= 0:
        delay += BACKUP_INTERVAL_SECONDS
    return delay


def backup_loop() -> None:
    while True:
        time.sleep(seconds_until_next_backup())
        try:
            backup_path = backup_database()
            print(f"Backup SQLite cree: {backup_path}")
        except Exception as exc:
            print(f"Backup SQLite impossible: {exc}")


def start_database_backups() -> None:
    try:
        backup_path = backup_database()
        print(f"Backup SQLite cree: {backup_path}")
    except Exception as exc:
        print(f"Backup SQLite impossible: {exc}")
    thread = threading.Thread(target=backup_loop, name="sqlite-backups", daemon=True)
    thread.start()


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
