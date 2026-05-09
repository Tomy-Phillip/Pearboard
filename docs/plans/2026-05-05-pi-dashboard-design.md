# Raspberry Pi Touchscreen Dashboard — Design

**Date:** 2026-05-05
**Status:** Design approved, ready for implementation

## Goal

A fullscreen kiosk dashboard running on a Raspberry Pi 4 with a 15.6" 1920×1080 landscape touchscreen. Shows clock, weather (Montréal), and a Google-Calendar-backed month view. Touch-interactive: change months, tap a day to see and add events.

## Deployment target

- **Hardware:** Raspberry Pi 4
- **OS:** Raspberry Pi OS Desktop
- **Display:** 15.6" landscape touchscreen, 1920×1080
- **Browser:** Chromium in kiosk mode
- **Origin:** `http://localhost:8000` (served by `python3 -m http.server`, run as systemd service)
- **No build step** — pure static HTML/CSS/JS, edit-and-reload.

The brief originally called for `file://`. We moved to a localhost server because Google's OAuth 2.0 does not accept `file://` as an authorized JavaScript origin. `python3 -m http.server` keeps the spirit of "no server logic" (it just serves three files) while unblocking Google Calendar integration.

## Scope

In scope for v1:

- Live clock (HH:MM:SS, full date)
- Open-Meteo current weather for Montréal
- Month-view calendar populated from Google Calendar (read)
- Tap a day → see that day's events
- Tap ←/→ → navigate months
- Tap weather → force refresh
- Add an event from the day panel → writes to Google Calendar (write)

Out of scope for v1 (backlog):

- Event edit/delete
- Multiple Google calendars (uses `primary` only)
- Weather forecast beyond today
- Reminders / notifications
- Screen-on/off scheduling, burn-in protection
- Service worker / offline caching

## Architecture

### File layout

```
/home/tomy/Pearboard/
├── index.html         empty containers, one per widget
├── style.css          layout, theme tokens, widget styles
├── app.js             clock, weather, calendar, auth, add-event
├── dashboard.service  systemd unit for the static server
├── setup.sh           idempotent installer (optional)
└── README.md          one-time Google Cloud setup, runbook
```

### Runtime

- `python3 -m http.server 8000` runs as `dashboard.service` (`Restart=always`, working dir `/home/tomy/Pearboard`).
- Chromium launched at desktop start via `~/.config/lxsession/LXDE-pi/autostart`:
  ```
  chromium-browser --kiosk --noerrdialogs --disable-translate \
    --disable-features=Translate http://localhost:8000
  ```

### External dependencies (CDN, internet required)

- DM Sans + DM Mono via Google Fonts.
- Google Identity Services script (`https://accounts.google.com/gsi/client`) for sign-in.
- Google Calendar REST API v3 — called via `fetch`, no client library.
- Open-Meteo (no API key).

### State model

- DOM is render-only.
- A single `state` object in `app.js` holds: `viewedMonth`, `today`, `weather`, `events`, `auth`.
- Update functions mutate `state` then call render functions. No framework.

### Persistence (`localStorage`)

- `gcal_access_token`, `gcal_token_expiry`
- `gcal_calendar_id` (defaults to `primary`)
- Last-good weather payload with `fetchedAt` timestamp

## Visual system

### Theme tokens (`:root`)

```
--bg:        #0a0a0c
--surface:   #111116
--border:    #1e1e26
--text:      #ffffff
--muted:     #6b6b78
--accent:    #4a9eff   (blue)
--success:   #3ecf8e   (green)
--warn:      #f5a623   (amber)
--font-sans: 'DM Sans', system-ui, sans-serif
--font-mono: 'DM Mono', ui-monospace, monospace
```

### Layout

```
body {
  display: grid;
  grid-template-columns: 2fr 2fr 1.5fr;
  grid-template-rows: 360px 1fr;
  gap: 24px;
  padding: 32px;
  overflow: hidden;
}
* { cursor: none; }
```

- Clock: `grid-column: 1 / 3`, row 1
- Weather: `grid-column: 3 / 4`, row 1
- Calendar: `grid-column: 1 / 4`, row 2

### Widget container

```
.widget { background: var(--surface); border: 1px solid var(--border);
          border-radius: 8px; padding: 28px; }
.widget-label { color: var(--muted); font-size: 13px; letter-spacing: 0.08em;
                text-transform: uppercase; font-weight: 500; }
```

### Type scale (1080p)

| Element              | Size                      | Family   | Notes                       |
| -------------------- | ------------------------- | -------- | --------------------------- |
| Clock time           | `clamp(180px, 18vw, 240px)` | DM Mono  | tabular-nums, 500 weight    |
| Clock date           | 28px                      | DM Sans  | `--muted`                   |
| Weather temp         | 96px                      | DM Mono  |                             |
| Weather description  | 24px                      | DM Sans  |                             |
| Calendar day numbers | 22px                      | DM Mono  | `--muted` for off-month     |

### Touch targets

Every tappable element ≥ 56×56px. Calendar cells are ~150px tall on this layout.

### Motion

120ms opacity fade on widget content swap (fresh weather, month change). No shadows, no gradients.

## Widgets

### Clock

- `setInterval` aligned to wall-clock seconds. First tick: `setTimeout(fn, 1000 - Date.now() % 1000)`, then `setInterval(fn, 1000)`. Avoids visible 2-second jumps.
- Time format: 24h `HH:MM:SS`, DM Mono, `font-variant-numeric: tabular-nums`.
- Date format: `Tuesday, May 5, 2026` via `Intl.DateTimeFormat('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })`.

### Weather

- Endpoint:
  ```
  https://api.open-meteo.com/v1/forecast
    ?latitude=45.5088&longitude=-73.5878
    &current_weather=true
    &hourly=relativehumidity_2m
    &daily=temperature_2m_max,temperature_2m_min
    &timezone=America/Toronto&forecast_days=1
  ```
- Fetch on load, then every 5 minutes. Tap-to-refresh debounced to 10s.
- WMO code → description map covers all 27 codes Open-Meteo emits.
- Vertical stack: temp (96px) → description (24px) → row of three small stats (high/low, wind, humidity) in `--muted` 14px DM Mono.
- Humidity comes from `hourly.relativehumidity_2m[currentHourIndex]` (not present on `current_weather`).
- On error: keep last good payload from `localStorage`, prepend amber `•` to the "WEATHER" label.

### Calendar

- Header: `← May 2026 →`. Arrows are 56×56px tap targets, month name centered.
- Grid: 7 cols (Sun–Sat) × 6 rows (always 42 cells; out-of-month cells in `--muted`).
- Each cell: day number top-left; up to 3 colored dots bottom-center; "+N" chip if more.
- Tap a cell → opens the **Day panel** sliding up from bottom, full width, 40vh tall. Lists that day's events (time, title, color stripe), plus a "+ Add event" button.
- Today: inverted (white background, black text), no border accent.
- Events fetched from `calendar.events.list?timeMin=<first of viewed month>&timeMax=<first of next month>&singleEvents=true&orderBy=startTime`. Refetched on month change and after any add.

## Add-event flow

Trigger: "+ Add event" at the top of the Day panel. Date is pre-filled from panel context.

Form fields (~64px tall inputs, vertical stack):

1. **Title** — text. Required.
2. **All-day** — toggle. Default off.
3. **Start time** — `<input type="time">`. Default: next round half-hour after now (or 09:00 for future dates).
4. **End time** — same. Default: start + 1 hour.
5. **Color** — three swatches: blue / green / amber → Google Calendar `colorId` 9 / 10 / 5.
6. **Save** + **Cancel** — full-width split bottom buttons.

Hidden in v1: location, description, recurrence, attendees, reminders.

Submit:

1. Validate: title non-empty, end > start.
2. Body: `{ summary, start, end, colorId }`. `start`/`end` are `{ date: 'YYYY-MM-DD' }` (all-day) or `{ dateTime: ISO8601, timeZone: 'America/Toronto' }`.
3. `POST https://www.googleapis.com/calendar/v3/calendars/primary/events` with bearer token.
4. On 200: push returned event into `state.events`, re-render grid + panel, close form. No refetch.
5. On 401: silent refresh, retry once. If still 401: inline "Sign in expired — reconnect".
6. On other errors: keep form open, red 14px error under Save: "Couldn't save — check connection".

## Auth (Google Identity Services)

### One-time manual setup

1. Create a Google Cloud project.
2. Enable Google Calendar API.
3. Create an OAuth 2.0 Client ID, type "Web application".
4. Authorized JavaScript origin: `http://localhost:8000`.
5. Paste the client ID into `CONFIG.GOOGLE_CLIENT_ID` at the top of `app.js`.
6. Add your Gmail to "Test users" while the consent screen is unverified.

### Runtime

- Use the GIS **token model** (`google.accounts.oauth2.initTokenClient`).
- Scope: `https://www.googleapis.com/auth/calendar.events` (minimum needed).
- On load: read token from `localStorage`. If non-expired, use it.
- If absent or expired and silent refresh succeeds, use the new token.
- If silent refresh fails (`prompt: ''` returns no token), the calendar widget renders a **"Connect Google Calendar"** overlay with a sign-in button. Clock and weather still work.
- Tap the button → popup → consent → token (~1h TTL) stored in `localStorage`.
- Every Calendar API call attaches `Authorization: Bearer <token>`. On 401, clear token and re-show the connect overlay (after one silent retry).

### Token lifecycle in practice

The access token TTL is ~1h, but renewal happens silently every ~55 minutes via `tokenClient.requestAccessToken({ prompt: '' })`. As long as the Chromium profile holds the Google session cookie (which it does for as long as the kiosk is up), Google returns a fresh token without UI. The "Connect" button only re-appears if browser data is cleared, the user signs out, or Google force-invalidates the session — none of which happen on a kiosk left running.

If silent refresh ever becomes unreliable, the upgrade path is to switch to a real OAuth code-exchange flow with refresh tokens, which would require adding a small backend endpoint (FastAPI). Out of scope for v1.

## Error and degradation behavior

Each widget degrades independently. The page never goes blank.

| Failure                          | Behavior                                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| Clock                            | Cannot fail — pure `Date()`.                                              |
| Weather first-load fails         | Show `—°` and label "WEATHER · offline" in `--muted`.                     |
| Weather subsequent fail          | Keep last good payload from `localStorage`, prepend amber `•` to label.   |
| Weather payload > 6h old         | Treat as offline.                                                         |
| Calendar read first-load fails   | Empty grid + header notice "Couldn't load events — tap to retry".         |
| Calendar read subsequent fail    | Keep last grid, console-log only.                                         |
| Calendar auth missing/expired    | Connect overlay on calendar widget; clock and weather unaffected.         |
| Calendar write fails             | Form stays open, inline error under Save.                                 |
| Network entirely down            | All three widgets show their stale/offline states.                        |

No service worker. The added complexity isn't justified for a single-user kiosk that's online >99% of the time.

## Deliverables

Repo contents at completion of v1:

- `index.html`, `style.css`, `app.js`
- `dashboard.service` (systemd unit for the static server)
- `setup.sh` (idempotent: copies the unit, enables it, adds Chromium autostart line)
- `README.md` — replaces the placeholder. Covers Google Cloud setup, where to put the client ID, how to enable the systemd service, how to update files, how to clear localStorage if auth wedges, and the v1.1+ backlog.

## Backlog (post-v1)

- Event edit and delete
- Multi-calendar support (calendar picker, color from Google's calendar color)
- Weather forecast (next 3 days)
- Reminders / notifications surface
- Screen schedule (off at night, on in the morning)
- Burn-in protection (subtle pixel shift)
- Move auth to FastAPI backend with refresh tokens if silent refresh proves unreliable
