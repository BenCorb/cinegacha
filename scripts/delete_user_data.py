#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from db import backup_database, db, init_db, normalize_username
from game import ApiError


def related_counts(user_id: int) -> dict[str, int]:
    with db() as conn:
        return {
            "inventory": conn.execute(
                "SELECT COUNT(*) AS total FROM inventory WHERE user_id = ?",
                (user_id,),
            ).fetchone()["total"],
            "rolls": conn.execute(
                "SELECT COUNT(*) AS total FROM rolls WHERE user_id = ?",
                (user_id,),
            ).fetchone()["total"],
            "collection_state": conn.execute(
                "SELECT COUNT(*) AS total FROM collection_state WHERE user_id = ?",
                (user_id,),
            ).fetchone()["total"],
            "trades": conn.execute(
                "SELECT COUNT(*) AS total FROM trades WHERE from_user_id = ? OR to_user_id = ?",
                (user_id, user_id),
            ).fetchone()["total"],
            "achievements": conn.execute(
                "SELECT COUNT(*) AS total FROM user_achievements WHERE user_id = ?",
                (user_id,),
            ).fetchone()["total"],
        }


def delete_user(username: str, assume_yes: bool) -> int:
    try:
        username = normalize_username(username)
    except ApiError as exc:
        print(f"Pseudo invalide: {exc.message}", file=sys.stderr)
        return 2

    init_db()
    with db() as conn:
        user = conn.execute(
            "SELECT id, username, created_at FROM users WHERE username = ?",
            (username,),
        ).fetchone()

    if not user:
        print(f"Aucun utilisateur trouve pour {username!r}.")
        return 1

    counts = related_counts(user["id"])
    print(f"Utilisateur: {user['username']} (id {user['id']})")
    print(f"Inventaire: {counts['inventory']}")
    print(f"Tirages: {counts['rolls']}")
    print(f"Etats collection: {counts['collection_state']}")
    print(f"Echanges lies: {counts['trades']}")
    print(f"Succes: {counts['achievements']}")

    if not assume_yes:
        expected = f"SUPPRIMER {user['username']}"
        answer = input(f"Tape {expected!r} pour confirmer: ").strip()
        if answer != expected:
            print("Suppression annulee.")
            return 130

    backup_path = backup_database()
    with db() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user["id"],))

    print(f"Backup cree: {backup_path}")
    print(f"Donnees supprimees pour {user['username']}.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Supprime un utilisateur CineGacha et ses donnees liees."
    )
    parser.add_argument("username", help="Pseudo de l'utilisateur a supprimer.")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Confirme sans invite interactive. A utiliser avec prudence.",
    )
    args = parser.parse_args()
    return delete_user(args.username, args.yes)


if __name__ == "__main__":
    raise SystemExit(main())
