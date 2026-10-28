#!/usr/bin/env bash
#
# Smoke test for the compiled standalone binary distribution of pi2d.
#
# Asserts the dist-bin/bin/pi2 binary against:
#   1. Daemon startup: writes exactly ONE stdout line matching 'listening on http://'
#   2. GET /api/v1/info: 200, v == 1, version == package.json version
#   3. GET /: 200 and HTML body (served from share/pi2d/web/dist)
#   4. GET /api/v1/health: static item ok
#   5. pi2 doctor: node/runtime check ok, no FAIL for node, exit code 0 or 1
#   6. pi2 install-service --dry-run: ExecStart first word is binary path, no 'pi2.js' or 'node '
#   7. SIGTERM: clean exit 0, daemon.json and daemon.lock removed
#
# Usage:
#   bash scripts/smoke-binary.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pi2-smoke-binary.XXXXXX")"
PI2_RUNTIME_DIR="$TMP/run"
PI2_DATA_DIR="$TMP/data"
PI2_STATE_DIR="$TMP/state"
export PI2_RUNTIME_DIR PI2_DATA_DIR PI2_STATE_DIR
export PI2_PORT=0
# Hermetic: bind loopback even though the daemon defaults to 0.0.0.0 (the
# unit/env tests cover the wildcard default); never inherit an ambient PI2_HOST.
export PI2_HOST="${PI2_HOST:-127.0.0.1}"
export PI2_LOG_LEVEL="${PI2_LOG_LEVEL:-warn}"

LOG="$TMP/pi2-daemon.log"
DAEMON_JSON="$PI2_RUNTIME_DIR/daemon.json"
LOCK="$PI2_RUNTIME_DIR/daemon.lock"
BODY="$TMP/body"
DAEMON_PID=""
FAILED=0

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
    FAILED=$((FAILED + 1))
}

require() {
    command -v "$1" >/dev/null 2>&1 || {
        printf 'FAIL missing required command: %s\n' "$1" >&2
        exit 1
    }
}

require curl
require node

# request <method> <path> [curl args...] -> writes body to $BODY, echoes status
request() {
    local method="$1"
    local path="$2"
    shift 2
    curl -sS --max-time 5 -o "$BODY" -w '%{http_code}' -X "$method" "$@" "$BASE_URL$path" 2>/dev/null || echo "000"
}

expect_status() {
    local expected="$1"
    local method="$2"
    local path="$3"
    shift 3
    local actual
    actual="$(request "$method" "$path" "$@")"
    if [[ "$actual" != "$expected" ]]; then
        fail "expected HTTP $expected for $method $path, got $actual ($(head -c 200 "$BODY" 2>/dev/null || true))"
        return 1
    fi
    return 0
}

expect_json() {
    local expression="$1"
    local what="$2"
    local file="${3:-$BODY}"
    if ! node --input-type=module -e "
        import { readFileSync } from 'node:fs';
        const body = JSON.parse(readFileSync(process.argv[1], 'utf8'));
        if (!($expression)) {
            process.exit(1);
        }
    " "$file" 2>/dev/null; then
        fail "$what"
        return 1
    fi
    return 0
}

BINARY="$ROOT/dist-bin/bin/pi2"

if [[ "${PI2_SKIP_BUILD:-0}" == "1" && -x "$BINARY" ]]; then
    printf '==> reusing existing binary at %s (PI2_SKIP_BUILD=1)\n' "$BINARY"
else
    printf '==> building binary with scripts/build-binary.sh\n'
    bash scripts/build-binary.sh --no-archive >"$TMP/build.log" 2>&1 || {
        cat "$TMP/build.log" >&2
        printf 'FAIL scripts/build-binary.sh failed\n' >&2
        exit 1
    }
fi

[[ -x "$BINARY" ]] || {
    printf 'FAIL compiled binary missing or not executable at %s\n' "$BINARY" >&2
    exit 1
}

PKG_VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version)")"

# --- Assertion 1: bin/pi2 daemon --port 0 writes exactly ONE stdout line matching 'listening on http://' ---
printf '==> starting pi2 daemon via compiled binary (port 0)\n'
"$BINARY" daemon --port 0 >"$TMP/stdout.log" 2>"$LOG" &
DAEMON_PID=$!

for _ in $(seq 1 200); do
    [[ -f "$DAEMON_JSON" ]] && break
    kill -0 "$DAEMON_PID" 2>/dev/null || break
    sleep 0.05
done

if [[ ! -f "$DAEMON_JSON" ]]; then
    fail "daemon.json was not written by compiled binary"
    BASE_URL=""
else
    PORT="$(node --input-type=module -e "
        import { readFileSync } from 'node:fs';
        const info = JSON.parse(readFileSync(process.argv[1], 'utf8'));
        process.stdout.write(String(info.port));
    " "$DAEMON_JSON")"
    BASE_URL="http://127.0.0.1:$PORT"

    MATCH_COUNT="$(grep -c 'listening on http://' "$TMP/stdout.log" || true)"
    if [[ "$MATCH_COUNT" -eq 1 ]]; then
        pass "1. daemon --port 0 wrote exactly ONE line matching 'listening on http://'"
    else
        fail "1. daemon --port 0 expected exactly ONE matching stdout line, got $MATCH_COUNT ($(cat "$TMP/stdout.log"))"
    fi
fi

# --- Assertion 2: GET /api/v1/info -> 200, v == 1, version == package.json version ---
if [[ -n "$BASE_URL" ]]; then
    if expect_status 200 GET /api/v1/info; then
        if expect_json "body.v === 1 && body.version === '$PKG_VERSION'" "2. GET /api/v1/info reports v=1 and version=$PKG_VERSION"; then
            pass "2. GET /api/v1/info -> 200, v=1, version=$PKG_VERSION"
        fi
    else
        fail "2. GET /api/v1/info did not return 200"
    fi
else
    fail "2. GET /api/v1/info skipped (daemon not running)"
fi

# --- Assertion 3: GET / -> 200 and an HTML body (served from share/pi2d/web/dist) ---
if [[ -n "$BASE_URL" ]]; then
    if expect_status 200 GET /; then
        if ! grep -qi 'text/html' <(curl -sS -D - -o /dev/null --max-time 5 "$BASE_URL/"); then
            fail "3. GET / did not return text/html"
        elif ! grep -q 'id="root"\|id=app' "$BODY"; then
            fail "3. GET / body is not the web UI shell"
        elif ! grep -q '<title>' "$BODY"; then
            fail "3. GET / body has no <title>"
        else
            pass "3. GET / -> 200 html from share/pi2d/web/dist"
        fi
    else
        fail "3. GET / returned non-200"
    fi
else
    fail "3. GET / skipped (daemon not running)"
fi

# --- Assertion 4: GET /api/v1/health -> static item ok ---
if [[ -n "$BASE_URL" ]]; then
    if expect_status 200 GET /api/v1/health; then
        if expect_json "Array.isArray(body.items) && body.items.some(item => item.name === 'static' && item.ok === true)" "4. GET /api/v1/health static item ok"; then
            pass "4. GET /api/v1/health -> static item ok"
        fi
    else
        fail "4. GET /api/v1/health did not return 200"
    fi
else
    fail "4. GET /api/v1/health skipped (daemon not running)"
fi

# --- Assertion 5: bin/pi2 doctor reports node/runtime check as ok and not failure ---
set +e
"$BINARY" doctor >"$TMP/doctor.log" 2>&1
DOCTOR_EXIT=$?
set -e

DOCTOR_OK=1
if [[ "$DOCTOR_EXIT" -ne 0 && "$DOCTOR_EXIT" -ne 1 ]]; then
    fail "5. pi2 doctor exited with unexpected code $DOCTOR_EXIT (expected 0 or 1)"
    DOCTOR_OK=0
fi
if grep -E '^[[:space:]]*FAIL[[:space:]]+node\b' "$TMP/doctor.log" >/dev/null 2>&1; then
    fail "5. pi2 doctor reported FAIL line for node"
    DOCTOR_OK=0
fi
if ! grep -E '^[[:space:]]*ok[[:space:]]+(node|runtime)\b' "$TMP/doctor.log" >/dev/null 2>&1; then
    fail "5. pi2 doctor did not report node/runtime check as ok"
    DOCTOR_OK=0
fi
if [[ "$DOCTOR_OK" -eq 1 ]]; then
    pass "5. pi2 doctor reports node/runtime check as ok (exit code $DOCTOR_EXIT)"
fi

# --- Assertion 6: bin/pi2 install-service --dry-run renders clean ExecStart ---
set +e
"$BINARY" install-service --dry-run >"$TMP/service.log" 2>&1
SERVICE_EXIT=$?
set -e

SERVICE_OK=1
if [[ "$SERVICE_EXIT" -ne 0 ]]; then
    fail "6. pi2 install-service --dry-run failed with exit code $SERVICE_EXIT"
    SERVICE_OK=0
fi

EXEC_START="$(grep '^ExecStart=' "$TMP/service.log" || true)"
if [[ -z "$EXEC_START" ]]; then
    fail "6. pi2 install-service --dry-run did not output ExecStart="
    SERVICE_OK=0
else
    FIRST_WORD="$(echo "${EXEC_START#ExecStart=}" | awk '{print $1}' | tr -d '"')"
    REAL_BINARY="$(realpath "$BINARY")"
    if [[ "$FIRST_WORD" != "$REAL_BINARY" && "$FIRST_WORD" != "$BINARY" ]]; then
        fail "6. ExecStart first word is '$FIRST_WORD', expected '$REAL_BINARY'"
        SERVICE_OK=0
    fi
    if echo "$EXEC_START" | grep -q 'pi2\.js'; then
        fail "6. ExecStart contains 'pi2.js': $EXEC_START"
        SERVICE_OK=0
    fi
    if echo "$EXEC_START" | grep -q 'node '; then
        fail "6. ExecStart contains 'node ': $EXEC_START"
        SERVICE_OK=0
    fi
fi

if [[ "$SERVICE_OK" -eq 1 ]]; then
    pass "6. pi2 install-service --dry-run renders clean ExecStart without pi2.js or node"
fi

# --- Assertion 7: SIGTERM -> clean exit 0, daemon.json + daemon.lock removed ---
if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    printf '==> stopping daemon via SIGTERM\n'
    kill -TERM "$DAEMON_PID"
    set +e
    wait "$DAEMON_PID"
    DAEMON_EXIT=$?
    set -e
    DAEMON_PID=""

    SIGTERM_OK=1
    if [[ "$DAEMON_EXIT" -ne 0 ]]; then
        fail "7. daemon exited with code $DAEMON_EXIT on SIGTERM (expected 0)"
        SIGTERM_OK=0
    fi
    if [[ -f "$LOCK" ]]; then
        fail "7. daemon.lock was not removed on SIGTERM"
        SIGTERM_OK=0
    fi
    if [[ -f "$DAEMON_JSON" ]]; then
        fail "7. daemon.json was not removed on SIGTERM"
        SIGTERM_OK=0
    fi

    if [[ "$SIGTERM_OK" -eq 1 ]]; then
        pass "7. SIGTERM -> clean exit 0, daemon.json and daemon.lock removed"
    fi
else
    fail "7. SIGTERM skipped (daemon was not running)"
fi

if [[ "$FAILED" -gt 0 ]]; then
    printf '\nSMOKE FAILED (%d assertion(s) failed, tmp dir: %s)\n' "$FAILED" "$TMP" >&2
    if [[ -f "$LOG" ]]; then
        printf '\n--- pi2 daemon log ---\n' >&2
        tail -n 40 "$LOG" >&2 || true
    fi
    PI2_SMOKE_KEEP=1
    exit 1
fi

printf '\nSMOKE OK (%s)\n' "$TMP"
