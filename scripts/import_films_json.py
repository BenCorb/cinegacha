#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "data" / "sources" / "films.json"
DEFAULT_DATASET = ROOT / "data" / "datasets" / "cinegacha-films" / "dataset.json"
DROP_RATES = {"C": 55, "UC": 28, "R": 12, "UR": 4, "L": 1}


def slugify(name: str) -> str:
    slug = "".join(c.lower() if c.isalnum() else "-" for c in name).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug


def unique_id(name: str, year: int | None, used: set[str]) -> str:
    base = slugify(name)
    candidate = base
    if candidate in used and year:
        candidate = f"{base}-{year}"
    suffix = 2
    while candidate in used:
        candidate = f"{base}-{suffix}"
        suffix += 1
    used.add(candidate)
    return candidate


def main() -> None:
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_DATASET
    old_items = {}
    old_image_dir = out.parent / "images"
    if out.exists():
        old_dataset = json.loads(out.read_text(encoding="utf-8"))
        old_items = {item["id"]: item for item in old_dataset.get("items", [])}

    films = json.loads(source.read_text(encoding="utf-8"))
    out.parent.mkdir(parents=True, exist_ok=True)
    old_image_dir.mkdir(parents=True, exist_ok=True)

    used: set[str] = set()
    items = []
    reused = 0
    for film in films:
        year = int(film["year"]) if film.get("year") else None
        base_id = slugify(film["name"])
        item_id = unique_id(film["name"], year, used)
        old = old_items.get(item_id) or (old_items.get(base_id) if item_id == base_id else None)
        image = f"/api/poster/{item_id}"
        poster_source = None
        poster_tmdb_id = None

        direct_file = old_image_dir / f"{item_id}.jpg"
        old_slug_file = old_image_dir / f"{base_id}.jpg"
        if direct_file.exists():
            image = f"/datasets/cinegacha-films/images/{direct_file.name}"
            reused += 1
        elif item_id == base_id and old_slug_file.exists():
            shutil.copy2(old_slug_file, direct_file)
            image = f"/datasets/cinegacha-films/images/{direct_file.name}"
            reused += 1
        elif old and old.get("image", "").startswith("/datasets/"):
            old_name = Path(old["image"]).name
            old_path = old_image_dir / old_name
            if old_path.exists():
                shutil.copy2(old_path, direct_file)
                image = f"/datasets/cinegacha-films/images/{direct_file.name}"
                reused += 1

        if old and image.startswith("/datasets/") and old.get("posterSource"):
            poster_source = old.get("posterSource")
            poster_tmdb_id = old.get("posterTmdbId")

        item = {
            "id": item_id,
            "name": film["name"],
            "year": year,
            "director": film.get("director") or "Realisateur a renseigner",
            "rating": float(film.get("rating") or 0),
            "reviewCount": int(film.get("reviewCount") or 0),
            "url": film.get("url", ""),
            "rarity": film["rarity"],
            "image": image,
        }
        if poster_source:
            item["posterSource"] = poster_source
        if poster_tmdb_id:
            item["posterTmdbId"] = poster_tmdb_id
        items.append(item)

    dataset = {
        "id": "cinegacha-films",
        "name": "CinéGacha Films",
        "dropRates": DROP_RATES,
        "items": items,
    }
    out.write_text(json.dumps(dataset, ensure_ascii=True, indent=2), encoding="utf-8")
    print(f"Wrote {out} with {len(items)} items; reused {reused} local posters")


if __name__ == "__main__":
    main()
