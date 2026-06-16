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
ACHIEVEMENTS_PATH = Path(os.environ.get("GACHA_ACHIEVEMENTS", DATA_DIR / "achievements.json"))
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
SHOWCASE_LIMIT = 3
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
        "SELECT item_id, seen, favorite, watchlist, showcase_slot FROM collection_state WHERE user_id = ?",
        (user_id,),
    ).fetchall()
    seen      = {r["item_id"]: bool(r["seen"])      for r in seen_rows}
    favorites = {r["item_id"]: bool(r["favorite"])  for r in seen_rows}
    watchlist = {r["item_id"]: bool(r["watchlist"]) for r in seen_rows}
    showcase  = {
        r["item_id"]: int(r["showcase_slot"])
        for r in seen_rows
        if r["showcase_slot"] is not None
    }

    payload = []
    for item in DATASET["items"]:
        count = counts.get(item["id"], 0)
        entry = item_payload(item["id"], count, hidden=count == 0)
        entry["seen"]      = bool(seen.get(item["id"], False))
        entry["favorite"]  = bool(favorites.get(item["id"], False)) and count > 0
        entry["watchlist"] = (
            bool(watchlist.get(item["id"], False)) and count > 0 and not entry["favorite"]
        )
        entry["showcaseSlot"] = showcase.get(item["id"]) if count > 0 else None
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

ACHIEVEMENT_METRICS = {
    "rolls",
    "collection",
    "rarity_roll",
    "seen",
    "trades_sent",
    "sells",
    "favorites",
    "watchlist",
    "credits",
}


def _achievement_target(value: int | str) -> int:
    if value == "dataset_total":
        return len(ITEMS)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _achievement_reward(value: int | str) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return -1


def _normalize_achievement(raw: dict, index: int) -> tuple[str, dict]:
    ach_id = str(raw.get("id", "")).strip()
    if not ach_id:
        raise ValueError(f"Achievement #{index + 1}: id manquant.")
    metric = str(raw.get("metric", "")).strip()
    if metric not in ACHIEVEMENT_METRICS:
        raise ValueError(f"Achievement {ach_id!r}: metric inconnue {metric!r}.")
    target = _achievement_target(raw.get("target", 1))
    if target <= 0:
        raise ValueError(f"Achievement {ach_id!r}: target doit etre positif.")
    reward = _achievement_reward(raw.get("reward", 0))
    if reward < 0:
        raise ValueError(f"Achievement {ach_id!r}: reward doit etre positif ou nul.")
    if metric == "rarity_roll" and str(raw.get("rarity", "")).strip() not in RARITY_WEIGHTS:
        raise ValueError(f"Achievement {ach_id!r}: rarity invalide.")
    return ach_id, {
        "name": str(raw.get("name", ach_id)),
        "description": str(raw.get("description", "")),
        "reward": reward,
        "category": str(raw.get("category", "Divers")),
        "metric": metric,
        "target": target,
        **({"rarity": str(raw["rarity"]).strip()} if "rarity" in raw else {}),
    }


def load_achievements() -> dict[str, dict]:
    with ACHIEVEMENTS_PATH.open("r", encoding="utf-8") as f:
        data = json.load(f)
    entries = data.get("achievements") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        raise ValueError("Le fichier achievements doit contenir une liste ou une cle 'achievements'.")
    result: dict[str, dict] = {}
    for index, raw in enumerate(entries):
        if not isinstance(raw, dict):
            raise ValueError(f"Achievement #{index + 1}: entree invalide.")
        ach_id, achievement = _normalize_achievement(raw, index)
        if ach_id in result:
            raise ValueError(f"Achievement {ach_id!r}: id duplique.")
        result[ach_id] = achievement
    return result


ACHIEVEMENTS: dict[str, dict] = load_achievements()


def _achievement_progress(conn: sqlite3.Connection, user_id: int, ach_id: str) -> tuple[int, int]:
    def scalar(sql: str, params: tuple = ()) -> int:
        return int(conn.execute(sql, params).fetchone()[0])

    ach = ACHIEVEMENTS.get(ach_id)
    if not ach:
        return 0, 1
    metric = ach["metric"]
    target = int(ach["target"])

    if metric == "rolls":
        return scalar("SELECT COUNT(*) FROM rolls WHERE user_id = ?", (user_id,)), target
    if metric == "collection":
        return scalar(
            "SELECT COUNT(DISTINCT item_id) FROM inventory WHERE user_id = ? AND count > 0", (user_id,)
        ), target
    if metric == "rarity_roll":
        rarity = ach.get("rarity", "")
        ids = _RARITY_ITEM_IDS.get(rarity, [])
        if not ids:
            return 0, target
        ph = ",".join("?" * len(ids))
        return scalar(
            f"SELECT COUNT(*) FROM rolls WHERE user_id = ? AND item_id IN ({ph})",
            (user_id, *ids),
        ), target
    if metric == "seen":
        return scalar("SELECT COUNT(*) FROM collection_state WHERE user_id = ? AND seen = 1", (user_id,)), target
    if metric == "trades_sent":
        return scalar("SELECT COUNT(*) FROM trades WHERE from_user_id = ?", (user_id,)), target
    if metric == "sells":
        return scalar("SELECT total_sells FROM users WHERE id = ?", (user_id,)), target
    if metric == "favorites":
        return scalar("SELECT COUNT(*) FROM collection_state WHERE user_id = ? AND favorite = 1", (user_id,)), target
    if metric == "watchlist":
        return scalar("SELECT COUNT(*) FROM collection_state WHERE user_id = ? AND watchlist = 1", (user_id,)), target
    if metric == "credits":
        return scalar("SELECT credits FROM users WHERE id = ?", (user_id,)), target
    return 0, target


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
