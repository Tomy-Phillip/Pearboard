# Pearboard — Android TV / Fire TV

App Android TV (`com.pearboard.tv`) qui affiche le tableau de bord familial en plein
écran, pour une TV posée **à la verticale** : horloge, météo (Open-Meteo, Sherbrooke),
calendrier Google en lecture seule (un agenda par personne, chacun sa couleur) et
événements du jour. L'affichage passe en mode nuit (thème sombre) du coucher au lever
du soleil à Sherbrooke, et revient au thème clair le matin. L'interface est une page web (`app/src/main/assets/web/`) affichée
dans une WebView. Une Fire TV sort toujours une image horizontale : l'app dessine donc
le tableau en 1080×1920 et le fait pivoter d'un quart de tour pour qu'il soit droit une
fois la TV tournée. Cible : Fire TV sous Fire OS 6 (≈ Android 7.1, API 25) ou plus récent.

## Configuration (une fois)

1. **Adresses iCal secrètes** : pour chaque personne, dans Google Agenda sur ordinateur →
   ⚙ Paramètres → son agenda (colonne de gauche) → *Intégrer l'agenda* →
   **Adresse secrète au format iCal**.
2. Mettez-les dans `android-board/local.properties` (ignoré par git, créé par Android Studio) :

   ```properties
   sdk.dir=C\:\\Users\\<vous>\\AppData\\Local\\Android\\Sdk

   CAL_1_NAME=Tomy
   CAL_1_URL=https://calendar.google.com/calendar/ical/.../private-.../basic.ics
   CAL_2_NAME=Lily
   CAL_2_URL=https://calendar.google.com/calendar/ical/.../private-.../basic.ics
   CAL_2_COLOR=blue

   # Sens dans lequel la TV est tournée : ccw (anti-horaire, par défaut), cw (horaire)
   # ou none (pas de rotation).
   ROTATION=ccw
   ```

   - Numérotez à partir de 1 (`CAL_1_…`, `CAL_2_…`, … jusqu'à 20).
   - Le nom apparaît dans la légende et son initiale sur les événements du jour.
   - `CAL_n_COLOR` est facultatif : `red`, `green`, `blue`, `amber`, `purple` ou `teal`
     (sinon, dans cet ordre).
   - Une seule ligne `ICAL_URL=…` (l'ancienne configuration) marche encore : un agenda
     sans nom ni légende.
   - Sans aucun agenda, l'app fonctionne mais affiche « Calendrier non configuré ».
3. Si l'image est à l'envers une fois la TV tournée, inversez `ROTATION` (`ccw` ↔ `cw`)
   et reconstruisez.

À savoir :

- Le flux iCal de Google a du retard (de quelques minutes à quelques heures) sur les
  modifications faites dans l'agenda, et ne contient pas les couleurs des événements.
  L'app le relit toutes les 10 minutes.
- Un événement présent dans deux agendas (invitation partagée) apparaît deux fois, une
  fois par personne.
- **Ne partagez pas l'APK** : les adresses secrètes y sont incluses et récupérables,
  tout comme le jeton des photos (`PHOTOS_TOKEN`, voir plus bas). Si une adresse a
  fuité, réinitialisez-la dans Google Agenda (même écran) et reconstruisez ; pour le
  jeton, voir [Changer le jeton de la TV](../photo-relay/README.md#changer-le-jeton-de-la-tv).

## Construire

Depuis `android-board/` (JDK 17+ et SDK Android requis) :

```bash
./gradlew assembleDebug
```

L'APK est produit dans `app/build/outputs/apk/debug/app-debug.apk`.

## Installer sur la TV

1. Sur la Fire TV : Paramètres → Ma Fire TV → À propos → cliquez 7 fois sur le nom de
   l'appareil pour afficher les **Options pour les développeurs** (sur certains modèles
   plus anciens, elles sont déjà visibles dans Ma Fire TV).
2. Options pour les développeurs → **Débogage ADB** : activé.
3. Notez l'adresse IP de la TV : Ma Fire TV → À propos → Réseau.
4. Depuis le PC (même réseau) :

   ```bash
   adb connect <ip>:5555          # acceptez l'invite qui s'affiche sur la TV
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```

L'app apparaît dans « Vos applications ». Pour la mettre à jour : reconstruire, puis
relancer le même `adb install -r`.

## Photos à distance

Depuis le téléphone, on peut envoyer une photo (avec légende) qui s'affiche en plein
écran sur la TV. Les photos passent par un Worker Cloudflare : sa mise en place est
décrite dans [`photo-relay/README.md`](../photo-relay/README.md).

1. Une fois le Worker déployé, ajoutez deux lignes à `android-board/local.properties` :

   ```properties
   PHOTOS_URL=https://pearboard-photos.<sous-domaine>.workers.dev
   PHOTOS_TOKEN=<le TV_TOKEN du Worker>
   ```

2. Reconstruisez et réinstallez l'app.

- Sans `PHOTOS_URL`, la fonction est désactivée. `PHOTOS_URL` sans `PHOTOS_TOKEN` fait
  échouer la construction.
- La TV interroge le Worker toutes les 30 secondes : une photo envoyée apparaît donc en
  une trentaine de secondes.
- N'importe quelle touche de la télécommande (flèches, OK, Retour, Menu, Lecture/Pause)
  passe à la photo suivante. Après la dernière, le tableau revient.
- Une photo reste affichée tant qu'on n'appuie sur aucune touche : le retour automatique
  après 5 minutes ne la ferme pas.
- « Photos : jeton refusé » dans la carte de l'horloge signifie que `PHOTOS_TOKEN` et le
  `TV_TOKEN` du Worker diffèrent.

## Télécommande

| Touche | Action |
| --- | --- |
| ← / → | Jour précédent / suivant |
| ↑ / ↓ | Semaine précédente / suivante (change de mois ou de semaine au besoin) ; dans le panneau du jour, fait défiler la liste |
| OK | Ouvre les événements du jour sélectionné (lecture seule) ; referme le panneau s'il est ouvert |
| Menu (≡) ou Lecture/Pause | Bascule entre la vue Mois et la vue Semaine |
| Retour | Ferme le panneau du jour ; sinon quitte l'app |
| N'importe quelle touche (photo affichée) | Photo suivante ; après la dernière, retour au tableau |

Sans aucune touche pendant 5 minutes, le panneau se ferme et l'affichage revient au
mois en cours, sur aujourd'hui.

## Développer l'interface sur PC

Node.js ≥ 21 requis. Depuis `android-board/` :

```bash
npm install
npm test        # tests (analyse iCal, compatibilité vieux WebView)
npm run dev     # http://localhost:8123/web/index.html avec deux agendas d'exemple
DEV_CALENDARS="Tomy=/chemin/a.ics;Lily=/chemin/b.ics" npm run dev   # avec vos fichiers .ics
ROTATION=ccw npm run dev   # tourné comme sur la TV (par défaut : droit, en portrait)
DEV_PHOTOS=1 npm run dev   # avec deux photos d'exemple
```

Ajoutez `?theme=dark` ou `?theme=light` à l'adresse pour forcer un thème sans attendre
le coucher du soleil.

Dans le navigateur, les flèches et Entrée simulent la télécommande, Échap simule Retour
et `v` simule Menu (vue Mois / Semaine).
`npm run vendor` et `npm run vendor-fonts` recopient `ical.js` et les polices DM Sans /
DM Mono depuis `node_modules` vers les assets après une mise à jour de ces dépendances.

## Compatibilité vieux WebView

La WebView d'une vieille Fire TV peut être un Chromium ancien. Les assets web doivent
donc rester en JavaScript ES2017 (pas de `?.`, `??`, etc.) et le CSS doit éviter
`inset`, `gap` en flexbox et `clamp()`/`min()`/`max()`. `npm test` le vérifie.
