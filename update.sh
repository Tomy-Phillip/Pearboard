#!/usr/bin/env bash
# Pulls the latest commit from GitHub and applies it. Run every few minutes by
# pearboard-update.timer (as root, so it can reinstall systemd units); git
# itself runs as 'tomy' so the checkout stays owned by that user.
#
# Any local edit made directly on the Pi is discarded: GitHub is the source of truth.
set -euo pipefail

DASH_DIR="/home/tomy/Pearboard"
BRANCH="main"
UNITS=(dashboard.service pearboard-update.service pearboard-update.timer)

as_tomy() { runuser -u tomy -- "$@"; }
git_dash() { as_tomy git -C "$DASH_DIR" "$@"; }

git_dash fetch --quiet origin "$BRANCH"

old="$(git_dash rev-parse HEAD)"
new="$(git_dash rev-parse "origin/$BRANCH")"

if [[ "$old" == "$new" ]]; then
  exit 0
fi

echo "Updating $old -> $new"
git_dash reset --hard --quiet "origin/$BRANCH"
changed="$(git_dash diff --name-only "$old" "$new")"

# Reinstall any systemd unit that changed.
units_changed=0
for unit in "${UNITS[@]}"; do
  if grep -qx "$unit" <<<"$changed"; then
    cp "$DASH_DIR/$unit" "/etc/systemd/system/$unit"
    units_changed=1
  fi
done
if (( units_changed )); then
  systemctl daemon-reload
fi

if grep -qxE "server\.py|dashboard\.service" <<<"$changed"; then
  systemctl restart dashboard.service
fi

# The page polls this file and reloads itself when it changes.
as_tomy sh -c "echo '$new' > '$DASH_DIR/version.txt'"
