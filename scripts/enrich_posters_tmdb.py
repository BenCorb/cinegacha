#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET = ROOT / "data" / "datasets" / "cinegacha-films" / "dataset.json"
API = "https://api.themoviedb.org/3/search/movie"
IMAGE_BASE = "https://image.tmdb.org/t/p/w500"


def request_json(url: str, token: str | None) -> dict:
    headers = {"User-Agent": "CineGacha/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "CineGacha/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def movie_year(movie: dict) -> int | None:
    date = movie.get("release_date") or ""
    try:
        return int(date[:4]) if len(date) >= 4 else None
    except ValueError:
        return None


def search_movie(name: str, year: int | None, api_key: str | None, token: str | None) -> dict | None:
    queries = [name]
    if ":" in name:
        queries.append(name.split(":", 1)[0])
    if " – " in name:
        queries.append(name.split(" – ", 1)[0])

    attempts: list[tuple[str, int | None]] = []
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
        data = request_json(API + "?" + urllib.parse.urlencode(params), token)
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Cache TMDb posters into a CineGacha dataset.")
    parser.add_argument("dataset", nargs="?", default=str(DEFAULT_DATASET))
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of new posters to cache.")
    parser.add_argument("--delay", type=float, default=0.25, help="Delay between movies, in seconds.")
    args = parser.parse_args()

    api_key = os.environ.get("TMDB_API_KEY")
    token = os.environ.get("TMDB_READ_TOKEN")
    if not api_key and not token:
        raise SystemExit("Set TMDB_API_KEY or TMDB_READ_TOKEN before running this script.")

    path = Path(args.dataset)
    dataset = json.loads(path.read_text(encoding="utf-8"))
    dataset_id = dataset["id"]
    image_dir = path.parent / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    updated = 0
    touched = False
    missing = []
    for index, item in enumerate(dataset["items"], start=1):
        if args.limit and updated >= args.limit:
            break
        file_path = image_dir / f"{item['id']}.jpg"
        if file_path.exists():
            item["image"] = f"/datasets/{dataset_id}/images/{file_path.name}"
            if not item.get("posterSource"):
                item["posterSource"] = "local-cache"
                touched = True
            print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> deja cache", flush=True)
            continue
        if item.get("posterSource") == "TMDb" and item.get("image", "").startswith(f"/datasets/{dataset_id}/images/"):
            print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> deja cache", flush=True)
            continue

        movie = search_movie(item["name"], item.get("year"), api_key, token)
        if not movie:
            missing.append(item["name"])
            continue

        poster_url = IMAGE_BASE + movie["poster_path"]
        file_path.write_bytes(download(poster_url))
        item["image"] = f"/datasets/{dataset_id}/images/{file_path.name}"
        item["posterSource"] = "TMDb"
        item["posterTmdbId"] = movie["id"]
        updated += 1
        touched = True
        path.write_text(json.dumps(dataset, ensure_ascii=True, indent=2), encoding="utf-8")
        print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> TMDb {movie['id']}", flush=True)
        time.sleep(args.delay)

    if missing:
        print("Sans poster:", ", ".join(missing), flush=True)
    if touched:
        path.write_text(json.dumps(dataset, ensure_ascii=True, indent=2), encoding="utf-8")
    print(f"Posters TMDb caches: {updated}", flush=True)


if __name__ == "__main__":
    main()
