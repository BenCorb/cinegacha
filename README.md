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

## Données utilisateur

La base utilisateurs vit dans `data/gachapon.sqlite`.
Le serveur cree automatiquement un backup toutes les heures dans `data/backups/`,
45 minutes apres l'heure pleine, et conserve les 24 derniers backups.

## Dataset

Le dataset actif vit dans `data/dataset/dataset.json`.

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

## Version et changelog

La version affichee dans l'app et le changelog vivent dans `static/version.json`.
Modifier ce fichier suffit pour publier une nouvelle note de version.

## Licence

CinéGacha est distribue sous licence GNU GPL v3 ou ulterieure.
Voir `LICENSE` pour le texte complet.
