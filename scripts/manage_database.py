#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATASET_DIR = ROOT / "data" / "dataset"
DEFAULT_DATASET_ID = "cinegacha"
DROP_RATES = {"C": 55, "UC": 28, "R": 12, "UR": 4, "L": 1}
RARITY_BUCKETS = (("L", 0.02), ("UR", 0.10), ("R", 0.30), ("UC", 0.60))

TMDB_SEARCH_API = "https://api.themoviedb.org/3/search/movie"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500"


def request_json(url: str, headers: dict[str, str], timeout: int = 30) -> dict:
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def download(url: str, headers: dict[str, str], timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def slugify(name: str) -> str:
    slug = "".join(c.lower() if c.isalnum() else "-" for c in name).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "film"


def unique_id(name: str, year: int | None, used: set[str]) -> str:
    base = slugify(name)
    candidates = [base]
    if year:
        candidates.append(f"{base}-{year}")
    suffix = 2
    while True:
        for candidate in candidates:
            if candidate not in used:
                used.add(candidate)
                return candidate
        candidates = [f"{base}-{suffix}"]
        suffix += 1


def dataset_path(dataset_id: str) -> Path:
    return DATASET_DIR / "dataset.json"


def read_dataset(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(path)
    dataset = json.loads(path.read_text(encoding="utf-8"))
    dataset.setdefault("dropRates", DROP_RATES)
    dataset.setdefault("items", [])
    return dataset


def write_dataset(path: Path, dataset: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dataset, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


def prompt(text: str, default: str | None = None) -> str:
    suffix = f" [{default}]" if default is not None else ""
    value = input(f"{text}{suffix}: ").strip()
    return value if value else (default or "")


def prompt_yes_no(text: str, default: bool = False) -> bool:
    default_text = "O/n" if default else "o/N"
    value = input(f"{text} [{default_text}]: ").strip().lower()
    if not value:
        return default
    return value in {"o", "oui", "y", "yes"}


def prompt_int(text: str, default: int, minimum: int = 0, maximum: int | None = None) -> int:
    while True:
        raw = prompt(text, str(default))
        try:
            value = int(raw)
        except ValueError:
            print("Nombre invalide.")
            continue
        if value < minimum or (maximum is not None and value > maximum):
            print("Nombre hors limites.")
            continue
        return value


def list_dataset_ids() -> list[str]:
    if not (DATASET_DIR / "dataset.json").exists():
        return []
    dataset = read_dataset(DATASET_DIR / "dataset.json")
    return [dataset.get("id") or DEFAULT_DATASET_ID]


def select_or_create_dataset() -> tuple[Path, dict, bool]:
    print("\n=== Database cible ===")
    ids = list_dataset_ids()
    for index, dataset_id in enumerate(ids, start=1):
        print(f"{index}. Editer {dataset_id}")
    print(f"{len(ids) + 1}. Creer une nouvelle database")

    choice = prompt_int("Choix", 1 if ids else 1, 1, len(ids) + 1)
    if choice <= len(ids):
        path = DATASET_DIR / "dataset.json"
        return path, read_dataset(path), False

    dataset_id = slugify(prompt("Identifiant de la database", DEFAULT_DATASET_ID))
    name = prompt("Nom affiche", dataset_id.replace("-", " ").title())
    dataset = {
        "id": dataset_id,
        "name": name,
        "dropRates": DROP_RATES,
        "items": [],
    }
    return dataset_path(dataset_id), dataset, True


def load_films_json() -> list[dict]:
    print("\n=== Import depuis un JSON ===")
    raw_path = prompt("Chemin du fichier JSON")
    if not raw_path:
        print("Import annule.")
        return []

    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = ROOT / path
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("Le fichier JSON doit contenir une liste de films.")

    films = [film for film in data if isinstance(film, dict) and film.get("name")]
    skipped = len(data) - len(films)
    print(f"Films importables: {len(films)}")
    if skipped:
        print(f"Entrees ignorees: {skipped}")
    return films


def merge_films(existing: list[dict], imported: list[dict]) -> tuple[list[dict], int]:
    merged: dict[tuple[str, int | None], dict] = {}
    removed = 0

    for film in existing + imported:
        name = film.get("name")
        if not name:
            continue
        key = (name.casefold(), film.get("year"))
        if key not in merged:
            merged[key] = film
            continue

        removed += 1
        current = merged[key]
        current_reviews = current.get("reviewCount") or 0
        next_reviews = film.get("reviewCount") or 0
        if next_reviews > current_reviews:
            merged[key] = {**current, **film}
        else:
            for field in ("director", "rating", "reviewCount", "url"):
                if current.get(field) in (None, "") and film.get(field) not in (None, ""):
                    current[field] = film[field]

    return list(merged.values()), removed


def normalize_items(dataset: dict, films: list[dict]) -> None:
    old_by_key = {
        (item.get("name", "").casefold(), item.get("year")): item
        for item in dataset.get("items", [])
    }
    used: set[str] = set()
    items = []
    for film in films:
        name = film.get("name")
        if not name:
            continue
        year = film.get("year")
        old = old_by_key.get((name.casefold(), year))
        item_id = old.get("id") if old else unique_id(name, year, used)
        if item_id in used:
            item_id = unique_id(name, year, used)
        else:
            used.add(item_id)

        image = old.get("image") if old else ""
        if not image:
            image = f"/api/poster/{item_id}"

        item = {
            "id": item_id,
            "name": name,
            "year": year,
            "director": film.get("director") or (old or {}).get("director") or "Realisateur a renseigner",
            "rating": float(film.get("rating") or (old or {}).get("rating") or 0),
            "reviewCount": int(film.get("reviewCount") or (old or {}).get("reviewCount") or 0),
            "url": film.get("url") or (old or {}).get("url", ""),
            "rarity": film.get("rarity") or (old or {}).get("rarity", "C"),
            "image": image,
        }
        for field in ("posterSource", "posterTmdbId", "rating_score", "review_score", "rarity_score"):
            value = (old or {}).get(field, film.get(field))
            if value not in (None, ""):
                item[field] = value
        items.append(item)
    dataset["items"] = items


def apply_rarities(dataset: dict) -> None:
    items = dataset.get("items", [])
    if not items:
        return

    ratings = [float(item.get("rating") or 0) for item in items]
    review_logs = [math.log(max(int(item.get("reviewCount") or 0), 1)) for item in items]
    min_rating, max_rating = min(ratings), max(ratings)
    min_reviews, max_reviews = min(review_logs), max(review_logs)

    scored = []
    for item, rating, review_log in zip(items, ratings, review_logs):
        rating_score = 0 if max_rating == min_rating else (rating - min_rating) / (max_rating - min_rating)
        review_score = 0 if max_reviews == min_reviews else 1 - ((review_log - min_reviews) / (max_reviews - min_reviews))
        rarity_score = rating_score * 0.8 + review_score * 0.2
        item["rating_score"] = round(rating_score, 4)
        item["review_score"] = round(review_score, 4)
        item["rarity_score"] = round(rarity_score, 4)
        scored.append((rarity_score, item))

    scored.sort(key=lambda pair: pair[0], reverse=True)
    total = len(scored)
    for index, (_, item) in enumerate(scored):
        rank = index / total
        rarity = "C"
        for candidate, limit in RARITY_BUCKETS:
            if rank < limit:
                rarity = candidate
                break
        item["rarity"] = rarity

    dataset["items"] = [item for _, item in scored]


def movie_year(movie: dict) -> int | None:
    date = movie.get("release_date") or ""
    try:
        return int(date[:4]) if len(date) >= 4 else None
    except ValueError:
        return None


def search_tmdb_movie(name: str, year: int | None, api_key: str) -> dict | None:
    queries = [name]
    if ":" in name:
        queries.append(name.split(":", 1)[0])
    if " - " in name:
        queries.append(name.split(" - ", 1)[0])

    attempts = []
    for query in dict.fromkeys(queries):
        attempts.append((query, year))
        attempts.append((query, None))

    lowered = name.lower()
    for query, query_year in attempts:
        params = {"query": query, "include_adult": "false", "language": "en-US", "page": 1}
        if query_year:
            params["year"] = query_year
            params["primary_release_year"] = query_year
        if api_key:
            params["api_key"] = api_key
        url = TMDB_SEARCH_API + "?" + urllib.parse.urlencode(params)
        data = request_json(url, {"User-Agent": "CineGacha/1.0"}, timeout=20)
        results = [item for item in data.get("results", []) if item.get("poster_path")]
        if not results:
            continue
        exact = [
            item for item in results
            if item.get("title", "").lower() == lowered or item.get("original_title", "").lower() == lowered
        ]
        candidates = exact or results
        if year:
            year_matches = [item for item in candidates if movie_year(item) == year]
            if year_matches:
                return year_matches[0]
        return candidates[0]
    return None


def cache_missing_posters(dataset_path_: Path, dataset: dict, limit: int = 0, delay: float = 0.25) -> int:
    api_key = os.environ.get("TMDB_API_KEY")
    if not api_key:
        print("TMDB_API_KEY manquant. Posters ignores.")
        return 0

    image_dir = dataset_path_.parent / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    updated = 0
    for index, item in enumerate(dataset.get("items", []), start=1):
        if limit and updated >= limit:
            break

        file_path = image_dir / f"{item['id']}.jpg"
        if file_path.exists():
            item["image"] = f"/dataset/images/{file_path.name}"
            item.setdefault("posterSource", "local-cache")
            print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> deja cache")
            continue

        if item.get("image", "").startswith("/dataset/images/"):
            print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> deja reference")
            continue

        movie = search_tmdb_movie(item["name"], item.get("year"), api_key)
        if not movie:
            print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> sans poster")
            continue

        poster_url = TMDB_IMAGE_BASE + movie["poster_path"]
        file_path.write_bytes(download(poster_url, {"User-Agent": "CineGacha/1.0"}))
        item["image"] = f"/dataset/images/{file_path.name}"
        item["posterSource"] = "TMDb"
        item["posterTmdbId"] = movie["id"]
        updated += 1
        write_dataset(dataset_path_, dataset)
        print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> TMDb {movie['id']}")
        time.sleep(delay)
    return updated


def dataset_to_source_films(dataset: dict) -> list[dict]:
    fields = ("name", "year", "director", "rating", "reviewCount", "url", "rating_score", "review_score", "rarity_score", "rarity")
    return [{field: item[field] for field in fields if field in item} for item in dataset.get("items", [])]


def run_interactive() -> None:
    path, dataset, is_new = select_or_create_dataset()
    dataset["id"] = dataset.get("id") or path.parent.name
    dataset.setdefault("name", dataset["id"])
    dataset.setdefault("dropRates", DROP_RATES)
    dataset.setdefault("items", [])

    print(f"\nDatabase: {dataset['name']} ({dataset['id']})")
    actions = {
        "import_json": prompt_yes_no("Importer depuis un fichier JSON ?", default=is_new),
        "rarity": prompt_yes_no("Creer/recalculer la rarete des cartes ?", default=True),
        "posters": prompt_yes_no("Importer les posters manquants depuis TMDb ?", default=False),
    }

    if actions["import_json"]:
        imported = load_films_json()
        current_films = dataset_to_source_films(dataset)
        merged_films, duplicates = merge_films(current_films, imported)
        normalize_items(dataset, merged_films)
        print(f"Import termine: {len(imported)} films importes, {duplicates} doublons supprimes.")

    if actions["rarity"]:
        apply_rarities(dataset)
        print("Raretes recalculees.")

    write_dataset(path, dataset)
    print(f"Database ecrite: {path}")

    if actions["posters"]:
        limit = prompt_int("Limite de nouveaux posters ? 0 = tout", 0, 0)
        updated = cache_missing_posters(path, dataset, limit=limit)
        write_dataset(path, dataset)
        print(f"Posters importes: {updated}")

    print("Termine.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Creer ou editer une database CineGacha.")
    parser.add_argument("--interactive", action="store_true", help="Lance le menu interactif.")
    parser.parse_args()

    # Le mode interactif est le comportement par defaut pour garder le script simple cote usage.
    run_interactive()


if __name__ == "__main__":
    main()
