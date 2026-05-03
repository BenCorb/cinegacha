# CinéGacha

Jeu navigateur auto-hebergeable : machine gachapon, capsules, collection de films et envoi de doublons entre utilisateurs.

Version en ligne : https://cinegacha.app

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

Pour creer ou editer une database de films :

```bash
python3 scripts/manage_database.py
```

Le script permet de choisir les actions a realiser : editer une database existante,
creer une nouvelle database, importer depuis une liste Letterboxd, supprimer les
doublons, recalculer la rarete des cartes et importer les posters manquants.
Pour les posters, creer une cle TMDb puis lancer le script avec une des variables :

```bash
TMDB_API_KEY=ta_cle python3 scripts/manage_database.py
TMDB_READ_TOKEN=ton_token python3 scripts/manage_database.py
```

## Notes v1

- Les comptes utilisent `username + cle de connexion`.
- La cle est affichee a la creation et stockee dans le navigateur courant.
- Les envois de cartes exigent un doublon cote expediteur.
- Les posters sont caches localement dans le dossier du dataset actif.
