# Photos à distance sur le Pearboard — conception

Date : 2026-10-12

## But

Envoyer, depuis un téléphone et de n'importe où, une photo accompagnée d'un texte
qui s'affiche en plein écran sur le Pearboard (Fire TV, écran vertical). La photo
reste affichée jusqu'à ce que quelqu'un appuie sur une touche de la télécommande.
Les photos s'accumulent : chaque appui passe à la suivante, puis le tableau revient.

## Décisions

| Sujet | Choix |
| --- | --- |
| Relais Internet | Worker Cloudflare (nouveau dossier `photo-relay/`), D1 pour les messages, R2 pour les photos |
| Protection de la page d'envoi | Cloudflare Access (code par courriel), JWT vérifié par le Worker |
| Accès de la TV | Jeton secret `TV_TOKEN`, interrogation toutes les 30 s |
| Après lecture | Marquée « vue » sur le serveur, gardée dans l'historique, suppression manuelle |
| Affichage | Plein écran, bandeau sombre en bas : texte, « de Tomy · il y a 5 min », « 1 / 3 » |

## Architecture

### 1. `photo-relay/` — Worker Cloudflare

Déployé avec `wrangler`. Un seul Worker sert :

- **La page d'envoi** `GET /` (derrière Cloudflare Access) : formulaire mobile et historique.
- **L'API de la page** (derrière Cloudflare Access) :
  - `POST /api/messages` : multipart, `photo` + `text` ; crée le message.
  - `GET /api/messages` : les 30 derniers, avec état.
  - `GET /api/photo/<id>` : la photo (vignettes de l'historique).
  - `DELETE /api/messages/<id>` : supprime le message et sa photo.
- **L'API de la TV** `/api/tv/…` (exclue d'Access, jeton `Authorization: Bearer <TV_TOKEN>`) :
  - `GET /api/tv/messages` : messages non vus, du plus ancien au plus récent.
  - `GET /api/tv/photo/<id>` : la photo.
  - `POST /api/tv/messages/<id>/seen` : marque vue (idempotent).

Stockage :

- D1, table `messages` : `id` (TEXT, aléatoire), `text`, `author`, `photo_key`,
  `content_type`, `created_at`, `seen_at` (NULL tant que non vue).
- R2 : un objet par photo, clé `photos/<id>`.

Configuration du Worker (`wrangler.toml` + secrets) :

- `TV_TOKEN` (secret) : jeton de la TV.
- `ACCESS_TEAM_DOMAIN` et `ACCESS_AUD` : pour vérifier le JWT Cloudflare Access.
- `AUTHORS` : correspondance courriel → prénom (`tomy@…=Tomy;…`). Courriel inconnu :
  partie avant le `@`.

### 2. Page d'envoi

- Bouton « Choisir une photo » (`<input type="file" accept="image/*">`, ouvre
  l'appareil photo ou la galerie), aperçu, champ texte (200 caractères max),
  bouton « Envoyer au Pearboard ».
- Avant l'envoi, le navigateur du téléphone redresse la photo (orientation EXIF),
  la réduit à 1080×1920 max et la recompresse en JPEG (~300 Ko).
- Historique : vignette, texte, auteur, « En attente » ou « Vue le 12 oct. à 19 h 04 »,
  bouton « Supprimer ».

### 3. App Android

- `local.properties` : `PHOTOS_URL` (adresse du Worker) et `PHOTOS_TOKEN`.
  Vers `BuildConfig`, jamais vers le JavaScript. `config.js` indique seulement si la
  fonction est activée.
- Kotlin relaie, comme pour le calendrier : la page appelle `/photos/messages`,
  `/photos/photo/<id>`, `/photos/seen/<id>` sur le domaine des assets ; Kotlin ajoute
  le jeton et transmet au Worker.
- La page interroge toutes les 30 s et gère la file.

## Comportement sur la TV

- **Arrivée** : nouveaux messages non vus → la photo est préchargée en entier, puis
  affichée en plein écran par-dessus le tableau.
- **Mise en page** : photo recadrée pour remplir l'écran vertical ; bandeau dégradé
  sombre en bas (sombre aussi en mode jour) avec le texte en grand, « de Tomy · il y a
  5 min », et « 1 / 3 » s'il en reste d'autres.
- **Télécommande** : n'importe quelle touche (flèches, OK, Retour, Menu, Lecture/Pause)
  passe à la suivante et marque la précédente « vue ». Cet appui ne fait rien d'autre
  (ne bouge pas le calendrier, ne quitte pas l'app). Après la dernière : retour au tableau.
- **Ordre** : du plus ancien au plus récent ; une arrivée pendant l'affichage s'ajoute
  à la fin de la file (le compteur se met à jour).
- **Durée** : indéfinie ; le retour automatique à aujourd'hui (5 min) ne ferme pas la photo.
- **Redémarrage** : les photos non vues sont sur le serveur et réapparaissent.
- **« Vue » qui échoue** : l'id reste en mémoire, renvoyé à chaque interrogation ; la
  photo n'est pas réaffichée entre-temps. Si l'app redémarre avant l'envoi, elle
  réapparaît une fois (acceptable).

## Erreurs et sécurité

- Le Worker vérifie la signature du JWT Access (`Cf-Access-Jwt-Assertion`) avec les
  clés publiques de l'équipe ; sinon 403. Aucune photo n'est publique.
- Jeton TV refusé (401) : petit avertissement « Photos : jeton refusé » dans le tableau.
- Serveur injoignable / 5xx : réessai silencieux à la prochaine interrogation.
- Photo qui ne se charge pas : sautée pour ce tour, non marquée vue.
- Sans `PHOTOS_URL` : fonction désactivée, aucun message.
- Limites serveur : 2 Mo par photo, JPEG / PNG / WebP, 200 caractères de texte.
- Fuite de l'APK : changer `TV_TOKEN` côté Worker et `PHOTOS_TOKEN` côté TV.

## Tests

- **Worker** : Vitest + `@cloudflare/vitest-pool-workers` (D1 et R2 simulés) : jeton
  refusé, JWT absent ou invalide, création, liste des non-vus, marquage vu idempotent,
  suppression, limites de taille, de type et de texte.
- **Page TV** : la file (ordre, arrivée pendant l'affichage, « vue » en attente de
  renvoi) dans un module à part, testé avec `node --test`, et soumis aux tests de
  compatibilité vieux WebView existants.
- **Bout en bout** : envoi réel depuis le téléphone, affichage et défilement sur la TV.

## Mise en place (une fois, par l'utilisateur)

Compte Cloudflare, `wrangler login`, création de D1 et R2, application Cloudflare
Access sur le domaine du Worker (en excluant `/api/tv/*`), secrets. Les commandes
exactes seront dans `photo-relay/README.md`.

Coût : nul dans l'offre gratuite (Workers, D1, R2 ≤ 10 Go, Access ≤ 50 personnes).
