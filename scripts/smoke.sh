#!/usr/bin/env bash
#
# End-to-end smoke test for the pi2 daemon.
#
# Builds the project, starts `pi2 daemon` on an ephemeral port with throwaway
# runtime dirs, then asserts the HTTP surface (info/health/static/404/auth), the
# discovery file and a clean SIGTERM shutdown.
#
# Usage: bash scripts/smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pi2-smoke.XXXXXX")"
PI2_RUNTIME_DIR="$TMP/run"
PI2_DATA_DIR="$TMP/data"
PI2_STATE_DIR="$TMP/state"
export PI2_RUNTIME_DIR PI2_DATA_DIR PI2_STATE_DIR
export PI2_PORT=0
export PI2_LOG_LEVEL="${PI2_LOG_LEVEL:-warn}"

LOG="$TMP/pi2-daemon.log"
DAEMON_JSON="$PI2_RUNTIME_DIR/daemon.json"
LOCK="$PI2_RUNTIME_DIR/daemon.lock"
TOKEN_FILE="$PI2_RUNTIME_DIR/cli.token"
BODY="$TMP/body"
STARTED=0
DAEMON_PID=""

cleanup() {
    if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
        kill -TERM "$DAEMON_PID" 2>/dev/null || true
        for _ in $(seq 1 50); do
            kill -0 "$DAEMON_PID" 2>/dev/null || break
            sleep 0.1
        done
        kill -KILL "$DAEMON_PID" 2>/dev/null || true
    fi
    [[ "${PI2_SMOKE_KEEP:-0}" == "1" ]] || rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf 'PASS %s\n' "$*"; }
fail() {
    printf 'FAIL %s\n' "$*" >&2
    if [[ -f "$LOG" ]]; then
        printf '\n--- pi2 daemon log ---\n' >&2
        tail -n 40 "$LOG" >&2 || true
    fi
    printf '\n--- tmp dir: %s ---\n' "$TMP" >&2
    PI2_SMOKE_KEEP=1
    exit 1
}

require() {
    command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

# request <method> <path> [curl args...] -> writes the body to $BODY, echoes the status
request() {
    local method="$1"
    local path="$2"
    shift 2
    curl -sS --max-time 5 -o "$BODY" -w '%{http_code}' -X "$method" "$@" "$BASE_URL$path" || fail "curl failed: $method $path"
}

expect_status() {
    local expected="$1"
    local method="$2"
    local path="$3"
    shift 3
    local actual
    actual="$(request "$method" "$path" "$@")"
    [[ "$actual" == "$expected" ]] || fail "expected HTTP $expected for $method $path, got $actual ($(head -c 200 "$BODY"))"
}

# expect_json <expression> <what> [file] — `body` is the parsed JSON
expect_json() {
    local expression="$1"
    local what="$2"
    local file="${3:-$BODY}"
    node --input-type=module -e "
        import { readFileSync } from 'node:fs';
        const body = JSON.parse(readFileSync(process.argv[1], 'utf8'));
        if (!($expression)) {
            console.error('assertion failed: $what');
            process.exit(1);
        }
    " "$file" || fail "$what"
}

require curl
require node

[[ -f web/dist/index.html ]] || fail "web/dist/index.html missing — build the web UI first"

printf '==> building\n'
# `npm run build` is exactly this tsc invocation; calling tsc directly keeps the
# smoke test independent of the package manager's dependency-check policy.
if ! npx tsc -p tsconfig.json >"$TMP/build.log" 2>&1; then
    cat "$TMP/build.log" >&2
    fail "build failed"
fi
[[ -f dist/cli/pi2.js ]] || fail "dist/cli/pi2.js missing after build"
pass "build produced dist/cli/pi2.js"

printf '==> starting pi2 daemon (port 0)\n'
node dist/cli/pi2.js daemon --foreground >"$TMP/stdout.log" 2>"$LOG" &
DAEMON_PID=$!

for _ in $(seq 1 200); do
    [[ -f "$DAEMON_JSON" ]] && break
    kill -0 "$DAEMON_PID" 2>/dev/null || fail "pi2 daemon exited before writing daemon.json"
    sleep 0.05
done
[[ -f "$DAEMON_JSON" ]] || fail "daemon.json was not written"
pass "daemon.json written"

PORT="$(node --input-type=module -e "
    import { readFileSync } from 'node:fs';
    const info = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    process.stdout.write(String(info.port));
" "$DAEMON_JSON")"
[[ "$PORT" =~ ^[0-9]+$ ]] || fail "daemon.json has no usable port: $PORT"
[[ "$PORT" -gt 0 ]] || fail "daemon.json port must be explicit, got $PORT"
BASE_URL="http://127.0.0.1:$PORT"
pass "bound port $PORT"

[[ -f "$LOCK" ]] || fail "daemon.lock missing while running"
grep -q "\"pid\": $DAEMON_PID" "$LOCK" || fail "daemon.lock does not carry pid $DAEMON_PID"
pass "daemon.lock holds pid $DAEMON_PID"

expect_json "body.protocolVersion === 1" "daemon.json protocolVersion === 1" "$DAEMON_JSON"

grep -q "^pi2 daemon listening on http://127.0.0.1:$PORT$" "$TMP/stdout.log" ||
    fail "stdout line missing: expected 'pi2 daemon listening on http://127.0.0.1:$PORT' (got: $(cat "$TMP/stdout.log"))"
pass "stdout announced http://127.0.0.1:$PORT"

[[ -f "$TOKEN_FILE" ]] || fail "cli.token missing"
TOKEN="$(tr -d '\n' <"$TOKEN_FILE")"
[[ ${#TOKEN} -eq 64 ]] || fail "cli.token must be 64 hex chars, got ${#TOKEN}"
MODE="$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || stat -f '%Lp' "$TOKEN_FILE")"
[[ "$MODE" == "600" ]] || fail "cli.token mode must be 600, got $MODE"
pass "cli.token is 64 hex chars, mode 0600"

expect_status 200 GET /api/v1/info
expect_json "body.v === 1 && typeof body.daemonId === 'string'" "/api/v1/info reports v=1"
pass "GET /api/v1/info -> 200 v=1"

expect_status 200 GET /api/v1/health
expect_json "body.ok === true" "/api/v1/health ok"
pass "GET /api/v1/health -> 200 ok"

expect_status 200 GET /
grep -qi 'text/html' <(curl -sS -D - -o /dev/null --max-time 5 "$BASE_URL/") || fail "GET / did not return text/html"
grep -q 'id="root"\|id=app' "$BODY" || fail "GET / body is not the web UI shell"
grep -q '<title>' "$BODY" || fail "GET / body has no <title>"
pass "GET / -> 200 html from web/dist"

expect_status 404 GET /api/v1/nope -H "authorization: Bearer $TOKEN"
pass "GET /api/v1/nope (authenticated) -> 404"
expect_status 401 GET /api/v1/nope
pass "GET /api/v1/nope (unauthenticated) -> 401"

expect_status 200 GET /api/v1/workspaces -H "authorization: Bearer $TOKEN"
expect_json "Array.isArray(body)" "/api/v1/workspaces is an array"
pass "GET /api/v1/workspaces with the CLI token -> 200 array"

expect_status 401 GET /api/v1/workspaces
expect_json "body.code === 'E_UNAUTHORIZED'" "401 body carries E_UNAUTHORIZED"
pass "GET /api/v1/workspaces without a token -> 401"

expect_status 401 GET /api/v1/workspaces -H "authorization: Bearer deadbeef"
pass "GET /api/v1/workspaces with a bogus token -> 401"

printf '==> stopping pi2 daemon (pi2 stop)\n'
PI2_RUNTIME_DIR="$TMP/run" node "$ROOT/dist/cli/pi2.js" stop
pass "pi2 stop executed cleanly"

set +e
wait "$DAEMON_PID"
EXIT_CODE=$?
set -e
[[ "$EXIT_CODE" -eq 0 ]] || fail "pi2 daemon exited with code $EXIT_CODE"
pass "daemon process -> clean exit (code 0)"

[[ ! -f "$LOCK" ]] || fail "daemon.lock was not removed on shutdown"
pass "daemon.lock removed"
[[ ! -f "$DAEMON_JSON" ]] || fail "daemon.json was not removed on shutdown"
pass "daemon.json removed"

set +e
curl -sS --max-time 1 -o /dev/null "$BASE_URL/api/v1/health" 2>/dev/null
set -e
pass "port $PORT is no longer serving"

printf '\nSMOKE OK (%s)\n' "$TMP"
