# Pearboard — Android TV / Fire TV

App Android TV (`com.pearboard.tv`) qui affiche le tableau de bord en plein écran :
horloge, météo (Open-Meteo, Montréal) et calendrier Google en lecture seule.
L'interface est une page web (`app/src/main/assets/web/`) affichée dans une WebView,
conçue en 1920×1080 et mise à l'échelle de l'écran. Cible : Fire TV sous Fire OS 6
(≈ Android 7.1, API 25) ou plus récent.

## Configuration (une fois)

1. **Adresse iCal secrète** : dans Google Agenda sur ordinateur → ⚙ Paramètres →
   votre agenda (colonne de gauche) → *Intégrer l'agenda* → **Adresse secrète au format iCal**.
2. Mettez-la dans `android-board/local.properties` (ignoré par git, créé par Android Studio) :

   ```properties
   sdk.dir=C\:\\Users\\<vous>\\AppData\\Local\\Android\\Sdk
   ICAL_URL=https://calendar.google.com/calendar/ical/.../private-.../basic.ics
   ```

   Sans `ICAL_URL`, l'app fonctionne mais le calendrier affiche
   « Calendrier non configuré ».
3. **Photo (optionnelle)** : un fichier `android-board/photo.jpg` (ignoré par git) sert de
   fond à l'horloge. Pour la retirer : supprimez le fichier, puis `./gradlew clean` avant
   de reconstruire.

À savoir :

- Le flux iCal de Google a du retard (de quelques minutes à quelques heures) sur les
  modifications faites dans l'agenda, et ne contient pas les couleurs des événements.
  L'app le relit toutes les 10 minutes.
- **Ne partagez pas l'APK** : l'adresse secrète y est incluse et récupérable. Si elle a
  fuité, réinitialisez-la dans Google Agenda (même écran) et reconstruisez.

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

## Télécommande

| Touche | Action |
| --- | --- |
| ← / → | Jour précédent / suivant |
| ↑ / ↓ | Semaine précédente / suivante (change de mois au besoin) ; dans le panneau du jour, fait défiler la liste |
| OK | Ouvre les événements du jour sélectionné (lecture seule) ; referme le panneau s'il est ouvert |
| Retour | Ferme le panneau du jour ; sinon quitte l'app |

Sans aucune touche pendant 5 minutes, le panneau se ferme et l'affichage revient à
aujourd'hui.

## Développer l'interface sur PC

Node.js ≥ 21 requis. Depuis `android-board/` :

```bash
npm install
npm test        # tests (analyse iCal, compatibilité vieux WebView)
npm run dev     # http://localhost:8123/web/index.html avec un calendrier d'exemple
ICS_FILE=/chemin/vers/agenda.ics npm run dev   # avec un autre fichier .ics
```

Dans le navigateur, les flèches et Entrée simulent la télécommande, Échap simule Retour.
`npm run vendor` et `npm run vendor-fonts` recopient `ical.js` et les polices DM Sans /
DM Mono depuis `node_modules` vers les assets après une mise à jour de ces dépendances.

## Compatibilité vieux WebView

La WebView d'une vieille Fire TV peut être un Chromium ancien. Les assets web doivent
donc rester en JavaScript ES2017 (pas de `?.`, `??`, etc.) et le CSS doit éviter
`inset`, `gap` en flexbox et `clamp()`/`min()`/`max()`. `npm test` le vérifie.
