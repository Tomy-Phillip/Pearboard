# Pearboard Android TV Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Archive the Raspberry Pi kiosk in `kiosk-board/` and build `android-board/`, an Android TV (Fire OS) app that shows the same dashboard with a read-only Google Calendar fed by the secret iCal URL.

**Architecture:** A one-activity Kotlin app hosts a full-screen `WebView`. `WebViewAssetLoader` serves the web UI from `assets/web/` at `https://appassets.androidplatform.net/web/`. The same client intercepts `/calendar.ics` and downloads `BuildConfig.ICAL_URL` natively, so the secret URL never reaches JS and CORS never applies. The web UI is the kiosk's HTML/CSS/JS with OAuth, the add-event form, the photo picker and auto-update removed, plus iCal parsing (`ical.js` + `calendar-ics.js`) and D-pad navigation.

**Tech Stack:** Kotlin 1.9.24, AGP 8.5.2, Gradle 8.7, `androidx.webkit:webkit:1.11.0`, minSdk 25 / target 35, ical.js 1.5.0 (vendored), Node 22 `node --test`.

**Design doc:** `docs/plans/2026-10-11-android-tv-board-design.md`

**Environment facts (this PC):**
- SDK: `%LOCALAPPDATA%\Android\Sdk` (platforms 28–35, build-tools 35.0.0). `adb` = `$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe` (not on PATH).
- JDK 17 on PATH (Android Studio JBR). Gradle 8.3 cached in `~/.gradle/wrapper/dists/gradle-8.3-all/` (used once to generate the 8.7 wrapper).
- Node v22, Python with Pillow 11.
- Emulators: only `Medium_Phone_API_35` (no Android TV image).
- Work happens on branch `feature/android-board`.

Every commit message ends with:
```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 1: Archive the Pi project in `kiosk-board/`

**Files:**
- Move: `README.md app.js dashboard.service image.png index.html pearboard-update.service pearboard-update.timer server.py setup.sh style.css update.sh` → `kiosk-board/`
- Create: `README.md` (new root README)
- Modify: `kiosk-board/README.md` (archive note at the top)

**Step 1: Move with history**

```bash
cd /c/Users/hout2601/Documents/Pearboard
mkdir kiosk-board
git mv README.md app.js dashboard.service image.png index.html pearboard-update.service pearboard-update.timer server.py setup.sh style.css update.sh kiosk-board/
git status --short
```
Expected: 11 `R` (renamed) lines. `.gitattributes`, `.gitignore`, `docs/` stay at the root.

**Step 2: Add the archive note** at the very top of `kiosk-board/README.md`, above `# Pearboard`:

```markdown
> **Archivé.** Ce projet tournait sur un Raspberry Pi en mode kiosque. Il est remplacé par l'app Android TV dans [`../android-board`](../android-board). Les chemins `/home/tomy/Pearboard/...` des services systemd datent d'avant ce déplacement et n'ont pas été mis à jour.
```

**Step 3: Write the root `README.md`**

```markdown
# Pearboard

Tableau de bord plein écran : horloge, météo (Open-Meteo, Montréal) et calendrier Google.

| Dossier | Contenu |
| --- | --- |
| [`android-board/`](android-board) | App Android TV pour Fire TV / Fire OS (projet actif) |
| [`kiosk-board/`](kiosk-board) | Ancienne version Raspberry Pi + Chromium kiosque (archivée) |
| [`docs/plans/`](docs/plans) | Documents de design et plans d'implémentation |
```

**Step 4: Commit**

```bash
git add -A
git commit -m "Archive Pi kiosk project in kiosk-board/

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Scaffold the Android project (builds an empty TV app)

**Files:**
- Create: `android-board/.gitignore`, `android-board/settings.gradle.kts`, `android-board/build.gradle.kts`, `android-board/gradle.properties`, `android-board/gradlew`, `android-board/gradlew.bat`, `android-board/gradle/wrapper/*`
- Create: `android-board/app/build.gradle.kts`, `android-board/app/src/main/AndroidManifest.xml`, `android-board/app/src/main/java/com/pearboard/tv/MainActivity.kt`
- Create: `android-board/app/src/main/res/drawable-xhdpi/banner.png`, `android-board/app/src/main/res/mipmap-xhdpi/ic_launcher.png`
- Create (ignored): `android-board/local.properties`

**Step 1: `android-board/.gitignore`**

```gitignore
.gradle/
build/
.idea/
*.iml
local.properties
node_modules/
# Optional clock background, bundled at build time (personal photo, never committed)
photo.jpg
```

**Step 2: `android-board/settings.gradle.kts`**

```kotlin
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "android-board"
include(":app")
```

**Step 3: Generate the Gradle 8.7 wrapper** using the cached Gradle 8.3. Do this *before* the build scripts exist, so the `wrapper` task does not have to resolve AGP:

```bash
cd /c/Users/hout2601/Documents/Pearboard/android-board
G=$(ls -d ~/.gradle/wrapper/dists/gradle-8.3-all/*/gradle-8.3)
"$G/bin/gradle" wrapper --gradle-version 8.7 --distribution-type bin
ls gradlew gradlew.bat gradle/wrapper/
```
Expected: `gradlew`, `gradlew.bat`, `gradle-wrapper.jar`, `gradle-wrapper.properties`. Delete any `build/` or `.gradle/` this creates (both are ignored anyway).

**Step 4: Root `android-board/build.gradle.kts`**

```kotlin
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
```

**Step 5: `android-board/gradle.properties`**

```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.code.style=official
```

**Step 6: `android-board/app/build.gradle.kts`** (ICAL_URL and photo wiring come in Task 6)

```kotlin
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.pearboard.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pearboard.tv"
        minSdk = 25 // Fire OS 6
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
```

**Step 7: `android-board/app/src/main/AndroidManifest.xml`**

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-permission android:name="android.permission.INTERNET" />

    <!-- TV app, but installable anywhere (phone emulator for quick checks). -->
    <uses-feature android:name="android.software.leanback" android:required="false" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />

    <application
        android:allowBackup="false"
        android:banner="@drawable/banner"
        android:icon="@mipmap/ic_launcher"
        android:label="Pearboard"
        android:theme="@android:style/Theme.NoTitleBar.Fullscreen">

        <activity
            android:name=".MainActivity"
            android:configChanges="keyboard|keyboardHidden|navigation|orientation|screenLayout|screenSize|uiMode"
            android:exported="true"
            android:screenOrientation="landscape">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

**Step 8: Minimal `MainActivity.kt`.** It loads a placeholder page for now; the web assets arrive in Task 3.

```kotlin
package com.pearboard.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebView

class MainActivity : Activity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
        }
        setContentView(webView)
        webView.loadData("<h1>Pearboard</h1>", "text/html", "utf-8")
    }
}
```

**Step 9: Generate the launcher icon and the TV banner** (from the repo root):

```bash
python - <<'EOF'
from PIL import Image, ImageDraw, ImageFont
base = "android-board/app/src/main/res"
import os
os.makedirs(f"{base}/drawable-xhdpi", exist_ok=True)
os.makedirs(f"{base}/mipmap-xhdpi", exist_ok=True)

BG, RED, WHITE = (13, 14, 21), (222, 42, 63), (255, 255, 255)

banner = Image.new("RGB", (320, 180), BG)
d = ImageDraw.Draw(banner)
d.rounded_rectangle((24, 54, 96, 126), radius=12, fill=RED)
d.text((60, 90), "31", font=ImageFont.truetype("arialbd.ttf", 34), fill=WHITE, anchor="mm")
d.text((116, 90), "Pearboard", font=ImageFont.truetype("arial.ttf", 38), fill=WHITE, anchor="lm")
banner.save(f"{base}/drawable-xhdpi/banner.png")

icon = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
d = ImageDraw.Draw(icon)
d.rounded_rectangle((4, 4, 92, 92), radius=18, fill=RED)
d.text((48, 50), "31", font=ImageFont.truetype("arialbd.ttf", 44), fill=WHITE, anchor="mm")
icon.save(f"{base}/mipmap-xhdpi/ic_launcher.png")
EOF
```
Open both PNGs with the Read tool and check them by eye.

**Step 10: Create `android-board/local.properties`** (ignored by git):

```properties
sdk.dir=C\:\\Users\\hout2601\\AppData\\Local\\Android\\Sdk
```

**Step 11: Build**

```bash
cd /c/Users/hout2601/Documents/Pearboard/android-board
./gradlew assembleDebug
```
Expected: `BUILD SUCCESSFUL` and `app/build/outputs/apk/debug/app-debug.apk` exists. The first run downloads Gradle 8.7, AGP and maybe build-tools 34, so it takes a few minutes.

**Step 12: Commit** after checking that `git status` does not list `local.properties` or `build/`.

```bash
cd /c/Users/hout2601/Documents/Pearboard
git add android-board
git status --short
git commit -m "Scaffold android-board Android TV project

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Copy the kiosk web UI verbatim into the assets

This task is a pure copy, so later diffs show only the TV changes.

**Files:**
- Create: `android-board/app/src/main/assets/web/{index.html,app.js,style.css}` (copies of `kiosk-board/`)

**Step 1: Copy**

```bash
cd /c/Users/hout2601/Documents/Pearboard
mkdir -p android-board/app/src/main/assets/web
cp kiosk-board/index.html kiosk-board/app.js kiosk-board/style.css android-board/app/src/main/assets/web/
```

**Step 2: Commit**

```bash
git add android-board/app/src/main/assets
git commit -m "Copy kiosk web UI into android-board assets (unchanged)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Node tooling and vendored ical.js

**Files:**
- Create: `android-board/package.json`
- Create: `android-board/app/src/main/assets/web/ical.js` (vendored from npm)

**Step 1: `android-board/package.json`**

```json
{
  "name": "pearboard-android-board-web",
  "private": true,
  "description": "Dev tooling for the web UI bundled in the Android TV app",
  "scripts": {
    "test": "node --test test/",
    "dev": "node dev-server.js",
    "vendor": "node -e \"require('fs').copyFileSync('node_modules/ical.js/build/ical.js','app/src/main/assets/web/ical.js')\""
  },
  "devDependencies": {
    "ical.js": "1.5.0"
  }
}
```

**Step 2: Install and vendor**

```bash
cd /c/Users/hout2601/Documents/Pearboard/android-board
npm install
npm run vendor
head -5 app/src/main/assets/web/ical.js
node -e "const ICAL=require('./app/src/main/assets/web/ical.js'); console.log(typeof ICAL.parse, typeof ICAL.Event)"
```
Expected: an MPL license header, then `function function`.

**Step 3: Commit** `package.json`, `package-lock.json` and `ical.js`. `node_modules/` is ignored.

```bash
cd /c/Users/hout2601/Documents/Pearboard
git add android-board/package.json android-board/package-lock.json android-board/app/src/main/assets/web/ical.js
git commit -m "Vendor ical.js 1.5.0 for iCal parsing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `calendar-ics.js`, iCal feed to Google-API-shaped events (TDD)

`app.js` already works with Google Calendar API event objects: `{ summary, start: { dateTime | date }, end: { dateTime | date } }`. This module produces exactly that from an ICS text, so the grid, day panel and upcoming list stay unchanged.

API:
- `CalendarIcs.parse(icsText)` returns `{ between(rangeStart: Date, rangeEnd: Date) => Event[] }`. It throws on text that is not iCalendar.
- `between` returns every occurrence that overlaps `[rangeStart, rangeEnd)`, sorted by start. Timed events give `dateTime` as a UTC ISO string. All-day events give `date` as `YYYY-MM-DD`, and the end date is exclusive, as in Google.

**Files:**
- Create: `android-board/test/calendar-ics.test.js`
- Create: `android-board/app/src/main/assets/web/calendar-ics.js`

**Step 1: Write the failing tests**

```js
"use strict";

// Fix the zone before any Date is created: all-day ranges are local-midnight based.
process.env.TZ = "America/Toronto";

const test = require("node:test");
const assert = require("node:assert/strict");
const CalendarIcs = require("../app/src/main/assets/web/calendar-ics.js");

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Toronto",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

const vevent = (...lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const ics = (...events) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//pearboard//test//EN", VTIMEZONE, ...events, "END:VCALENDAR"]
    .join("\r\n");

const OCT_START = new Date(2026, 9, 1);
const OCT_END = new Date(2026, 10, 1);
const october = (text) => CalendarIcs.parse(text).between(OCT_START, OCT_END);

test("timed event with TZID becomes UTC dateTime", () => {
  const evs = october(ics(vevent(
    "UID:a", "SUMMARY:Dentiste",
    "DTSTART;TZID=America/Toronto:20261015T090000",
    "DTEND;TZID=America/Toronto:20261015T100000",
  )));
  assert.deepEqual(evs, [{
    summary: "Dentiste",
    start: { dateTime: "2026-10-15T13:00:00.000Z" },
    end: { dateTime: "2026-10-15T14:00:00.000Z" },
  }]);
});

test("all-day event keeps date strings with exclusive end", () => {
  const evs = october(ics(vevent(
    "UID:b", "SUMMARY:Congé",
    "DTSTART;VALUE=DATE:20261020", "DTEND;VALUE=DATE:20261021",
  )));
  assert.deepEqual(evs, [{
    summary: "Congé",
    start: { date: "2026-10-20" },
    end: { date: "2026-10-21" },
  }]);
});

test("multi-day event starting before the range is included", () => {
  const evs = october(ics(vevent(
    "UID:c", "SUMMARY:Voyage",
    "DTSTART;VALUE=DATE:20260929", "DTEND;VALUE=DATE:20261003",
  )));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].summary, "Voyage");
});

test("events outside the range are excluded", () => {
  const evs = october(ics(vevent(
    "UID:d", "SUMMARY:Noël",
    "DTSTART;VALUE=DATE:20261225", "DTEND;VALUE=DATE:20261226",
  )));
  assert.deepEqual(evs, []);
});

test("weekly recurrence honours EXDATE and the range end", () => {
  const evs = october(ics(vevent(
    "UID:e", "SUMMARY:Hockey",
    "DTSTART;TZID=America/Toronto:20261005T180000",
    "DTEND;TZID=America/Toronto:20261005T193000",
    "RRULE:FREQ=WEEKLY",
    "EXDATE;TZID=America/Toronto:20261012T180000",
  )));
  assert.deepEqual(evs.map(e => e.start.dateTime), [
    "2026-10-05T22:00:00.000Z",
    "2026-10-19T22:00:00.000Z",
    "2026-10-26T22:00:00.000Z",
  ]);
});

test("moved occurrence (RECURRENCE-ID) replaces the original slot", () => {
  const evs = october(ics(
    // Exception listed before its master, as Google sometimes does.
    vevent(
      "UID:f", "SUMMARY:Cours (déplacé)",
      "RECURRENCE-ID;TZID=America/Toronto:20261008T120000",
      "DTSTART;TZID=America/Toronto:20261009T150000",
      "DTEND;TZID=America/Toronto:20261009T160000",
    ),
    vevent(
      "UID:f", "SUMMARY:Cours",
      "DTSTART;TZID=America/Toronto:20261001T120000",
      "DTEND;TZID=America/Toronto:20261001T130000",
      "RRULE:FREQ=WEEKLY;COUNT=3",
    ),
  ));
  assert.deepEqual(evs.map(e => [e.summary, e.start.dateTime]), [
    ["Cours", "2026-10-01T16:00:00.000Z"],
    ["Cours (déplacé)", "2026-10-09T19:00:00.000Z"],
    ["Cours", "2026-10-15T16:00:00.000Z"],
  ]);
});

test("cancelled occurrences and cancelled events are skipped", () => {
  const evs = october(ics(
    vevent(
      "UID:g", "SUMMARY:Yoga",
      "DTSTART;TZID=America/Toronto:20261002T070000",
      "DTEND;TZID=America/Toronto:20261002T080000",
      "RRULE:FREQ=WEEKLY;COUNT=2",
    ),
    vevent(
      "UID:g", "SUMMARY:Yoga", "STATUS:CANCELLED",
      "RECURRENCE-ID;TZID=America/Toronto:20261009T070000",
      "DTSTART;TZID=America/Toronto:20261009T070000",
      "DTEND;TZID=America/Toronto:20261009T080000",
    ),
    vevent(
      "UID:h", "SUMMARY:Annulé", "STATUS:CANCELLED",
      "DTSTART;VALUE=DATE:20261014", "DTEND;VALUE=DATE:20261015",
    ),
  ));
  assert.deepEqual(evs.map(e => e.start.dateTime), ["2026-10-02T11:00:00.000Z"]);
});

test("results are sorted by start", () => {
  const evs = october(ics(
    vevent("UID:i", "SUMMARY:B", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013"),
    vevent("UID:j", "SUMMARY:A", "DTSTART;VALUE=DATE:20261011", "DTEND;VALUE=DATE:20261012"),
  ));
  assert.deepEqual(evs.map(e => e.summary), ["A", "B"]);
});

test("non-iCalendar text throws", () => {
  assert.throws(() => CalendarIcs.parse("<html>Not found</html>"));
});
```

**Step 2: Run the tests and watch them fail**

Run: `cd android-board && npm test`
Expected: FAIL with `Cannot find module '../app/src/main/assets/web/calendar-ics.js'`.

**Step 3: Implement `android-board/app/src/main/assets/web/calendar-ics.js`**

```js
/* Turns a Google Calendar iCal feed into the event shape app.js already uses
 * (Google Calendar API style: { summary, start: {dateTime|date}, end: {...} }).
 * Loads as a plain <script> in the WebView (global ICAL → global CalendarIcs)
 * and through require() in Node for the tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./ical.js"));
  } else {
    root.CalendarIcs = factory(root.ICAL);
  }
})(typeof self !== "undefined" ? self : this, function (ICAL) {
  "use strict";

  // Safety cap per recurring event: a daily event started decades ago still fits.
  const MAX_OCCURRENCES = 20000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function parse(icsText) {
    const jcal = ICAL.parse(icsText);
    if (!Array.isArray(jcal) || jcal[0] !== "vcalendar") {
      throw new Error("Not an iCalendar feed");
    }
    const cal = new ICAL.Component(jcal);
    for (const tz of cal.getAllSubcomponents("vtimezone")) {
      ICAL.TimezoneService.register(tz);
    }

    // Exceptions (RECURRENCE-ID) may appear before their master in the feed.
    const masters = [];
    const exceptionsByUid = new Map();
    for (const vevent of cal.getAllSubcomponents("vevent")) {
      if (vevent.hasProperty("recurrence-id")) {
        const uid = vevent.getFirstPropertyValue("uid");
        if (!exceptionsByUid.has(uid)) exceptionsByUid.set(uid, []);
        exceptionsByUid.get(uid).push(vevent);
      } else {
        masters.push(vevent);
      }
    }
    const events = masters.map((vevent) => new ICAL.Event(vevent, {
      exceptions: exceptionsByUid.get(vevent.getFirstPropertyValue("uid")) || [],
    }));

    return { between: (rangeStart, rangeEnd) => between(events, rangeStart, rangeEnd) };
  }

  function between(events, rangeStart, rangeEnd) {
    const found = [];
    for (const event of events) {
      if (isCancelled(event)) continue;
      if (!event.isRecurring()) {
        collect(found, event, event.startDate, event.endDate, rangeStart, rangeEnd);
        continue;
      }
      // Pad by a day: ical.js compares all-day dates as UTC midnight.
      const stop = ICAL.Time.fromJSDate(new Date(rangeEnd.getTime() + DAY_MS), true);
      const it = event.iterator();
      let next;
      let count = 0;
      while ((next = it.next()) && count++ < MAX_OCCURRENCES) {
        if (next.compare(stop) >= 0) break;
        const occ = event.getOccurrenceDetails(next);
        if (isCancelled(occ.item)) continue;
        collect(found, occ.item, occ.startDate, occ.endDate, rangeStart, rangeEnd);
      }
    }
    return found.sort((a, b) => a.startMs - b.startMs).map((f) => f.event);
  }

  function collect(found, item, startTime, endTime, rangeStart, rangeEnd) {
    const end = endTime || startTime;
    const startMs = toJsDate(startTime).getTime();
    const endMs = toJsDate(end).getTime();
    // [start, end) overlaps [rangeStart, rangeEnd); zero-length events count at their start.
    const overlaps = startMs < rangeEnd.getTime()
      && (endMs > rangeStart.getTime() || startMs >= rangeStart.getTime());
    if (!overlaps) return;
    found.push({
      startMs,
      event: { summary: item.summary || "", start: toApiTime(startTime), end: toApiTime(end) },
    });
  }

  function toJsDate(t) {
    return t.isDate ? new Date(t.year, t.month - 1, t.day) : t.toJSDate();
  }

  function toApiTime(t) {
    return t.isDate ? { date: t.toString() } : { dateTime: t.toJSDate().toISOString() };
  }

  function isCancelled(event) {
    return String(event.component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED";
  }

  return { parse };
});
```

**Step 4: Run the tests and watch them pass**

Run: `cd android-board && npm test`
Expected: `# pass 9`, `# fail 0`. If a test fails, fix `calendar-ics.js`, not the test (unless the test itself has a mistake: re-check the expected UTC offsets, EDT = -4 h in October).

**Step 5: Commit**

```bash
cd /c/Users/hout2601/Documents/Pearboard
git add android-board/test android-board/app/src/main/assets/web/calendar-ics.js
git commit -m "Add calendar-ics.js: iCal feed to Google-API-shaped events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Android shell (asset loader, iCal proxy, BuildConfig, photo)

**Files:**
- Modify: `android-board/app/build.gradle.kts`
- Modify: `android-board/app/src/main/java/com/pearboard/tv/MainActivity.kt`
- Create: `android-board/app/src/main/java/com/pearboard/tv/IcsProxy.kt`

**Step 1: `app/build.gradle.kts`.** Read `ICAL_URL` from `local.properties` and bundle `android-board/photo.jpg` if it exists. Full file:

```kotlin
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Secret Google Calendar iCal address: lives only in the ignored local.properties.
val localProps = Properties().apply {
    val f = rootProject.file("local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val icalUrl: String = localProps.getProperty("ICAL_URL", "").trim()
val photoAssetsDir = layout.buildDirectory.dir("generated/photo-assets")

android {
    namespace = "com.pearboard.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pearboard.tv"
        minSdk = 25 // Fire OS 6
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        val escaped = icalUrl.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "ICAL_URL", "\"$escaped\"")
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(photoAssetsDir)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

// Optional clock background: android-board/photo.jpg → assets/web/photo.jpg.
val copyPhoto by tasks.registering(Sync::class) {
    from(rootProject.file("photo.jpg"))
    into(photoAssetsDir.map { it.dir("web") })
}
tasks.named("preBuild") { dependsOn(copyPhoto) }

dependencies {
    implementation("androidx.webkit:webkit:1.11.0")
}
```

**Step 2: `IcsProxy.kt`**

```kotlin
package com.pearboard.tv

import android.util.Log
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Serves /calendar.ics to the web UI by downloading the secret Google Calendar
 * iCal address natively. Keeps the address out of JS and sidesteps CORS.
 *
 * 404 = no ICAL_URL configured at build time, 502 = download failed.
 */
object IcsProxy {
    private const val TAG = "IcsProxy"

    fun fetch(): WebResourceResponse {
        val icalUrl = BuildConfig.ICAL_URL
        if (icalUrl.isBlank()) return error(404, "Not configured")

        return try {
            val conn = URL(icalUrl).openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            try {
                val status = conn.responseCode
                if (status == HttpURLConnection.HTTP_OK) {
                    val body = conn.inputStream.use { it.readBytes() }
                    WebResourceResponse(
                        "text/calendar", "utf-8", 200, "OK",
                        mapOf("Cache-Control" to "no-store"),
                        ByteArrayInputStream(body),
                    )
                } else {
                    Log.w(TAG, "iCal download returned HTTP $status")
                    error(502, "Upstream $status")
                }
            } finally {
                conn.disconnect()
            }
        } catch (e: IOException) {
            Log.w(TAG, "iCal download failed", e)
            error(502, "Fetch failed")
        }
    }

    private fun error(code: Int, reason: String) = WebResourceResponse(
        "text/plain", "utf-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )
}
```

**Step 3: `MainActivity.kt`.** Full file. The Back-key bridge comes in Task 8.

```kotlin
package com.pearboard.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

class MainActivity : Activity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/web/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // localStorage caches (weather, iCal)
            // Honour <meta viewport width=1920> and scale the 1080p layout to the screen.
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            webViewClient = PearboardWebViewClient(assetLoader)
        }
        setContentView(webView)
        webView.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/web/index.html")
        webView.requestFocus()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private class PearboardWebViewClient(
        private val assetLoader: WebViewAssetLoader,
    ) : WebViewClient() {
        override fun shouldInterceptRequest(
            view: WebView,
            request: WebResourceRequest,
        ): WebResourceResponse? {
            val url = request.url
            if (url.host == WebViewAssetLoader.DEFAULT_DOMAIN && url.path == "/calendar.ics") {
                return IcsProxy.fetch()
            }
            return assetLoader.shouldInterceptRequest(url)
        }
    }
}
```

**Step 4: Build**

Run: `cd android-board && ./gradlew assembleDebug`
Expected: `BUILD SUCCESSFUL`. Then confirm the empty default:
`grep ICAL_URL app/build/generated/source/buildConfig/debug/com/pearboard/tv/BuildConfig.java` shows `ICAL_URL = ""`.

**Step 5: Check that the photo gets copied.** Put any JPEG at `android-board/photo.jpg`, run `./gradlew assembleDebug`, check that `unzip -l app/build/outputs/apk/debug/app-debug.apk | grep photo.jpg` prints `assets/web/photo.jpg`, then delete the test photo and run `./gradlew clean`.

**Step 6: Commit**

```bash
cd /c/Users/hout2601/Documents/Pearboard
git add android-board/app
git commit -m "Serve web assets and proxy the iCal feed from MainActivity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Adapt the web UI (iCal instead of OAuth, strip unused features)

All paths are under `android-board/app/src/main/assets/web/`. Remove everything tied to OAuth, adding events, the photo picker and `version.txt`, then wire in `calendar-ics.js`.

**Files:**
- Modify: `index.html`, `style.css`, `app.js`
- Create: `android-board/dev-server.js`, `android-board/test/fixtures/sample.ics`

**Step 1: `index.html`**
- Delete the photo picker: the `#photo-settings` button, the `#photo-menu` div and the `#photo-input` input (kiosk lines 21–34).
- Fix the label: `<div class="notif-label">Aujourd'hui</div>`. The kiosk copy says "Aujourd'hui titi", left over from a test commit.
- Replace the `<h2 class="cal-title" ...>` line with:
  ```html
  <div class="cal-title-wrap">
    <h2 class="cal-title" id="cal-title">&nbsp;</h2>
    <div class="cal-status hidden" id="cal-status"></div>
  </div>
  ```
- In `#cal-overlay`, delete the `#cal-connect` button and change the message text to `Chargement du calendrier…`.
- In `#day-panel`, delete the `#day-add` button and the whole `<form id="day-form">`.
- Replace the two scripts at the end with:
  ```html
  <script src="ical.js" defer></script>
  <script src="calendar-ics.js" defer></script>
  <script src="app.js" defer></script>
  ```
  (The GIS `accounts.google.com/gsi/client` script goes away.)

**Step 2: `style.css`**
- Change the photo comment and default in `:root`:
  ```css
  /* --- Photo background ---
   * android-board/photo.jpg is bundled as assets/web/photo.jpg at build time.
   * When it's absent the url() layer fails to load and the gradient shows through.
   */
  --clock-photo: url('photo.jpg');
  ```
- Delete the "Photo picker" block (`.photo-settings` through `.photo-menu-btn:active`).
- Delete `.btn--add`/`.btn--add:active` and the whole form section (`/* Form */ .day-form` through `.form-actions .btn`, including the `input[...]:focus` rules and `.swatch*`).
- Add `.day-event-stripe.stripe--red { background: var(--bar-red); }` next to the other stripes. The kiosk only defined `--default`, so red stripes never showed.
- Add after `.cal-cell:active`:
  ```css
  /* D-pad focus — has to read from across the room */
  .cal-cell:focus {
    outline: 4px solid var(--text);
    outline-offset: -4px;
    background: var(--surface-2);
  }
  ```
- Add after `.cal-title`:
  ```css
  .cal-title-wrap { display: flex; flex-direction: column; align-items: center; gap: 2px; }

  .cal-status {
    font-size: 13px;
    color: var(--muted);
    letter-spacing: 0.04em;
  }
  ```
- Check with `grep -n "photo-settings\|photo-menu\|day-form\|swatch\|btn--add\|form-" style.css`: no output.

**Step 3: `app.js` (config, state, DOM)**
- `CONFIG`: delete `GOOGLE_CLIENT_ID`, `GOOGLE_SCOPE`, `CALENDAR_ID`, `TOKEN_REFRESH_BEFORE_MS`, `TIMEZONE` and `UPDATE_CHECK_MS` (with its comment). Add:
  ```js
  // Proxied by MainActivity (IcsProxy) — the secret iCal address never reaches JS.
  ICS_URL: "/calendar.ics",
  ICS_REFRESH_MS: 10 * 60 * 1000,
  ```
- `state`: delete `auth`. Change the `events` comment and add the new fields:
  ```js
  events: [],      // occurrences overlapping the 42-day grid of the viewed month
  todayEvents: [], // today's occurrences, for the "Aujourd'hui" list
  calendar: null,  // CalendarIcs.parse() result of the last good feed
  icsFetchedAt: 0,
  icsOffline: false,
  focusedDateKey: null, // 'YYYY-MM-DD' of the D-pad focused cell
  ```
- `dom`: delete `photoSettings…photoInput`, `calConnect`, `dayAdd` and every `form*` entry and `dayForm`. Add `calStatus: $("cal-status"),`.

**Step 4: `app.js` (delete whole sections)**
- The "Photo picker" section (`PHOTO_KEY` … `wirePhotoPicker`).
- The "Google auth (GIS token model)" section except `showCalendarOverlay` (keep it, with the default message changed to `"Chargement du calendrier…"`). Also delete `gcalFetch`.
- `fetchEventsForViewedMonth`.
- From the "Day panel + add-event form" section: `showForm`, `hideForm`, `selectSwatch`, `selectedColor`, `colorToGoogleId`, `showFormError`, `submitForm`. Rename the section header to `Day panel`.
- The "Auto-update" section and `waitForGis`.
- Check with `grep -n "gcal\|google\|requestToken\|photo\|Form\|version.txt\|GIS" app.js`: no output.

**Step 5: `app.js` (colors).** iCal feeds carry no per-event `colorId`, so replace `classifyEventColor` with:

```js
function classifyEventColor() {
  // iCal feeds don't carry Google's per-event colorId: everything uses the calendar red.
  return "red";
}
```

**Step 6: `app.js` (calendar data).** Add this block right after `changeMonth`'s section header comment, i.e. at the start of the "Calendar" section after `monthLabel`:

```js
function gridRange(y, m) {
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay()); // Sunday on or before the 1st
  const end = new Date(start);
  end.setDate(end.getDate() + 42);
  return [start, end];
}

function parseDateKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/* Recompute visible + today's occurrences from the parsed feed and re-render. */
function refreshEventsFromCalendar() {
  const [gridStart, gridEnd] = gridRange(state.viewedYear, state.viewedMonth);
  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  state.events = state.calendar ? state.calendar.between(gridStart, gridEnd) : [];
  state.todayEvents = state.calendar ? state.calendar.between(today, tomorrow) : [];

  renderCalendar();
  renderNotifications();
  if (state.selectedDateKey) renderDayPanelEvents(parseDateKey(state.selectedDateKey));
}

/* Throws (leaving state untouched) when the text isn't a valid iCal feed. */
function loadIcsText(text, fetchedAt) {
  state.calendar = CalendarIcs.parse(text);
  state.icsFetchedAt = fetchedAt;
  refreshEventsFromCalendar();
}

function formatAge(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.round(min / 60)} h`;
}

function renderCalendarStatus() {
  if (!state.icsOffline) {
    dom.calStatus.classList.add("hidden");
    return;
  }
  dom.calStatus.textContent = state.icsFetchedAt
    ? `Hors ligne · mis à jour il y a ${formatAge(Date.now() - state.icsFetchedAt)}`
    : "Hors ligne";
  dom.calStatus.classList.remove("hidden");
}

async function fetchCalendar() {
  try {
    const r = await fetch(CONFIG.ICS_URL, { cache: "no-store" });
    if (r.status === 404) {
      showCalendarOverlay(true, "Calendrier non configuré — voir README");
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    loadIcsText(text, Date.now());
    lsSet("ics_last", { text, fetchedAt: state.icsFetchedAt });
    state.icsOffline = false;
    showCalendarOverlay(false);
  } catch (err) {
    console.warn("[calendar] fetch failed:", err);
    state.icsOffline = true;
    if (state.calendar) showCalendarOverlay(false);
    else showCalendarOverlay(true, "Calendrier hors ligne");
  }
  renderCalendarStatus();
}

function startCalendar() {
  const cached = lsGet("ics_last");
  if (cached && cached.text) {
    try {
      loadIcsText(cached.text, cached.fetchedAt);
      showCalendarOverlay(false);
    } catch (err) {
      console.warn("[calendar] cached feed unreadable:", err);
    }
  }
  fetchCalendar();
  setInterval(fetchCalendar, CONFIG.ICS_REFRESH_MS);
}
```

**Step 7: `app.js` (existing functions)**
- `renderCalendar`: replace the `firstOfMonth`/`startWeekday`/`gridStart` lines with `const [gridStart] = gridRange(y, m);`. Change the cell click handler to:
  ```js
  cell.addEventListener("click", () => {
    state.focusedDateKey = cell.dataset.date;
    openDayPanel(cellDate);
  });
  ```
  and add `focusCell(state.focusedDateKey);` as the last line of the function. `focusCell` arrives in Task 8; until then, add a temporary stub `function focusCell() {}` that Task 8 replaces.
- `renderNotifications`: change `state.events` to `state.todayEvents`.
- `changeMonth`: replace the body after the month/year arithmetic with:
  ```js
  state.viewedMonth = m;
  state.viewedYear = y;
  state.focusedDateKey = dateKey(new Date(y, m, 1));
  refreshEventsFromCalendar();
  ```
- `openDayPanel`: delete the `hideForm()` call.
- `closeDayPanel`: delete `hideForm()` inside the timeout.
- `tickClock`: replace the minute-boundary block with:
  ```js
  if (now.getSeconds() === 0) {
    applyTheme();
    renderCalendarStatus();
    // Midnight: "today" moved — recompute today's list and the red square.
    if (now.getHours() === 0 && now.getMinutes() === 0) refreshEventsFromCalendar();
    else renderNotifications();
  }
  ```
- `wireEvents`: keep only `calPrev`, `calNext` and `dayPanelClose`.
- `init`: replace with:
  ```js
  function init() {
    const now = new Date();
    state.viewedYear = now.getFullYear();
    state.viewedMonth = now.getMonth();
    state.focusedDateKey = dateKey(now);

    applyTheme();            // pick a theme from the fallback hours immediately
    startClock();
    startWeather();
    wireEvents();
    showCalendarOverlay(true);
    refreshEventsFromCalendar(); // empty grid + list until the feed arrives
    startCalendar();
  }
  ```

**Step 8: Dev server.** `android-board/dev-server.js` serves the UI the way `MainActivity` does:

```js
// Serves the web UI the way MainActivity does, for working on it in a desktop browser:
// /web/* from the bundled assets, /calendar.ics from ICS_FILE (defaults to the sample).
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const WEB_DIR = path.join(__dirname, "app", "src", "main", "assets", "web");
const ICS_FILE = process.env.ICS_FILE || path.join(__dirname, "test", "fixtures", "sample.ics");
const PORT = Number(process.env.PORT) || 8123;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

function send(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" }).end(data);
  });
}

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname === "/calendar.ics") return send(res, ICS_FILE, "text/calendar");
  if (pathname.startsWith("/web/")) {
    const file = path.join(WEB_DIR, path.normalize(decodeURIComponent(pathname.slice(5))));
    if (file.startsWith(WEB_DIR + path.sep)) {
      return send(res, file, TYPES[path.extname(file)] || "application/octet-stream");
    }
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`http://localhost:${PORT}/web/index.html`));
```

**Step 9: Sample feed.** `android-board/test/fixtures/sample.ics` uses open-ended weekly rules, so it always has events in the current month. Use CRLF line endings, or let ical.js accept the LF that git produces on checkout (it does).

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//pearboard//sample//EN
BEGIN:VEVENT
UID:sample-hockey
SUMMARY:Hockey
DTSTART:20260105T230000Z
DTEND:20260106T003000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
BEGIN:VEVENT
UID:sample-standup
SUMMARY:Réunion d'équipe
DTSTART:20260106T140000Z
DTEND:20260106T143000Z
RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
END:VEVENT
BEGIN:VEVENT
UID:sample-market
SUMMARY:Marché
DTSTART;VALUE=DATE:20260110
DTEND;VALUE=DATE:20260111
RRULE:FREQ=WEEKLY;BYDAY=SA
END:VEVENT
END:VCALENDAR
```

**Step 10: Run the unit tests again**

Run: `cd android-board && npm test`. Expected: 9 pass.

**Step 11: Check in a browser**
- Start `npm run dev` in `android-board/` (in the background).
- With Playwright MCP, open `http://localhost:8123/web/index.html` at a 1920×1080 viewport and take a screenshot.
- Expected: clock and weather as in the kiosk; the calendar grid shows Hockey, Réunion and Marché bars; "Aujourd'hui" lists today's sample events (weekdays); no Connect button and no camera button; no console errors (`browser_console_messages`).
- Click a day and check that the panel opens read-only (no "+ Ajouter" button). Click × to close it.
- Restart with `ICS_FILE=nope npm run dev` and reload: the overlay reads "Calendrier hors ligne" and the status line reads "Hors ligne". Clear localStorage first (`localStorage.clear()`), otherwise the cached feed hides the overlay. That cached behavior is correct, so check it too: it shows "Hors ligne · mis à jour il y a …".

**Step 12: Commit**

```bash
cd /c/Users/hout2601/Documents/Pearboard
git add android-board
git commit -m "Read the calendar from the iCal feed; drop OAuth, add-event, photo picker and auto-update

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: D-pad navigation and the Back key

**Files:**
- Modify: `android-board/app/src/main/assets/web/app.js`
- Modify: `android-board/app/src/main/java/com/pearboard/tv/MainActivity.kt`

**Step 1: `app.js` (navigation section).** Replace the `focusCell` stub with a new section before "Wire up UI events":

```js
/* =========================================================================
 * Remote control (D-pad) — arrows move a day/week, OK opens, Back closes
 * ========================================================================= */

const KEY_STEPS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

function isDayPanelOpen() {
  return dom.dayPanel.classList.contains("is-open");
}

function focusCell(key) {
  const cell = key && dom.calGrid.querySelector(`[data-date="${key}"]`);
  if (cell) cell.focus({ preventScroll: true });
}

function moveFocus(days) {
  const d = parseDateKey(state.focusedDateKey);
  d.setDate(d.getDate() + days);
  state.focusedDateKey = dateKey(d);
  if (d.getMonth() !== state.viewedMonth || d.getFullYear() !== state.viewedYear) {
    state.viewedYear = d.getFullYear();
    state.viewedMonth = d.getMonth();
    refreshEventsFromCalendar(); // re-renders the grid, which restores focus
  } else {
    focusCell(state.focusedDateKey);
  }
}

function onKeyDown(e) {
  if (isDayPanelOpen()) {
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      closeDayPanel();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      dom.dayEvents.scrollBy({ top: e.key === "ArrowUp" ? -120 : 120 });
    } else if (e.key in KEY_STEPS) {
      e.preventDefault();
    }
    return;
  }
  if (e.key in KEY_STEPS) {
    // preventDefault also stops the WebView's own spatial navigation.
    e.preventDefault();
    moveFocus(KEY_STEPS[e.key]);
  } else if (e.key === "Enter") {
    // preventDefault stops the focused <button> from also firing a click.
    e.preventDefault();
    openDayPanel(parseDateKey(state.focusedDateKey));
  }
}

// Called by MainActivity on the remote's Back key. Returns true when consumed.
window.pearboardBack = () => {
  if (!isDayPanelOpen()) return false;
  closeDayPanel();
  return true;
};
```

**Step 2: `app.js` (wiring).**
- In `wireEvents`, add `document.addEventListener("keydown", onKeyDown);`.
- In `closeDayPanel`, call `focusCell(state.focusedDateKey);` inside the timeout, after `state.selectedDateKey = null;`.

**Step 3: `MainActivity.kt` (Back bridge).** Add inside the class, after `onCreate`:

```kotlin
    // Back closes the day panel when it's open; otherwise it leaves the app.
    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        webView.evaluateJavascript("window.pearboardBack ? window.pearboardBack() : false") { consumed ->
            if (consumed != "true") finish()
        }
    }
```

**Step 4: Check in the browser** (dev server + Playwright MCP, viewport 1920×1080):
1. Load the page: today's cell has the white outline.
2. Press `ArrowRight`: tomorrow is outlined. Press `ArrowDown`: a week later is outlined.
3. Press `ArrowUp` until you leave the month: the title changes to the previous month and the focus lands on the right date.
4. Press `Enter`: the panel opens for the focused date. Press `ArrowDown`: no change in grid focus. Press `Escape`: the panel closes and the outline is back on the same cell.
5. Run `window.pearboardBack()` with `browser_evaluate`: it returns `false` when closed and `true` (and closes) when open.
6. Take screenshots of steps 1 and 4 and check the outline is clearly visible in both themes. Force them with `document.documentElement.dataset.theme = "light"`.

**Step 5: Build**

Run: `cd android-board && ./gradlew assembleDebug`. Expected: `BUILD SUCCESSFUL`.

**Step 6: Commit**

```bash
cd /c/Users/hout2601/Documents/Pearboard
git add android-board
git commit -m "Add D-pad navigation and Back-key bridge for the TV remote

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: README and on-device check

**Files:**
- Create: `android-board/README.md`

**Step 1: Write `android-board/README.md`** (French, like the UI):

````markdown
# Pearboard — Android TV

Le tableau de bord Pearboard (horloge, météo, calendrier Google en lecture seule) en app Android TV pour Fire TV / téléviseurs Fire OS.

## Configuration (une fois)

1. **Adresse iCal secrète** : Google Agenda (sur ordinateur) → ⚙ Paramètres → votre agenda → *Intégrer l'agenda* → **Adresse secrète au format iCal**. Copiez-la.
2. Créez `android-board/local.properties` (jamais commité) :
   ```properties
   sdk.dir=C\:\\Users\\<vous>\\AppData\\Local\\Android\\Sdk
   ICAL_URL=https://calendar.google.com/calendar/ical/.../private-.../basic.ics
   ```
   Sans `ICAL_URL`, l'app fonctionne mais le calendrier affiche « Calendrier non configuré ».
3. **Photo (facultatif)** : déposez `android-board/photo.jpg`. Elle devient le fond de l'horloge. Pour l'enlever, supprimez-la puis `gradlew clean`.

> Google met à jour le flux iCal avec du retard (de quelques minutes à quelques heures). Les couleurs propres à chaque événement ne sont pas incluses dans le flux.

## Construire

```bash
cd android-board
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
```

## Installer sur la TV

1. TV : **Paramètres → Ma Fire TV → À propos** → cliquez 7 fois sur le nom de l'appareil pour activer les options pour les développeurs.
2. **Paramètres → Ma Fire TV → Options pour les développeurs → Débogage ADB : activé.** Notez l'adresse IP (*À propos → Réseau*).
3. Sur le PC (`adb` est dans `%LOCALAPPDATA%\Android\Sdk\platform-tools`) :
   ```bash
   adb connect <ip-de-la-tv>:5555     # acceptez l'invite sur la TV
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
4. L'app apparaît dans **Vos applications** (bannière Pearboard).

Pour mettre à jour : reconstruire, puis relancer `adb install -r …`.

## Télécommande

| Touche | Action |
| --- | --- |
| ← → | Jour précédent / suivant |
| ↑ ↓ | Semaine précédente / suivante (change de mois au besoin) |
| OK | Ouvre les événements du jour |
| Retour | Ferme le panneau, sinon quitte l'app |

## Développer l'interface sur PC

```bash
npm install
npm test          # tests du parseur iCal
npm run dev       # http://localhost:8123/web/index.html avec un calendrier d'exemple
ICS_FILE=/chemin/vers/mon.ics npm run dev   # avec un autre fichier .ics
```

Les flèches du clavier simulent la télécommande, et Échap simule Retour.
````

**Step 2: Check on a device.** Use an emulator, or the real TV if it is reachable.
- Android TV image (optional, ~1 GB): `"$LOCALAPPDATA/Android/Sdk/cmdline-tools/latest/bin/sdkmanager.bat" "system-images;android-34;android-tv;x86"`, then create an AVD with `avdmanager create avd -n tv34 -k "system-images;android-34;android-tv;x86" -d tv_1080p`. Otherwise use `Medium_Phone_API_35` rotated to landscape.
- `adb install -r app/build/outputs/apk/debug/app-debug.apk`, then `adb shell am start -n com.pearboard.tv/.MainActivity`.
- Check: full screen with no bars; layout scaled to the screen; arrows (`adb shell input keyevent DPAD_RIGHT`) move the focus; `DPAD_CENTER` opens the panel; `BACK` closes it, and a second `BACK` leaves the app.
- With a real `ICAL_URL` in `local.properties`: the user's events appear. `adb logcat -s IcsProxy` shows no errors.
- Report what could not be checked (for example, no real Fire TV available) instead of claiming it works.

**Step 3: Commit**

```bash
cd /c/Users/hout2601/Documents/Pearboard
git add android-board/README.md
git commit -m "Document android-board setup, build and Fire TV install

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Done when

- `git ls-files` shows the Pi files under `kiosk-board/` and none at the root besides `README.md`, `.gitattributes`, `.gitignore` and `docs/`.
- `npm test` passes 9/9. `./gradlew assembleDebug` succeeds.
- In the browser and on the emulator: dashboard renders, sample/real events appear, D-pad and Back behave as in the table above.
- No secret (`ICAL_URL`, `photo.jpg`, `local.properties`) is tracked: `git ls-files android-board | grep -i "local.properties\|photo.jpg"` prints nothing.
