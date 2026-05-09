# Pearboard

A fullscreen dashboard for a Raspberry Pi 4 with a 15.6" 1920×1080 landscape touchscreen. Shows a live clock, current weather (Open-Meteo, Montréal), and a month-view calendar backed by Google Calendar. Touch to change months, see a day's events, and add new events that go straight to your Google Calendar.

Pure static HTML/CSS/JS served by a tiny Python HTTP server on `http://localhost:8000` (the localhost origin is what unblocks Google OAuth — `file://` is rejected by Google's sign-in).

## What's in the box

| File                | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `index.html`        | Markup, font + GIS script tags                                         |
| `style.css`         | Theme tokens, grid layout, all widget styles                           |
| `app.js`            | Clock, weather, calendar grid, GIS auth, day panel, add-event form     |
| `dashboard.service` | systemd unit that runs `python3 -m http.server 8000`                   |
| `setup.sh`          | Idempotent installer: enables the service, wires Chromium kiosk launch |

## One-time Google Cloud setup

You need an OAuth Client ID before the calendar widget will work. The clock and weather work without it.

1. Open <https://console.cloud.google.com/> and create a new project (or use an existing one).
2. **APIs & Services → Library** → enable **Google Calendar API**.
3. **APIs & Services → OAuth consent screen** → User Type **External** → fill in app name, support email, developer email. You can leave the rest blank. Add your own Gmail under **Test users**. (No need to publish — test users work indefinitely for personal use.)
4. **APIs & Services → Credentials** → **Create credentials → OAuth client ID** → Application type **Web application**.
5. Under **Authorized JavaScript origins**, add:
   ```
   http://localhost:8000
   ```
6. Save. Copy the **Client ID** (looks like `1234...apps.googleusercontent.com`).
7. Open `app.js` and paste it into the top-of-file constant:
   ```js
   const CONFIG = {
     GOOGLE_CLIENT_ID: "PASTE_YOUR_CLIENT_ID_HERE",
     ...
   };
   ```

## Install on the Pi

```bash
# On your dev machine: copy the repo to the Pi
rsync -avz --exclude '.git' ./ tomy@raspberrypi.local:/home/tomy/Pearboard/

# On the Pi
ssh tomy@raspberrypi.local
cd /home/tomy/Pearboard
chmod +x setup.sh
./setup.sh
sudo reboot
```

After reboot, Chromium should launch in kiosk mode and load the dashboard. The first time you tap the calendar's **Connect** button, you'll go through Google's consent screen once. After that, silent token refresh keeps the calendar working indefinitely on a continuously-running kiosk.

### Manual install (if you don't want to run the script)

```bash
sudo cp /home/tomy/Pearboard/dashboard.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dashboard.service

# Add to ~/.config/lxsession/LXDE-pi/autostart:
@chromium --kiosk --noerrdialogs --disable-translate --disable-features=Translate http://localhost:8000
@xset s off
@xset -dpms
@xset s noblank
```

## Updating

Edit a file, copy it to the Pi, and either reload the page (Ctrl+R if you have a keyboard, or `pkill chromium && systemctl --user restart graphical-session`) or just reboot. No build step.

```bash
rsync -avz --exclude '.git' ./ tomy@raspberrypi.local:/home/tomy/Pearboard/
ssh tomy@raspberrypi.local 'sudo systemctl restart dashboard.service'
```

## Troubleshooting

**Clock and weather show, calendar shows "Connect Google Calendar" forever.**
Either `CONFIG.GOOGLE_CLIENT_ID` is empty, or the origin in your OAuth client doesn't match `http://localhost:8000`. Check the browser console.

**Calendar wedges with a 401 loop.**
Token got into a bad state. Open DevTools and clear `localStorage`, or:
```bash
ssh tomy@raspberrypi.local 'rm -rf ~/.config/chromium/Default/Local\ Storage'
```

**Weather shows offline.**
Open-Meteo is rate-limit-friendly but does occasionally hiccup. The dashboard caches the last good payload for up to 6 hours. Tap the weather widget to force a refresh (debounced to once every 10 seconds).

**Chromium not going fullscreen.**
Verify the autostart line landed:
```bash
cat ~/.config/lxsession/LXDE-pi/autostart
```

**Service won't start.**
```bash
sudo systemctl status dashboard.service
sudo journalctl -u dashboard.service -n 50
```

## Local development (on your laptop)

The dashboard is happy to run on any machine that can serve static files at `http://localhost:8000`:

```bash
cd /path/to/this/repo
python3 -m http.server 8000
# open http://localhost:8000
```

Add `http://localhost:8000` (which is already step 5 above) to your OAuth client's authorized origins and you can dev against your real Google Calendar.

## Backlog (post-v1)

- Event edit and delete (tap an existing event in the day panel).
- Multiple Google calendars (calendar picker, color from Google's calendar color).
- Weather forecast (next 3 days).
- Reminders / notifications surface.
- Screen-on/off scheduling and burn-in protection.
- Move auth to a FastAPI backend with refresh tokens, if silent refresh ever proves unreliable.

## Design

The full design rationale lives in [`docs/plans/2026-05-05-pi-dashboard-design.md`](docs/plans/2026-05-05-pi-dashboard-design.md).
