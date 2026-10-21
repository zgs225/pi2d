#!/usr/bin/env bash
# B1–B14 + C1–C4: Playwright against the daemon-served production bundle.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

e2e_init ui
if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then e2e_build 1; fi
e2e_start_daemon
e2e_pair "E2E browser"

# The browser suite creates its own workspaces (through the API and through the
# UI), so lib.sh only provides the paired daemon here.
set +e
node "$HERE/ui-e2e.mjs"
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
    E2E_KEEP=1
    e2e_log "UI suite FAILED (exit $rc); artifacts: $E2E_ROOT"
fi
exit "$rc"
