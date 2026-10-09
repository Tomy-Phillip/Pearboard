#!/usr/bin/env bash
# Idempotent installer for Pearboard on Raspberry Pi OS Desktop.
# Run once on a fresh Pi after cloning this repo to /home/tomy/Pearboard.
set -euo pipefail

DASH_DIR="/home/tomy/Pearboard"
SERVICE_NAME="dashboard.service"
UPDATE_UNITS=(pearboard-update.service pearboard-update.timer)
AUTOSTART_DIR="/home/tomy/.config/lxsession/LXDE-pi"
AUTOSTART_FILE="$AUTOSTART_DIR/autostart"
CHROMIUM_LINE="@chromium --kiosk --noerrdialogs --disable-translate --disable-features=Translate http://localhost:8000"

if [[ ! -d "$DASH_DIR" ]]; then
  echo "error: $DASH_DIR does not exist. Clone the repo there first." >&2
  exit 1
fi

if [[ ! -d "$DASH_DIR/.git" ]]; then
  echo "error: $DASH_DIR is not a git clone. Auto-update needs 'git clone' (see README)." >&2
  exit 1
fi

if [[ "$(id -un)" != "tomy" ]]; then
  echo "warning: not running as user 'tomy'. The systemd unit and autostart paths assume /home/tomy." >&2
fi

# 1. Install systemd unit
echo "[1/4] Installing $SERVICE_NAME"
sudo cp "$DASH_DIR/$SERVICE_NAME" "/etc/systemd/system/$SERVICE_NAME"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

# 2. Install auto-update timer (pulls from GitHub every 5 minutes)
echo "[2/4] Installing auto-update timer"
for unit in "${UPDATE_UNITS[@]}"; do
  sudo cp "$DASH_DIR/$unit" "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable --now pearboard-update.timer
git -C "$DASH_DIR" rev-parse HEAD > "$DASH_DIR/version.txt"

# 3. Add Chromium kiosk autostart line if missing
echo "[3/4] Ensuring Chromium kiosk autostart"
mkdir -p "$AUTOSTART_DIR"
if [[ ! -f "$AUTOSTART_FILE" ]]; then
  cp /etc/xdg/lxsession/LXDE-pi/autostart "$AUTOSTART_FILE" 2>/dev/null || touch "$AUTOSTART_FILE"
fi
if ! grep -qF "chromium --kiosk" "$AUTOSTART_FILE"; then
  echo "$CHROMIUM_LINE" >> "$AUTOSTART_FILE"
  echo "  added kiosk launch line"
else
  echo "  kiosk launch line already present"
fi

# 4. Disable screen blanking (best-effort; ignore failures)
echo "[4/4] Disabling screen blanking"
if grep -qE "^[^#]*xset s" "$AUTOSTART_FILE"; then
  echo "  xset already present"
else
  {
    echo "@xset s off"
    echo "@xset -dpms"
    echo "@xset s noblank"
  } >> "$AUTOSTART_FILE"
fi

echo ""
echo "Done. Reboot the Pi to launch the kiosk:"
echo "  sudo reboot"
echo ""
echo "Service status:"
sudo systemctl --no-pager status "$SERVICE_NAME" || true
