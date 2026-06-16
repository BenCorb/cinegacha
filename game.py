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

_POOLS_BY_RARITY: dict[str, list[dict]] = {}
_RARITY_ITEM_IDS: dict[str, list[str]] = {}
for _item in DATASET["items"]:
    _POOLS_BY_RARITY.setdefault(_item["rarity"], []).append(_item)
    _RARITY_ITEM_IDS.setdefault(_item["rarity"], []).append(_item["id"])


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
    pool = _POOLS_BY_RARITY.get(rarity) or DATASET["items"]
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
    if delta > 0:
        conn.execute(
            """
            INSERT INTO inventory (user_id, item_id, count) VALUES (?, ?, ?)
            ON CONFLICT(user_id, item_id) DO UPDATE SET count = count + excluded.count
            """,
            (user_id, item_id, delta),
        )
    else:
        rows = conn.execute(
            "UPDATE inventory SET count = count + ? WHERE user_id = ? AND item_id = ? AND count + ? >= 0",
            (delta, user_id, item_id, delta),
        ).rowcount
        if rows == 0:
            raise ApiError(HTTPStatus.CONFLICT, "Inventaire insuffisant.")


def user_credits(conn: sqlite3.Connection, user_id: int) -> int:
    return int(
        conn.execute("SELECT credits FROM users WHERE id = ?", (user_id,)).fetchone()["credits"]
    )


# ---------------------------------------------------------------------------
# Crédits & recharge horaire
# ---------------------------------------------------------------------------

def refill_user(conn: sqlite3.Connection, user_id: int) -> dict:
    row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise ApiError(HTTPStatus.UNAUTHORIZED, "Connexion requise.")
    data = dict(row)
    ts = now()
    credits = data["credits"]
    last_refill = int(data["last_credit_refill_at"] or data["created_at"] or ts)
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
        data["credits"] = next_credits
        data["last_credit_refill_at"] = next_refill
    return data


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


# ---------------------------------------------------------------------------
# Achievements
# ---------------------------------------------------------------------------

ACHIEVEMENTS: dict[str, dict] = {
    "first_roll":      {"name": "Premier tour",       "description": "Faire son premier tirage",            "reward": 20,  "category": "Tirages"},
    "rolls_10":        {"name": "Accro",              "description": "Effectuer 10 tirages",                "reward": 30,  "category": "Tirages"},
    "rolls_50":        {"name": "Régulier",           "description": "Effectuer 50 tirages",                "reward": 50,  "category": "Tirages"},
    "rolls_200":       {"name": "Obsessionnel",       "description": "Effectuer 200 tirages",               "reward": 150, "category": "Tirages"},
    "collection_10":   {"name": "Débutant",           "description": "Obtenir 10 cartes différentes",       "reward": 20,  "category": "Collection"},
    "collection_50":   {"name": "Cinéphile",          "description": "Obtenir 50 cartes différentes",       "reward": 50,  "category": "Collection"},
    "collection_100":  {"name": "Collectionneur",     "description": "Obtenir 100 cartes différentes",      "reward": 100, "category": "Collection"},
    "collection_full": {"name": "Encyclopédiste",     "description": "Compléter toute la collection",       "reward": 500, "category": "Collection"},
    "first_R":         {"name": "Coup de chance",     "description": "Obtenir sa première carte R",         "reward": 20,  "category": "Raretés"},
    "first_UR":        {"name": "Ultra-rare",         "description": "Obtenir sa première carte UR",        "reward": 50,  "category": "Raretés"},
    "first_L":         {"name": "Légendaire",         "description": "Obtenir sa première carte L",         "reward": 100, "category": "Raretés"},
    "first_seen":      {"name": "Premier film",       "description": "Marquer un premier film comme vu",    "reward": 10,  "category": "Films vus"},
    "seen_25":         {"name": "Cinéphile confirmé", "description": "Marquer 25 films comme vus",          "reward": 30,  "category": "Films vus"},
    "seen_50":         {"name": "Critique",           "description": "Marquer 50 films comme vus",          "reward": 50,  "category": "Films vus"},
    "first_trade":     {"name": "Généreux",           "description": "Envoyer une première carte",          "reward": 20,  "category": "Échanges"},
    "trades_5":        {"name": "Commerçant",         "description": "Envoyer 5 cartes",                    "reward": 40,  "category": "Échanges"},
    "first_sell":      {"name": "Première vente",     "description": "Vendre une première carte en double", "reward": 10,  "category": "Ventes"},
    "sells_10":        {"name": "Liquidateur",        "description": "Vendre 10 cartes en double",          "reward": 30,  "category": "Ventes"},
    "first_favorite":  {"name": "Premier favori",     "description": "Mettre une carte en favori",          "reward": 10,  "category": "Divers"},
    "first_watchlist": {"name": "À voir",             "description": "Mettre une carte en watchlist",       "reward": 10,  "category": "Divers"},
    "credits_5000":    {"name": "Plein les poches",   "description": "Atteindre 5 000¥",                   "reward": 30,  "category": "Divers"},
}


def _achievement_progress(conn: sqlite3.Connection, user_id: int, ach_id: str) -> tuple[int, int]:
    def scalar(sql: str, params: tuple = ()) -> int:
        return int(conn.execute(sql, params).fetchone()[0])

    if ach_id == "first_roll":
        return scalar("SELECT COUNT(*) FROM rolls WHERE user_id = ?", (user_id,)), 1
    if ach_id == "rolls_10":
        return scalar("SELECT COUNT(*) FROM rolls WHERE user_id = ?", (user_id,)), 10
    if ach_id == "rolls_50":
        return scalar("SELECT COUNT(*) FROM rolls WHERE user_id = ?", (user_id,)), 50
    if ach_id == "rolls_200":
        return scalar("SELECT COUNT(*) FROM rolls WHERE user_id = ?", (user_id,)), 200
    if ach_id in ("collection_10", "collection_50", "collection_100", "collection_full"):
        owned = scalar(
            "SELECT COUNT(DISTINCT item_id) FROM inventory WHERE user_id = ? AND count > 0", (user_id,)
        )
        threshold = {"collection_10": 10, "collection_50": 50, "collection_100": 100, "collection_full": len(ITEMS)}[ach_id]
        return owned, threshold
    if ach_id in ("first_R", "first_UR", "first_L"):
        rarity = {"first_R": "R", "first_UR": "UR", "first_L": "L"}[ach_id]
        ids = _RARITY_ITEM_IDS.get(rarity, [])
        if not ids:
            return 0, 1
        ph = ",".join("?" * len(ids))
        return scalar(
            f"SELECT COUNT(*) FROM rolls WHERE user_id = ? AND item_id IN ({ph})",
            (user_id, *ids),
        ), 1
    if ach_id == "first_seen":
        return scalar("SELECT COUNT(*) FROM collection_state WHERE user_id = ? AND seen = 1", (user_id,)), 1
    if ach_id == "seen_25":
        return scalar("SELECT COUNT(*) FROM collection_state WHERE user_id = ? AND seen = 1", (user_id,)), 25
    if ach_id == "seen_50":
        return scalar("SELECT COUNT(*) FROM collection_state WHERE user_id = ? AND seen = 1", (user_id,)), 50
    if ach_id == "first_trade":
        return scalar("SELECT COUNT(*) FROM trades WHERE from_user_id = ?", (user_id,)), 1
    if ach_id == "trades_5":
        return scalar("SELECT COUNT(*) FROM trades WHERE from_user_id = ?", (user_id,)), 5
    if ach_id == "first_sell":
        return scalar("SELECT total_sells FROM users WHERE id = ?", (user_id,)), 1
    if ach_id == "sells_10":
        return scalar("SELECT total_sells FROM users WHERE id = ?", (user_id,)), 10
    if ach_id == "first_favorite":
        return scalar("SELECT COUNT(*) FROM collection_state WHERE user_id = ? AND favorite = 1", (user_id,)), 1
    if ach_id == "first_watchlist":
        return scalar("SELECT COUNT(*) FROM collection_state WHERE user_id = ? AND watchlist = 1", (user_id,)), 1
    if ach_id == "credits_5000":
        return scalar("SELECT credits FROM users WHERE id = ?", (user_id,)), 5000
    return 0, 1


def _check_achievement(conn: sqlite3.Connection, user_id: int, ach_id: str) -> bool:
    current, target = _achievement_progress(conn, user_id, ach_id)
    return target > 0 and current >= target


def check_and_unlock_achievements(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    already = {
        row["achievement_id"]
        for row in conn.execute(
            "SELECT achievement_id FROM user_achievements WHERE user_id = ?", (user_id,)
        ).fetchall()
    }
    newly: list[dict] = []
    for ach_id, ach in ACHIEVEMENTS.items():
        if ach_id in already:
            continue
        if _check_achievement(conn, user_id, ach_id):
            ts = now()
            inserted = conn.execute(
                "INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)",
                (user_id, ach_id, ts),
            )
            if inserted.rowcount == 0:
                continue
            conn.execute("UPDATE users SET credits = credits + ? WHERE id = ?", (ach["reward"], user_id))
            newly.append({**ach, "id": ach_id, "unlockedAt": ts})
    return newly


def achievements_for_user(conn: sqlite3.Connection, user_id: int) -> list[dict]:
    unlocked = {
        row["achievement_id"]: row["unlocked_at"]
        for row in conn.execute(
            "SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?", (user_id,)
        ).fetchall()
    }
    result = []
    for ach_id, ach in ACHIEVEMENTS.items():
        current, target = _achievement_progress(conn, user_id, ach_id)
        entry: dict = {
            **ach,
            "id": ach_id,
            "unlocked": ach_id in unlocked,
            "current": min(current, target),
            "target": target,
            "progress": round((min(current, target) / target) * 100) if target else 0,
        }
        if ach_id in unlocked:
            entry["unlockedAt"] = unlocked[ach_id]
        result.append(entry)
    return result


# ---------------------------------------------------------------------------
# Leaderboard
# ---------------------------------------------------------------------------

_leaderboard_cache: tuple[float, list] | None = None
_LEADERBOARD_TTL = 30


def leaderboard(conn: sqlite3.Connection) -> list[dict]:
    global _leaderboard_cache
    ts = time.monotonic()
    if _leaderboard_cache is not None and ts - _leaderboard_cache[0] < _LEADERBOARD_TTL:
        return _leaderboard_cache[1]
    result = _compute_leaderboard(conn)
    _leaderboard_cache = (ts, result)
    return result


def _compute_leaderboard(conn: sqlite3.Connection) -> list[dict]:
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
