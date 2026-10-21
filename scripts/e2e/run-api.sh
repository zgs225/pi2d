#!/usr/bin/env bash
# A0–A12: protocol/API/WS end-to-end against daemon + headless nvim + real pi.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

e2e_init api
if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then e2e_build 0; fi
e2e_start_daemon
e2e_pair "E2E API"

set +e
node "$HERE/api-e2e.mjs"
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
    E2E_KEEP=1
    e2e_log "API suite FAILED (exit $rc); artifacts: $E2E_ROOT"
fi
exit "$rc"
