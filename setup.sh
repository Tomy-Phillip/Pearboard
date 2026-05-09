#!/usr/bin/env bash
# Idempotent installer for Pearboard on Raspberry Pi OS Desktop.
# Run once on a fresh Pi after copying this repo to /home/tomy/Pearboard.
set -euo pipefail

DASH_DIR="/home/tomy/Pearboard"
SERVICE_NAME="dashboard.service"
AUTOSTART_DIR="/home/tomy/.config/lxsession/LXDE-pi"
AUTOSTART_FILE="$AUTOSTART_DIR/autostart"
CHROMIUM_LINE="@chromium-browser --kiosk --noerrdialogs --disable-translate --disable-features=Translate http://localhost:8000"

if [[ ! -d "$DASH_DIR" ]]; then
  echo "error: $DASH_DIR does not exist. Copy the repo there first." >&2
  exit 1
fi

if [[ "$(id -un)" != "tomy" ]]; then
  echo "warning: not running as user 'tomy'. The systemd unit and autostart paths assume /home/tomy." >&2
fi

# 1. Install systemd unit
echo "[1/3] Installing $SERVICE_NAME"
sudo cp "$DASH_DIR/$SERVICE_NAME" "/etc/systemd/system/$SERVICE_NAME"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

# 2. Add Chromium kiosk autostart line if missing
echo "[2/3] Ensuring Chromium kiosk autostart"
mkdir -p "$AUTOSTART_DIR"
if [[ ! -f "$AUTOSTART_FILE" ]]; then
  cp /etc/xdg/lxsession/LXDE-pi/autostart "$AUTOSTART_FILE" 2>/dev/null || touch "$AUTOSTART_FILE"
fi
if ! grep -qF "chromium-browser --kiosk" "$AUTOSTART_FILE"; then
  echo "$CHROMIUM_LINE" >> "$AUTOSTART_FILE"
  echo "  added kiosk launch line"
else
  echo "  kiosk launch line already present"
fi

# 3. Disable screen blanking (best-effort; ignore failures)
echo "[3/3] Disabling screen blanking"
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
