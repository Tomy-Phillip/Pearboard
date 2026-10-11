# Pearboard Android TV — Design

Date: 2026-10-11

## Goal

Replace the Raspberry Pi kiosk with a native Android TV app that runs directly on a Fire OS TV. The app shows the same dashboard as the kiosk: clock, weather and month calendar. The Pi is retired.

## Decisions

| Topic | Decision |
| --- | --- |
| Calendar | Read-only. Read the Google Calendar **secret iCal URL**. No OAuth, no adding events. |
| App type | Minimal Kotlin app with a full-screen `WebView` that renders web files bundled in the APK. |
| Updates | None automatic. The APK is installed manually with `adb`. |
| iCal URL | Injected at build time from `android-board/local.properties` (not versioned). |
| Clock photo | Optional `android-board/photo.jpg` (not versioned), copied into the assets at build time. |
| Pi | Abandoned. The old project is archived as-is in `kiosk-board/`. |

Why not OAuth: Google blocks its sign-in inside embedded WebViews (`disallowed_useragent`). Fire TV has no Google Play Services. The limited-input device flow does not allow Calendar scopes.

## Repository layout

```
Pearboard/
├── README.md            short overview of both projects
├── docs/plans/
├── kiosk-board/         former Pi project, moved with git mv (archived)
└── android-board/
    ├── app/src/main/
    │   ├── AndroidManifest.xml   LEANBACK_LAUNCHER, landscape, touchscreen not required
    │   ├── java/.../MainActivity.kt
    │   ├── assets/web/           index.html, app.js, calendar-ics.js, ical.js, style.css
    │   └── res/                  320×180 TV banner, icon
    ├── local.properties          (ignored) sdk.dir + ICAL_URL
    ├── photo.jpg                 (ignored, optional)
    └── README.md
```

The Pi's systemd units keep their hard-coded `/home/tomy/Pearboard` paths. They are archived, so nothing needs migrating.

## Android shell

- A single `MainActivity`: full-screen `WebView`, `FLAG_KEEP_SCREEN_ON`, system bars hidden.
- `WebViewAssetLoader` serves `assets/web/` on `https://appassets.androidplatform.net` (not `file://`).
- `minSdk 25` (Fire OS 6+). The only extra dependency is `androidx.webkit`.
- `shouldInterceptRequest` handles `/calendar.ics`: Kotlin downloads `BuildConfig.ICAL_URL` with `HttpURLConnection` and returns the body. This avoids CORS, and the secret URL never reaches the web code.
- Back key: Kotlin forwards it to JS. If JS used it (to close the day panel), it stops there. Otherwise the default behavior runs (leave the app).

## Data

- **Calendar:** `fetch("/calendar.ics")` every 10 minutes. Parsing uses vendored **ical.js** (Mozilla), which handles RRULE, EXDATE, RECURRENCE-ID, time zones and all-day events. `calendar-ics.js` expands the occurrences of the displayed range into the same objects the Google API returns today (`summary`, `start.dateTime` / `start.date`, …), so the grid, day panel and upcoming list barely change.
- The last valid ICS is cached in `localStorage` so the app can start offline.
- Known limits: Google's iCal feed can lag minutes to hours, and per-event colors are not in the feed (everything uses the calendar color).
- **Weather:** unchanged (Open-Meteo, CORS OK).
- **Removed:** Google Identity Services, tokens, the Connect button, the add-event form, the photo picker and the `version.txt` auto-reload.

## TV UI

- Viewport fixed at `width=1920`. The WebView scales the kiosk's 1080p layout to the TV.
- D-pad navigation in JS: at startup, focus is on today. Arrows move by one day or one week. Leaving the month changes month. OK opens the day panel (read-only). Back closes it.
- A thick, high-contrast focus outline that stays readable from 3 m.
- Photo: `--clock-photo` points to `photo.jpg` if it was bundled; otherwise the default background.
- The automatic day/night theme is unchanged.

## Errors

- Network or iCal failure: keep the cached data and show an "offline · updated X min ago" indicator.
- `ICAL_URL` missing at build: the calendar shows "Calendrier non configuré — voir README". The build does not fail, and the clock and weather still work.

## Tests

- `calendar-ics.js`: `node --test` on `.ics` fixtures covering a simple event, an all-day event, a multi-day event, a weekly recurrence with EXDATE, and a moved occurrence (RECURRENCE-ID).
- D-pad navigation: in the browser with Playwright and the keyboard arrows, then by hand on the Android TV emulator.
- Kotlin: manual check on the emulator (iCal proxy, Back key).

## Build and install

1. `gradlew assembleDebug` builds `app/build/outputs/apk/debug/app-debug.apk`.
2. On the TV: enable **ADB debugging** in the developer options and note the IP address.
3. `adb connect <ip>:5555` then `adb install -r app-debug.apk` (`adb` lives in `%LOCALAPPDATA%\Android\Sdk\platform-tools`).

## Out of scope

Automatic updates, adding events, OAuth, auto-launch when the TV turns on.
