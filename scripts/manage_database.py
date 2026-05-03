#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html as html_lib
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATASETS_DIR = ROOT / "data" / "datasets"
SOURCES_DIR = ROOT / "data" / "sources"
DEFAULT_DATASET_ID = "cinegacha-films"
DROP_RATES = {"C": 55, "UC": 28, "R": 12, "UR": 4, "L": 1}
RARITY_BUCKETS = (("L", 0.02), ("UR", 0.10), ("R", 0.30), ("UC", 0.60))

LETTERBOXD_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605.1.15",
    "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
}
TMDB_SEARCH_API = "https://api.themoviedb.org/3/search/movie"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500"


def request_text(url: str, headers: dict[str, str], timeout: int = 30) -> tuple[str, str]:
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        final_url = response.geturl()
        return response.read().decode("utf-8", errors="replace"), final_url


def request_json(url: str, headers: dict[str, str], timeout: int = 30) -> dict:
    text, _ = request_text(url, headers, timeout)
    return json.loads(text)


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
    return DATASETS_DIR / dataset_id / "dataset.json"


def source_path(dataset_id: str) -> Path:
    if dataset_id == DEFAULT_DATASET_ID:
        return SOURCES_DIR / "films.json"
    return SOURCES_DIR / f"{dataset_id}.json"


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


def write_source(path: Path, films: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(films, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")


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
    if not DATASETS_DIR.exists():
        return []
    return sorted(p.name for p in DATASETS_DIR.iterdir() if (p / "dataset.json").exists())


def select_or_create_dataset() -> tuple[Path, dict, bool]:
    print("\n=== Database cible ===")
    ids = list_dataset_ids()
    for index, dataset_id in enumerate(ids, start=1):
        print(f"{index}. Editer {dataset_id}")
    print(f"{len(ids) + 1}. Creer une nouvelle database")

    choice = prompt_int("Choix", 1 if ids else 1, 1, len(ids) + 1)
    if choice <= len(ids):
        path = dataset_path(ids[choice - 1])
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


def normalize_url(url: str) -> str:
    return url.strip().rstrip("/") + "/"


def list_page_url(list_url: str, page: int) -> str:
    base = normalize_url(list_url)
    return base if page == 1 else f"{base}page/{page}/"


def extract_film_urls(html: str) -> list[str]:
    urls = []
    for href in re.findall(r'data-target-link=["\'](/film/[^"\']+/)["\']', html):
        urls.append(urllib.parse.urljoin("https://letterboxd.com", href))

    seen = set()
    unique = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            unique.append(url)
    return unique


def get_letterboxd_film_urls(list_url: str) -> list[str]:
    urls: list[str] = []
    seen = set()
    for page in range(1, 201):
        url = list_page_url(list_url, page)
        print(f"Analyse page {page}: {url}")
        try:
            html, _ = request_text(url, LETTERBOXD_HEADERS)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                break
            raise
        page_urls = extract_film_urls(html)
        if not page_urls:
            break
        for film_url in page_urls:
            if film_url not in seen:
                seen.add(film_url)
                urls.append(film_url)
        print(f"Total provisoire: {len(urls)}")
        time.sleep(0.3)
    return urls


def strip_tags(text: str) -> str:
    return html_lib.unescape(re.sub(r"<[^>]+>", " ", text)).replace("\xa0", " ")


def clean_spaces(text: str | None) -> str | None:
    if text is None:
        return None
    return re.sub(r"\s+", " ", html_lib.unescape(text)).strip()


def clean_int(value: object) -> int | None:
    if value is None:
        return None
    match = re.search(r"\d+", html_lib.unescape(str(value)).replace(",", ""))
    return int(match.group(0)) if match else None


def clean_float(value: object) -> float | None:
    if value is None:
        return None
    match = re.search(r"\d+(?:\.\d+)?", str(value))
    return float(match.group(0)) if match else None


def meta_content(html: str, pattern: str) -> str | None:
    match = re.search(pattern, html, flags=re.I | re.S)
    return clean_spaces(match.group(1)) if match else None


def parse_name_year(html: str) -> tuple[str | None, int | None]:
    candidates = [
        meta_content(html, r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']'),
        meta_content(html, r'<meta[^>]+name=["\']twitter:title["\'][^>]+content=["\']([^"\']+)["\']'),
        clean_spaces(strip_tags(match.group(1))) if (match := re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)) else None,
    ]
    for text in candidates:
        if not text:
            continue
        text = text.replace("\u200e", "").strip()
        match = re.search(r"^(.*?)\s+\((\d{4})\)", text)
        if match:
            return match.group(1).strip(), int(match.group(2))
    return None, None


def parse_director(html: str) -> str | None:
    block_match = re.search(r'<div[^>]+class=["\'][^"\']*productioninfo[^"\']*["\'][^>]*>(.*?)</section>', html, re.I | re.S)
    block = block_match.group(1) if block_match else html
    credits = re.findall(r'<p[^>]+class=["\'][^"\']*credits[^"\']*["\'][^>]*>(.*?)</p>', block, re.I | re.S)
    for credit in credits:
        if "Directed by" not in strip_tags(credit):
            continue
        names = [clean_spaces(strip_tags(name)) for name in re.findall(r'<a[^>]+class=["\'][^"\']*contributor[^"\']*["\'][^>]*>(.*?)</a>', credit, re.I | re.S)]
        names = [name for name in names if name]
        if names:
            return ", ".join(names)
    return None


def parse_rating_and_count(html: str) -> tuple[float | None, int | None]:
    for raw in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', html, re.I | re.S):
        raw = raw.replace("/* <![CDATA[ */", "").replace("/* ]]> */", "").strip()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        items = data if isinstance(data, list) else [data]
        for item in items:
            if not isinstance(item, dict):
                continue
            aggregate = item.get("aggregateRating")
            if isinstance(aggregate, dict):
                return clean_float(aggregate.get("ratingValue")), clean_int(aggregate.get("ratingCount"))

    twitter_rating = meta_content(html, r'<meta[^>]+name=["\']twitter:data2["\'][^>]+content=["\']([^"\']+)["\']')
    return clean_float(twitter_rating), None


def parse_letterboxd_film(film_url: str) -> dict:
    html, final_url = request_text(film_url, LETTERBOXD_HEADERS)
    name, year = parse_name_year(html)
    rating, review_count = parse_rating_and_count(html)
    return {
        "name": name,
        "year": year,
        "director": parse_director(html),
        "rating": rating,
        "reviewCount": review_count,
        "url": final_url.rstrip("/") + "/",
    }


def import_from_letterboxd() -> list[dict]:
    print("\n=== Import depuis une liste Letterboxd ===")
    list_url = prompt("URL de la liste Letterboxd")
    if not list_url:
        print("Import annule.")
        return []

    film_urls = get_letterboxd_film_urls(list_url)
    print(f"\nFilms trouves: {len(film_urls)}")
    if not film_urls:
        return []

    count = prompt_int("Combien de films importer ? 0 = tout", 0, 0, len(film_urls))
    if count == 0:
        count = len(film_urls)

    films = []
    for index, url in enumerate(film_urls[:count], start=1):
        print(f"{index}/{count} {url}")
        try:
            film = parse_letterboxd_film(url)
            films.append(film)
            if not film.get("name"):
                print("  Titre introuvable.")
            if film.get("reviewCount") is None:
                print("  reviewCount introuvable.")
        except Exception as exc:
            print(f"  Erreur: {exc}")
            films.append({
                "name": None,
                "year": None,
                "director": None,
                "rating": None,
                "reviewCount": None,
                "url": url,
                "error": str(exc),
            })
        time.sleep(0.6)
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


def tmdb_headers(token: str | None) -> dict[str, str]:
    headers = {"User-Agent": "CineGacha/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def search_tmdb_movie(name: str, year: int | None, api_key: str | None, token: str | None) -> dict | None:
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
        data = request_json(url, tmdb_headers(token), timeout=20)
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
    token = os.environ.get("TMDB_READ_TOKEN")
    if not api_key and not token:
        print("TMDB_API_KEY ou TMDB_READ_TOKEN manquant. Posters ignores.")
        return 0

    dataset_id = dataset["id"]
    image_dir = dataset_path_.parent / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    updated = 0
    for index, item in enumerate(dataset.get("items", []), start=1):
        if limit and updated >= limit:
            break

        file_path = image_dir / f"{item['id']}.jpg"
        if file_path.exists():
            item["image"] = f"/datasets/{dataset_id}/images/{file_path.name}"
            item.setdefault("posterSource", "local-cache")
            print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> deja cache")
            continue

        if item.get("image", "").startswith(f"/datasets/{dataset_id}/images/"):
            print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> deja reference")
            continue

        movie = search_tmdb_movie(item["name"], item.get("year"), api_key, token)
        if not movie:
            print(f"{index:03d}/{len(dataset['items'])} {item['name']} -> sans poster")
            continue

        poster_url = TMDB_IMAGE_BASE + movie["poster_path"]
        file_path.write_bytes(download(poster_url, {"User-Agent": "CineGacha/1.0"}))
        item["image"] = f"/datasets/{dataset_id}/images/{file_path.name}"
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
        "import_letterboxd": prompt_yes_no("Importer depuis une liste Letterboxd ?", default=is_new),
        "rarity": prompt_yes_no("Creer/recalculer la rarete des cartes ?", default=True),
        "posters": prompt_yes_no("Importer les posters manquants depuis TMDb ?", default=False),
    }

    if actions["import_letterboxd"]:
        imported = import_from_letterboxd()
        current_films = dataset_to_source_films(dataset)
        merged_films, duplicates = merge_films(current_films, imported)
        normalize_items(dataset, merged_films)
        print(f"Import termine: {len(imported)} films importes, {duplicates} doublons supprimes.")

    if actions["rarity"]:
        apply_rarities(dataset)
        print("Raretes recalculees.")

    write_dataset(path, dataset)
    write_source(source_path(dataset["id"]), dataset_to_source_films(dataset))
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
