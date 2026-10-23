#!/usr/bin/env bash
# Verify a published `@yuez/pi2d` release end to end.
#
#   bash .agents/skills/release/scripts/verify-release.sh <x.y.z>
#
# Checks, in order: the registry carries that exact version, the provenance
# attestation is present, a clean install from the public registry reports the
# same version, the packaged daemon boots and serves the console + health, and
# the GitHub release exists. Every line is PASS/FAIL/INFO; the script exits
# non-zero when any check fails.
set -uo pipefail

PKG="@yuez/pi2d"
REPO="zgs225/pi2d"
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "usage: verify-release.sh <x.y.z>" >&2
    exit 2
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pi2d-verify-release.XXXXXX")
DPID=""
cleanup() {
    [ -n "$DPID" ] && kill "$DPID" 2>/dev/null
    [ -n "$DPID" ] && wait "$DPID" 2>/dev/null
    rm -rf "$WORK"
}
trap cleanup EXIT

FAILED=0
pass() { printf 'PASS  %-42s %s\n' "$1" "${2:-}"; }
fail() { printf 'FAIL  %-42s %s\n' "$1" "${2:-}"; FAILED=1; }
info() { printf 'INFO  %-42s %s\n' "$1" "${2:-}"; }

# 1 — the registry has this version -----------------------------------------
PUBLISHED=$(npm view "$PKG@$VERSION" version 2>/dev/null)
if [ "$PUBLISHED" = "$VERSION" ]; then
    pass "registry version" "$PKG@$PUBLISHED"
else
    fail "registry version" "expected $VERSION, got '${PUBLISHED:-<missing>}'"
fi

LATEST=$(npm view "$PKG" dist-tags.latest 2>/dev/null)
if [ "$LATEST" = "$VERSION" ]; then
    pass "dist-tag latest" "$LATEST"
else
    info "dist-tag latest" "$LATEST (this release is not the latest tag)"
fi

# 2 — provenance -------------------------------------------------------------
PREDICATE=$(npm view "$PKG@$VERSION" dist.attestations.provenance.predicateType 2>/dev/null)
case "$PREDICATE" in
    *slsa.dev/provenance*) pass "provenance attestation" "$PREDICATE" ;;
    "") fail "provenance attestation" "none (bootstrap version? published outside CI?)" ;;
    *) fail "provenance attestation" "unexpected predicate $PREDICATE" ;;
esac

# 3 — a clean install from the public registry -------------------------------
if npm i -g --prefix "$WORK/prefix" --no-audit --no-fund "$PKG@$VERSION" >"$WORK/install.log" 2>&1; then
    pass "clean global install" "$(tail -1 "$WORK/install.log")"
else
    fail "clean global install" "see $WORK/install.log"
fi
PI2="$WORK/prefix/bin/pi2"
if [ -x "$PI2" ]; then
    INSTALLED=$("$PI2" --version 2>&1 | head -1)
    if [ "$INSTALLED" = "pi2 $VERSION" ]; then
        pass "installed binary version" "$INSTALLED"
    else
        fail "installed binary version" "expected 'pi2 $VERSION', got '$INSTALLED'"
    fi
    PKG_DIR="$WORK/prefix/lib/node_modules/$PKG"
    for f in "web/dist/index.html" "dist/cli/pi2.js" "LICENSE"; do
        if [ -e "$PKG_DIR/$f" ]; then
            pass "tarball ships" "$f"
        else
            fail "tarball ships" "$f missing"
        fi
    done
else
    fail "installed binary version" "no $PI2"
fi

# 4 — the daemon boots and serves --------------------------------------------
export PI2_RUNTIME_DIR="$WORK/rt" PI2_DATA_DIR="$WORK/data" PI2_STATE_DIR="$WORK/state"
if [ -x "$PI2" ]; then
    "$PI2" daemon -p 0 >"$WORK/daemon.out" 2>"$WORK/daemon.err" &
    DPID=$!
    for _ in $(seq 1 150); do [ -f "$WORK/rt/daemon.json" ] && break; sleep 0.1; done
    if [ -f "$WORK/rt/daemon.json" ]; then
        PORT=$(node -pe "JSON.parse(require('fs').readFileSync('$WORK/rt/daemon.json','utf8')).port" 2>/dev/null)
        pass "daemon start" "$(head -1 "$WORK/daemon.out")"
        CODE=$(curl -s -o "$WORK/index.html" -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/")
        [ "$CODE" = "200" ] && pass "GET / serves the console" "200, $(wc -c <"$WORK/index.html" | tr -d ' ') bytes" \
            || fail "GET / serves the console" "HTTP $CODE"
        HEALTH=$(curl -s --max-time 10 "http://127.0.0.1:$PORT/api/v1/health")
        if printf '%s' "$HEALTH" | grep -q '"ok":true'; then
            pass "health ok" "$(printf '%s' "$HEALTH" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).items.map(i=>i.name+"="+(i.ok?"ok":"FAIL")).join(" ")' 2>/dev/null)"
        else
            fail "health ok" "${HEALTH:-<no response>}"
        fi
        kill "$DPID" 2>/dev/null; wait "$DPID" 2>/dev/null; DPID=""
        [ -f "$WORK/rt/daemon.lock" ] && fail "clean shutdown" "daemon.lock left behind" \
            || pass "clean shutdown" "lock + daemon.json removed"
    else
        fail "daemon start" "$(tail -2 "$WORK/daemon.err" | tr '\n' ' ')"
    fi
fi

# 5 — the GitHub release -----------------------------------------------------
if command -v gh >/dev/null 2>&1; then
    if gh release view "v$VERSION" --repo "$REPO" --json url --jq .url >"$WORK/release.url" 2>/dev/null; then
        pass "GitHub release" "$(cat "$WORK/release.url")"
    else
        info "GitHub release" "no release for v$VERSION (informational)"
    fi
else
    info "GitHub release" "gh not installed, skipped"
fi

echo
if [ "$FAILED" -eq 0 ]; then
    echo "OK — $PKG@$VERSION is published and usable."
else
    echo "FAILED — see the FAIL lines above." >&2
fi
exit "$FAILED"
