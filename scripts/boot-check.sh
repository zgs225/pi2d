#!/bin/sh
#
# Boot check for a built `pi2` artifact.
#
#   sh scripts/boot-check.sh <path-to-pi2> [expected-version]
#
# Starts the daemon on an ephemeral port with throwaway runtime/data/state
# directories, waits for the single stdout line, asserts `/api/v1/info` answers
# with protocol v1 (and the expected version), then sends SIGTERM and requires a
# clean exit 0.
#
# POSIX `sh` on purpose: this script also runs inside an Alpine container, where
# it validates the `-musl` artifacts (Bun's musl binaries need musl's libstdc++,
# which the Ubuntu runners do not have, so they must be executed on Alpine).
# Only `curl` and a shell are required; no `jq`, no Node, no Python.
set -eu

BIN="${1:-}"
EXPECTED_VERSION="${2:-}"

if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
    echo "usage: boot-check.sh <path-to-pi2> [expected-version]" >&2
    echo "       (missing or not executable: '${BIN}')" >&2
    exit 2
fi

pass() {
    printf 'PASS %s\n' "$1"
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pi2-boot.XXXXXX")"
PID=""
cleanup() {
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        kill -TERM "$PID" 2>/dev/null || true
        wait "$PID" 2>/dev/null || true
    fi
    rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

PI2_RUNTIME_DIR="$TMP/run"
PI2_DATA_DIR="$TMP/data"
PI2_STATE_DIR="$TMP/state"
export PI2_RUNTIME_DIR PI2_DATA_DIR PI2_STATE_DIR
mkdir -p "$PI2_RUNTIME_DIR" "$PI2_DATA_DIR" "$PI2_STATE_DIR"

"$BIN" daemon --port 0 >"$TMP/stdout.log" 2>"$TMP/daemon.log" &
PID=$!

i=0
while [ "$i" -lt 200 ]; do
    if grep -q "listening on http://" "$TMP/stdout.log" 2>/dev/null; then
        break
    fi
    kill -0 "$PID" 2>/dev/null || break
    i=$((i + 1))
    sleep 0.1
done

if ! grep -q "listening on http://" "$TMP/stdout.log" 2>/dev/null; then
    echo "FAIL daemon did not reach 'listening on http://'" >&2
    echo "--- stdout ---" >&2
    cat "$TMP/stdout.log" >&2 || true
    echo "--- stderr ---" >&2
    cat "$TMP/daemon.log" >&2 || true
    exit 1
fi
pass "daemon started and printed one listening line"

PORT="$(sed -n 's/.*"port": *\([0-9][0-9]*\).*/\1/p' "$PI2_RUNTIME_DIR/daemon.json" | head -n 1)"
if [ -z "${PORT:-}" ]; then
    echo "FAIL could not read the bound port from daemon.json" >&2
    exit 1
fi

INFO="$(curl -fsS "http://127.0.0.1:$PORT/api/v1/info")" || {
    echo "FAIL GET /api/v1/info did not answer" >&2
    exit 1
}
case "$INFO" in
    *'"v":1'*) pass "GET /api/v1/info reports protocol v1" ;;
    *)
        echo "FAIL /api/v1/info does not report \"v\":1: $INFO" >&2
        exit 1
        ;;
esac

if [ -n "$EXPECTED_VERSION" ]; then
    case "$INFO" in
        *"\"version\":\"$EXPECTED_VERSION\""*) pass "reported version is $EXPECTED_VERSION" ;;
        *)
            echo "FAIL expected version $EXPECTED_VERSION in: $INFO" >&2
            exit 1
            ;;
    esac
fi

kill -TERM "$PID" 2>/dev/null || true
set +e
wait "$PID" 2>/dev/null
EXIT_CODE=$?
set -e
PID=""
if [ "$EXIT_CODE" -ne 0 ]; then
    echo "FAIL daemon exited $EXIT_CODE after SIGTERM (expected 0)" >&2
    exit 1
fi
pass "SIGTERM -> clean exit 0"
