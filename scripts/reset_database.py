#!/usr/bin/env python3
from __future__ import annotations

import sqlite3
from pathlib import Path

DB = Path("data/gachapon.sqlite")


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.execute("PRAGMA foreign_keys = ON")
    for table in ("trades", "rolls", "collection_state", "inventory", "users"):
        exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
        if exists:
            conn.execute(f"DELETE FROM {table}")
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").fetchone():
        conn.execute("DELETE FROM sqlite_sequence WHERE name = 'users'")
    conn.commit()
    conn.close()
    print("Database reset complete")


if __name__ == "__main__":
    main()
