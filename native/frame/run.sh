#!/bin/bash
# Launch Frame Hands on the Steam Frame.
#   ./run.sh                 start the hand tracker (if installed) and the app
#   ./run.sh --fake          use simulated hands instead of the camera tracker
# Extra args after "--" go to the app, e.g. ./run.sh -- --tracker-host=127.0.0.1
# Log: /tmp/frame-hands.log
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/frame-hands.log
: > "$LOG"
log() { echo "$*" | tee -a "$LOG"; }

FAKE=0
if [ "$1" = "--fake" ]; then FAKE=1; shift; fi

if [ "$FAKE" = 1 ]; then
  log "Starting simulated hands (fake_hands.py)"
  python3 "$DIR/fake_hands.py" >> "$LOG" 2>&1 &
  FAKE_PID=$!
  trap 'kill $FAKE_PID 2>/dev/null' EXIT
elif [ -x "$HOME/handtrack/start.sh" ]; then
  log "Starting the camera hand tracker (~/handtrack/start.sh)"
  "$HOME/handtrack/start.sh" >> "$LOG" 2>&1 || log "WARNING: tracker start failed, see /tmp/live.log"
else
  log "WARNING: ~/handtrack/start.sh not found. Install the hand tracker first (see README),"
  log "         or run ./run.sh --fake to try the app with simulated hands."
fi

# Point OpenXR at SteamVR if nothing has registered a runtime yet.
if [ -z "$XR_RUNTIME_JSON" ] && [ ! -f "$HOME/.config/openxr/1/active_runtime.json" ] \
   && [ ! -f /etc/xdg/openxr/1/active_runtime.json ]; then
  RT=$(find /opt/steamvr "$HOME/.steam/steam/steamapps/common/SteamVR" -maxdepth 2 -name 'steamxr_linux*.json' 2>/dev/null | head -1)
  if [ -n "$RT" ]; then export XR_RUNTIME_JSON="$RT"; log "Using OpenXR runtime $RT"; fi
fi
log "OpenXR runtime: ${XR_RUNTIME_JSON:-$(readlink -f "$HOME/.config/openxr/1/active_runtime.json" 2>/dev/null || echo 'system default')}"

[ "$1" = "--" ] && shift
"$DIR/frame-hands.arm64" "$@" 2>&1 | tee -a "$LOG"
