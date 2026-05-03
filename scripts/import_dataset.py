#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import math
import sys
from pathlib import Path


def slugify(name: str) -> str:
    return "".join(c.lower() if c.isalnum() else "-" for c in name).strip("-").replace("--", "-")


def main() -> None:
    if len(sys.argv) != 4:
        print("Usage: scripts/import_dataset.py input.csv dataset-id 'Dataset Name'")
        print("CSV columns: name,image,rating,reviewCount,director")
        raise SystemExit(2)
    source = Path(sys.argv[1])
    dataset_id = sys.argv[2]
    dataset_name = sys.argv[3]
    rows = list(csv.DictReader(source.open(encoding="utf-8")))
    scored = []
    for row in rows:
        rating = float(row["rating"])
        reviews = int(row["reviewCount"])
        scored.append(((rating / 5) * math.log(max(reviews, 1)), row, rating, reviews))
    scores = sorted([score for score, *_ in scored], reverse=True)
    items = []
    for score, row, rating, reviews in scored:
        rank = scores.index(score) / len(scores)
        rarity = "L" if rank < .02 else "UR" if rank < .10 else "R" if rank < .30 else "UC" if rank < .60 else "C"
        name = row["name"].strip()
        slug = slugify(name)
        items.append({
            "id": slug,
            "name": name,
            "image": row.get("image") or f"/api/poster/{slug}",
            "director": row.get("director", "").strip() or "Realisateur a renseigner",
            "rating": rating,
            "reviewCount": reviews,
            "rarity": rarity,
        })
    out = Path("data") / "datasets" / dataset_id / "dataset.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "id": dataset_id,
        "name": dataset_name,
        "dropRates": {"C": 55, "UC": 28, "R": 12, "UR": 4, "L": 1},
        "items": items,
    }, ensure_ascii=True, indent=2), encoding="utf-8")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
