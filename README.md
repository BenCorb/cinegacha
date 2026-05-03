# CinéGacha

Jeu navigateur auto-hebergeable : machine gachapon, capsules, collection de films et envoi de doublons entre utilisateurs.

## Lancer en local

```bash
python3 server.py
```

Puis ouvrir http://127.0.0.1:8000 sur la machine hote.
Par defaut, le serveur ecoute aussi sur le reseau local : les autres appareils peuvent ouvrir l'URL affichee au lancement, par exemple `http://192.168.x.x:8000`.

Pour limiter l'app a la machine locale :

```bash
HOST=127.0.0.1 python3 server.py
```

## Docker

```bash
docker compose up --build
```

## Dataset modulaire

Le dataset actif vit dans `data/datasets/cinegacha-films/dataset.json`.
La source brute importee vit dans `data/sources/films.json`.

Pour reconstruire le dataset actif depuis la source JSON :

```bash
python3 scripts/import_films_json.py
```

Pour importer un CSV :

```bash
python3 scripts/import_dataset.py films.csv mon-dataset "Mon Dataset"
GACHA_DATASET=mon-dataset python3 server.py
```

Colonnes CSV attendues : `name,image,rating,reviewCount,director`.

Source recommandee pour de vrais posters : TMDb. Creer une cle sur TMDb, puis :

```bash
TMDB_API_KEY=ta_cle python3 scripts/enrich_posters_tmdb.py data/datasets/cinegacha-films/dataset.json
```

Ou avec un token v4 :

```bash
TMDB_READ_TOKEN=ton_token python3 scripts/enrich_posters_tmdb.py data/datasets/cinegacha-films/dataset.json
```

## Notes v1

- Les comptes utilisent `username + cle de connexion`.
- La cle est affichee a la creation et stockee dans le navigateur courant.
- Les envois de cartes exigent un doublon cote expediteur.
- Les posters sont caches localement dans le dossier du dataset actif.
