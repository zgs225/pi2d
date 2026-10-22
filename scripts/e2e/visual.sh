#!/usr/bin/env bash
# Visual acceptance: boot the real daemon + plugin, pair a browser, and capture
# the four pages at desktop and mobile widths for design-parity review.
#
#   bash scripts/e2e/visual.sh [output-dir]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-/tmp/pi2-visual}"
PW="${PLAYWRIGHT_BIN:-/home/yuez/.local/share/mise/installs/npm-playwright/latest/bin/playwright}"
WS="${PI2_VISUAL_WS:-/tmp/pi2-e2e-ws.MDdJQT}"
[ -d "$WS" ] || WS="$(mktemp -d /tmp/pi2-visual-ws.XXXXXX)"

RUN="$(mktemp -d /tmp/pi2-visual-run.XXXXXX)"
DATA="$(mktemp -d /tmp/pi2-visual-data.XXXXXX)"
STATE="$(mktemp -d /tmp/pi2-visual-state.XXXXXX)"
LOG="$STATE/visual.log"
mkdir -p "$OUT" "$STATE/instances"

export PI2_RUNTIME_DIR="$RUN" PI2_DATA_DIR="$DATA" PI2_STATE_DIR="$STATE"
export XDG_STATE_HOME="$STATE" XDG_DATA_HOME="$DATA"
export PI2_WORKSPACE_ROOTS="$(dirname "$WS")"
export PI2_NVIM_BIN="${PI2_NVIM_BIN:-$(command -v nvim)}"
export PI2_NVIM_INIT="$REPO/scripts/e2e/host-init.lua"
export PI2_E2E_PLUGIN="${PI2_E2E_PLUGIN:-/home/yuez/Workspace/Neovim/pi2.nvim-web}"

node "$REPO/dist/cli/pi2.js" daemon --foreground --port 0 >"$LOG" 2>&1 &
DPID=$!
cleanup() { kill "$DPID" 2>/dev/null || true; wait "$DPID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 100); do [ -f "$RUN/daemon.json" ] && break; sleep 0.1; done
PORT=$(sed -n 's/.*"port": *\([0-9]*\).*/\1/p' "$RUN/daemon.json")
BASE="http://127.0.0.1:$PORT"
TOKEN=$(cat "$RUN/cli.token")
api() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
cmd() { api -X POST "$BASE/api/v1/cmd" -d "$1"; }

WSID=$(cmd "{\"method\":\"workspace.add\",\"params\":{\"cwd\":\"$WS\",\"trust\":true}}" | jq -r '.workspace.workspaceId')
cmd "{\"method\":\"instance.ensure\",\"params\":{\"workspaceId\":\"$WSID\"}}" >/dev/null
for _ in $(seq 1 150); do
  ST=$(api "$BASE/api/v1/workspaces" | jq -r --arg id "$WSID" '(if type=="array" then . else .workspaces end)[]|select(.workspaceId==$id)|.instance.status')
  [ "$ST" = "ready" ] && break
  sleep 0.2
done
echo "instance: $ST  workspace: $WSID"

CODE=$(cmd '{"method":"pair.create","params":{}}' | jq -r '.code')
DEVTOKEN=$(curl -fsS -X POST "$BASE/api/v1/pair" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"deviceName\":\"Playwright\",\"kind\":\"laptop\"}" | jq -r '.token')
echo "paired device token: ${DEVTOKEN:0:8}…"

STORAGE="$STATE/storage.json"
cat >"$STORAGE" <<JSON
{"cookies":[],"origins":[{"origin":"$BASE","localStorage":[
  {"name":"pi2-connection","value":"paired"},
  {"name":"pi2-endpoint","value":"$BASE"},
  {"name":"pi2-device-token","value":"$DEVTOKEN"},
  {"name":"pi2-device","value":"Playwright"},
  {"name":"pi2-connected-at","value":"$(date +%s000)"}
]}]}
JSON

EMPTY="$STATE/empty.json"
cat >"$EMPTY" <<JSON
{"cookies":[],"origins":[]}
JSON

shot() { # name url width height [storage]
  local name="$1" url="$2" w="$3" h="$4" storage="${5:-$STORAGE}"
  "$PW" screenshot --browser chromium --channel chromium --color-scheme dark --viewport-size "$w,$h" \
    --load-storage "$storage" --wait-for-timeout 2500 "$url" "$OUT/$name.png" >/dev/null 2>&1 \
    && echo "PASS $name.png ($w×$h)" || echo "FAIL $name.png"
}

shot workspaces-desktop "$BASE/workspaces" 1280 900
shot workspaces-mobile  "$BASE/workspaces" 380 780
shot chat-desktop      "$BASE/chat?workspace=$WSID" 1280 900
shot chat-mobile       "$BASE/chat?workspace=$WSID" 380 780
shot status-desktop    "$BASE/status" 1280 900
shot connect-mobile    "$BASE/connect" 380 780 "$EMPTY"

echo "screenshots in $OUT"
