#!/usr/bin/env bash
# Full web-console E2E gate: API/WS suite, then the browser suite.
# Each suite gets its own isolated temp root (see lib.sh).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
overall=0

echo "==> [1/2] API/WS suite"
if ! bash "$HERE/run-api.sh"; then
    overall=1
    echo "==> API/WS suite FAILED"
fi

echo "==> [2/2] browser suite"
if ! bash "$HERE/run-ui.sh"; then
    overall=1
    echo "==> browser suite FAILED"
fi

if [ "$overall" -eq 0 ]; then
    echo "E2E OK"
else
    echo "E2E FAILED (see the artifacts printed above)"
fi
exit "$overall"
