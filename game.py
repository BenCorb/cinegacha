#!/usr/bin/env python3
"""
Constantes, dataset et logique métier du jeu.
Pas de dépendances internes — peut être importé par db.py et server.py.
"""
from __future__ import annotations

import functools
import json
import os
import random
import secrets
import sqlite3
import time
from http import HTTPStatus
from pathlib import Path


# ---------------------------------------------------------------------------
# Chemins
# ---------------------------------------------------------------------------

ROOT = Path(__file__).parent.resolve()
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
DATASET_DIR = DATA_DIR / os.environ.get("GACHA_DATASET_DIR", "dataset")
DATASET_PATH = DATASET_DIR / "dataset.json"
DB_PATH = Path(os.environ.get("GACHA_DB", DATA_DIR / "gachapon.sqlite"))


# ---------------------------------------------------------------------------
# Constantes du jeu
# ---------------------------------------------------------------------------

RARITY_WEIGHTS: dict[str, int] = {"C": 55, "UC": 28, "R": 12, "UR": 4, "L": 1}
STARTING_CREDITS = 2000
ROLL_COST = 100
HOURLY_REFILL = 100
REFILL_CAP = 5000
SELL_PRICES: dict[str, int] = {"C": 20, "UC": 30, "R": 50, "UR": 100, "L": 150}
CAPSULES: dict[str, dict] = {
    "C":  {"name": "Capsule argent",  "color": "#cfd6df"},
    "UC": {"name": "Capsule menthe",  "color": "#74d99f"},
    "R":  {"name": "Capsule soda",    "color": "#55c7f5"},
    "UR": {"name": "Capsule violette","color": "#c8a8ff"},
    "L":  {"name": "Capsule citron",  "color": "#ffd84f"},
}


# ---------------------------------------------------------------------------
# Erreur API
# ---------------------------------------------------------------------------

class ApiError(Exception):
    def __init__(self, status: HTTPStatus, message: str):
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

def load_dataset() -> dict:
    with DATASET_PATH.open("r", encoding="utf-8") as f:
        dataset = json.load(f)
    dataset.setdefault("dropRates", RARITY_WEIGHTS)
    return dataset


DATASET = load_dataset()
ITEMS: dict[str, dict] = {item["id"]: item for item in DATASET["items"]}


# ---------------------------------------------------------------------------
# Utilitaires temporels
# ---------------------------------------------------------------------------

def now() -> int:
    return int(time.time())


def hour_floor(ts: int) -> int:
    return ts - (ts % 3600)


def next_full_hour(ts: int) -> int:
    base = hour_floor(ts)
    return base + 3600 if ts > base else base


# ---------------------------------------------------------------------------
# Logique de tirage
# ---------------------------------------------------------------------------

def pick_weighted_item() -> dict:
    rates = DATASET.get("dropRates", RARITY_WEIGHTS)
    rarity = random.choices(list(rates.keys()), weights=list(rates.values()), k=1)[0]
    pool = [item for item in DATASET["items"] if item["rarity"] == rarity]
    if not pool:
        pool = DATASET["items"]
    return secrets.choice(pool)


@functools.lru_cache(maxsize=None)
def poster_svg(item_id: str) -> bytes:
    item = ITEMS.get(item_id)
    rarity = (item or {"rarity": "C"})["rarity"]
    palette = {
        "C":  ("#d9dee6", "#9ca8b6"),
        "UC": ("#b7f0c8", "#54b978"),
        "R":  ("#abe4ff", "#3aa8d7"),
        "UR": ("#d8c2ff", "#9a72df"),
        "L":  ("#ffe779", "#e1ac21"),
    }.get(rarity, ("#d9dee6", "#9ca8b6"))
    return f"""
    <svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
      <rect width="300" height="450" rx="18" fill="#fffaf2"/>
      <rect x="18" y="18" width="264" height="414" rx="14" fill="{palette[0]}" stroke="#263249" stroke-width="5"/>
      <rect x="34" y="36" width="232" height="378" rx="10" fill="#ffffff" opacity=".18"/>
      <circle cx="96" cy="118" r="58" fill="#ffffff" opacity=".55"/>
      <circle cx="202" cy="144" r="82" fill="{palette[1]}" opacity=".34"/>
      <circle cx="226" cy="66" r="18" fill="#ffffff" opacity=".42"/>
      <path d="M38 194 C86 145 126 228 176 184 C218 148 244 184 262 166 L262 414 L38 414 Z" fill="#fff" opacity=".46"/>
      <path d="M56 338 C96 296 134 360 175 324 C214 290 240 316 252 300 L252 414 L56 414 Z" fill="{palette[1]}" opacity=".2"/>
      <path d="M68 394 L232 394" stroke="#263249" stroke-width="5" stroke-linecap="round" opacity=".16"/>
    </svg>
    """.encode("utf-8")


# ---------------------------------------------------------------------------
# Requêtes inventaire (opérations atomiques)
# ---------------------------------------------------------------------------

def inventory_count(conn: sqlite3.Connection, user_id: int, item_id: str) -> int:
    row = conn.execute(
        "SELECT count FROM inventory WHERE user_id = ? AND item_id = ?", (user_id, item_id)
    ).fetchone()
    return int(row["count"]) if row else 0


def add_item(conn: sqlite3.Connection, user_id: int, item_id: str, delta: int) -> None:
    current = inventory_count(conn, user_id, item_id)
    next_count = current + delta
    if next_count < 0:
        raise ApiError(HTTPStatus.CONFLICT, "Inventaire insuffisant.")
    conn.execute(
        """
        INSERT INTO inventory (user_id, item_id, count) VALUES (?, ?, ?)
        ON CONFLICT(user_id, item_id) DO UPDATE SET count = excluded.count
        """,
        (user_id, item_id, next_count),
    )


def user_credits(conn: sqlite3.Connection, user_id: int) -> int:
    return int(
        conn.execute("SELECT credits FROM users WHERE id = ?", (user_id,)).fetchone()["credits"]
    )


# ---------------------------------------------------------------------------
# Crédits & recharge horaire
# ---------------------------------------------------------------------------

def refill_user(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise ApiError(HTTPStatus.UNAUTHORIZED, "Connexion requise.")
    ts = now()
    credits = int(row["credits"])
    last_refill = int(row["last_credit_refill_at"] or row["created_at"] or ts)
    if last_refill <= 0:
        last_refill = ts
    elapsed_hours = max(0, (hour_floor(ts) - hour_floor(last_refill)) // 3600)
    if elapsed_hours:
        if credits >= REFILL_CAP:
            next_credits, next_refill = credits, hour_floor(ts)
        else:
            next_credits = min(REFILL_CAP, credits + elapsed_hours * HOURLY_REFILL)
            next_refill = hour_floor(ts)
        conn.execute(
            "UPDATE users SET credits = ?, last_credit_refill_at = ? WHERE id = ?",
            (next_credits, next_refill, user_id),
        )
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return row


# ---------------------------------------------------------------------------
# Payloads JSON
# ---------------------------------------------------------------------------

def user_payload(user: sqlite3.Row | None) -> dict | None:
    if not user:
        return None
    credits = int(user["credits"])
    ts = now()
    return {
        "username": user["username"],
        "credits": credits,
        "nextCreditAt": None if credits >= REFILL_CAP else next_full_hour(ts),
        "refillCap": REFILL_CAP,
        "serverNow": ts,
    }


def credit_payload(conn: sqlite3.Connection, user_id: int) -> dict:
    return user_payload(
        conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    ) or {}


def item_payload(item_id: str, count: int | None = None, hidden: bool = False) -> dict:
    item = ITEMS[item_id]
    if hidden:
        return {
            "id": item_id, "name": "???", "rarity": item["rarity"],
            "image": "", "owned": False, "count": 0, "seen": False,
        }
    payload = dict(item)
    if count is not None:
        payload["count"] = count
        payload["owned"] = count > 0
    return payload


def trade_payload(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    from_user = conn.execute("SELECT username FROM users WHERE id = ?", (row["from_user_id"],)).fetchone()
    to_user   = conn.execute("SELECT username FROM users WHERE id = ?", (row["to_user_id"],)).fetchone()
    return {
        "id":        row["id"],
        "fromUser":  from_user["username"],
        "toUser":    to_user["username"],
        "offer":     item_payload(row["offer_item_id"]),
        "status":    row["status"],
        "createdAt": row["created_at"],
    }


# ---------------------------------------------------------------------------
# Collection
# ---------------------------------------------------------------------------

def collection_for(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT item_id, count FROM inventory WHERE user_id = ?", (user_id,)
    ).fetchall()
    counts = {row["item_id"]: row["count"] for row in rows}

    seen_rows = conn.execute(
        "SELECT item_id, seen, favorite, watchlist FROM collection_state WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    seen      = {r["item_id"]: bool(r["seen"])      for r in seen_rows}
    favorites = {r["item_id"]: bool(r["favorite"])  for r in seen_rows}
    watchlist = {r["item_id"]: bool(r["watchlist"]) for r in seen_rows}

    payload = []
    for item in DATASET["items"]:
        count = counts.get(item["id"], 0)
        entry = item_payload(item["id"], count, hidden=count == 0)
        entry["seen"]      = bool(seen.get(item["id"], False))
        entry["favorite"]  = bool(favorites.get(item["id"], False)) and count > 0
        entry["watchlist"] = (
            bool(watchlist.get(item["id"], False)) and count > 0 and not entry["favorite"]
        )
        payload.append(entry)
    return payload


def collection_summary(conn: sqlite3.Connection, user_id: int) -> dict:
    rows = conn.execute(
        "SELECT item_id, count FROM inventory WHERE user_id = ? AND count > 0", (user_id,)
    ).fetchall()
    owned_ids = {row["item_id"] for row in rows}

    seen_rows = conn.execute(
        "SELECT item_id, seen, favorite, watchlist FROM collection_state WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    seen_ids      = {r["item_id"] for r in seen_rows if r["seen"]      and r["item_id"] in owned_ids}
    favorite_ids  = {r["item_id"] for r in seen_rows if r["favorite"]  and r["item_id"] in owned_ids}
    watchlist_ids = {r["item_id"] for r in seen_rows if r["watchlist"] and r["item_id"] in owned_ids}

    by_rarity = {rarity: {"owned": 0, "total": 0} for rarity in RARITY_WEIGHTS}
    for item in DATASET["items"]:
        rarity = item["rarity"]
        by_rarity.setdefault(rarity, {"owned": 0, "total": 0})
        by_rarity[rarity]["total"] += 1
        if item["id"] in owned_ids:
            by_rarity[rarity]["owned"] += 1

    total = len(DATASET["items"])
    owned = len(owned_ids)
    return {
        "owned":    owned,
        "total":    total,
        "percent":  round((owned / total) * 100, 1) if total else 0,
        "seen":     len(seen_ids),
        "favorites":len(favorite_ids),
        "watchlist":len(watchlist_ids),
        "byRarity": by_rarity,
    }


def leaderboard(conn: sqlite3.Connection) -> list[dict]:
    total = len(DATASET["items"])
    rows = conn.execute(
        """
        SELECT
            u.username,
            COUNT(DISTINCT i.item_id) AS owned,
            COUNT(DISTINCT CASE WHEN cs.seen      = 1 THEN cs.item_id END) AS seen,
            COUNT(DISTINCT CASE WHEN cs.favorite  = 1 THEN cs.item_id END) AS favorites,
            COUNT(DISTINCT CASE WHEN cs.watchlist = 1 AND cs.favorite = 0 THEN cs.item_id END) AS watchlist
        FROM users u
        LEFT JOIN inventory       i  ON i.user_id  = u.id AND i.count > 0
        LEFT JOIN collection_state cs ON cs.user_id = u.id AND cs.item_id = i.item_id
        GROUP BY u.id, u.username
        """,
    ).fetchall()
    entries = []
    for row in rows:
        owned   = row["owned"]
        percent = round((owned / total) * 100, 1) if total else 0
        entries.append({
            "username":  row["username"],
            "owned":     owned,
            "total":     total,
            "percent":   percent,
            "seen":      row["seen"],
            "favorites": row["favorites"],
            "watchlist": row["watchlist"],
        })
    return sorted(entries, key=lambda e: (-e["owned"], -e["seen"], e["username"].lower()))
