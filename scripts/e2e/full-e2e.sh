#!/usr/bin/env bash
# End-to-end: daemon -> one headless nvim per workspace -> pi --mode rpc -> web API.
#
#   bash scripts/e2e/full-e2e.sh
#
# Requires: nvim, node, curl, jq, a working `pi` CLI (this drives a real model call).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PLUGIN="${PI2_E2E_PLUGIN:-/home/yuez/Workspace/Neovim/pi2.nvim-web}"
WS="$(mktemp -d /tmp/pi2-e2e-ws.XXXXXX)"
RUN="$(mktemp -d /tmp/pi2-e2e-run.XXXXXX)"
DATA="$(mktemp -d /tmp/pi2-e2e-data.XXXXXX)"
STATE="$(mktemp -d /tmp/pi2-e2e-state.XXXXXX)"
LOG="$STATE/e2e.log"

export PI2_RUNTIME_DIR="$RUN"
export PI2_DATA_DIR="$DATA"
export PI2_STATE_DIR="$STATE"
export XDG_STATE_HOME="$STATE"
export XDG_DATA_HOME="$DATA"
export PI2_WORKSPACE_ROOTS="$(dirname "$WS")"
export PI2_NVIM_BIN="${PI2_NVIM_BIN:-$(command -v nvim)}"
export PI2_NVIM_INIT="$REPO/scripts/e2e/host-init.lua"
export PI2_E2E_PLUGIN="$PLUGIN"

pass() { printf 'PASS %s\n' "$*"; }
fail() {
    printf 'FAIL %s\n' "$*"
    echo "--- daemon log ---"; tail -60 "$LOG" 2>/dev/null || true
    echo "--- instance logs ---"; ls -la "$STATE/instances" 2>/dev/null || true; tail -80 "$STATE"/instances/*.log 2>/dev/null || true
    echo "--- nvim web log ---"; find "$STATE" -name 'pi2-web.log' -exec tail -80 {} \; 2>/dev/null || true
    echo "--- processes ---"; ps -eo pid,ppid,etime,args | grep -E "nvim|pi --mode|node .*pi2d" | grep -v grep || true
    echo "--- sessions endpoint ---"; curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/workspaces/$WSID/sessions" 2>/dev/null | head -c 2000 || true
    echo
    echo "--- state ---"; ls -la "$STATE" "$RUN" 2>/dev/null || true
    exit 1
}

command -v jq >/dev/null || { echo "jq is required"; exit 2; }
command -v pi >/dev/null || { echo "pi CLI is required"; exit 2; }
[ -f "$REPO/dist/cli/pi2d.js" ] || { echo "run: npx tsc -p tsconfig.json"; exit 2; }

echo "==> workspace $WS"
printf '# e2e\n' > "$WS/README.md"

echo "==> starting pi2d"
node "$REPO/dist/cli/pi2d.js" --foreground --port 0 >"$LOG" 2>&1 &
DPID=$!
cleanup() {
    kill "$DPID" 2>/dev/null || true
    wait "$DPID" 2>/dev/null || true
    # stop any nvim the daemon spawned
    for pid in $(pgrep -f "pi.host" 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

for _ in $(seq 1 100); do
    [ -f "$RUN/daemon.json" ] && break
    sleep 0.1
done
[ -f "$RUN/daemon.json" ] || fail "daemon.json not written"
PORT=$(jq -r 'if type=="object" then .port else empty end' "$RUN/daemon.json" 2>/dev/null || true)
[ -n "${PORT:-}" ] && [ "$PORT" != "null" ] || PORT=$(sed -n 's/.*"port":\([0-9]*\).*/\1/p' "$RUN/daemon.json")
TOKEN=$(cat "$RUN/cli.token")
BASE="http://127.0.0.1:$PORT"
pass "daemon on $BASE"

api() { curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
cmd() { api -X POST "$BASE/api/v1/cmd" -d "$1"; }

INFO=$(api "$BASE/api/v1/info") || fail "GET /info"
[ "$(echo "$INFO" | jq -r '.v')" = "1" ] || fail "protocol v != 1"
pass "info v=1"

WS_JSON=$(cmd "{\"method\":\"workspace.add\",\"params\":{\"cwd\":\"$WS\",\"trust\":true}}")
WSID=$(echo "$WS_JSON" | jq -r '.workspace.workspaceId // .workspaceId // empty')
[ -n "$WSID" ] || fail "workspace.add: $WS_JSON"
pass "workspace $WSID"

echo "==> ensuring instance (spawns headless nvim)"
cmd "{\"method\":\"instance.ensure\",\"params\":{\"workspaceId\":\"$WSID\"}}" >/dev/null || fail "instance.ensure"

READY=0
for _ in $(seq 1 150); do
    ST=$(api "$BASE/api/v1/workspaces" | jq -r --arg id "$WSID" 'if type=="array" then (.[]|select(.workspaceId==$id)|.instance.status) else empty end')
    case "$ST" in ready) READY=1; break;; degraded|stopped) fail "instance status $ST";; esac
    sleep 0.2
done
[ "$READY" = "1" ] || fail "instance never became ready"
pass "instance ready"

echo "==> creating session"
S_JSON=$(cmd "{\"method\":\"session.create\",\"params\":{\"workspaceId\":\"$WSID\"}}")
SID=$(echo "$S_JSON" | jq -r '.payload.sessionId // .sessionId // .accepted.sessionId // empty')
[ -n "$SID" ] || fail "session.create: $S_JSON"
pass "session $SID"

echo "==> sending prompt (real model call)"
cmd "{\"method\":\"prompt.send\",\"sessionId\":\"$SID\",\"params\":{\"text\":\"Reply with exactly the word PONG and nothing else.\"}}" >/dev/null || fail "prompt.send"

FOUND=0
for i in $(seq 1 120); do
    SESS=$(api "$BASE/api/v1/workspaces/$WSID/sessions" 2>/dev/null || echo '')
    REAL=$(echo "$SESS" | jq -r '.sessions[0].sessionId // empty' 2>/dev/null || true)
    if [ -n "$REAL" ]; then
        ENTRIES=$(api "$BASE/api/v1/sessions/$REAL/entries?limit=50" 2>/dev/null || echo '')
        if echo "$ENTRIES" | grep -qi 'PONG'; then FOUND=1; SID="$REAL"; break; fi
    fi
    if [ $((i % 10)) -eq 0 ]; then
        echo "    ... waiting (${i}/120) real=${REAL:-?} entries=$(echo "$ENTRIES" | head -c 240)"
    fi
    sleep 1
done
[ "$FOUND" = "1" ] || fail "no assistant answer within 120s"
pass "assistant answered (history endpoint contains PONG)"

echo "==> session state"
api "$BASE/api/v1/workspaces/$WSID/sessions" | jq -c '.' | head -c 800; echo
pass "sessions endpoint"

N=$(api "$BASE/api/v1/sessions/$SID/entries?limit=50" | jq -r 'if type=="object" then (.entries|length) else 0 end' 2>/dev/null || echo 0)
[ "${N:-0}" -gt 0 ] || fail "history endpoint returned no entries"
pass "history paging ($N entries)"

echo "==> shutting down"
kill "$DPID" 2>/dev/null || true
for _ in $(seq 1 50); do kill -0 "$DPID" 2>/dev/null || break; sleep 0.1; done
pass "daemon stopped"

echo "E2E OK ($WS)"
