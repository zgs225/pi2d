#!/usr/bin/env bash
# Shared lifecycle for the web-console end-to-end suites.
#
# Source this file, then:
#   e2e_init api          # temp dirs + trap + report dir + prereq checks
#   e2e_build             # tsc (and optionally the web bundle)
#   e2e_start_daemon      # ephemeral port, isolated runtime/data/state/agent dirs
#   e2e_pair              # CLI-token pair.create -> device token (exported)
#   e2e_add_workspace ... # workspace.add + instance.ensure, prints the workspace id
#   e2e_stop              # kill the daemon and every process started from E2E_ROOT
#
# Everything the suite starts is reachable from $E2E_ROOT: the daemon's runtime
# dir is in the nvim `--listen` path and the workspace cwd is in the pi cmdline,
# so cleanup never needs a machine-wide pkill.
#
# shellcheck shell=bash

E2E_REPO="${E2E_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
E2E_PLUGIN="${PI2_E2E_PLUGIN:-/home/yuez/Workspace/Neovim/pi2.nvim-web}"
E2E_NVIM_BIN="${PI2_NVIM_BIN:-$(command -v nvim || true)}"
E2E_PLAYWRIGHT_MODULE="${PI2_E2E_PLAYWRIGHT_MODULE:-}"

e2e_log() { printf '%s\n' "$*" >&2; }

e2e_fail() {
    e2e_log "FATAL: $*"
    e2e_log "artifacts: ${E2E_ROOT:-<uninitialised>}"
    exit 2
}

e2e_need() {
    command -v "$1" >/dev/null 2>&1 || e2e_fail "missing required command: $1"
}

e2e_init() {
    local suite="${1:?suite name}"
    E2E_SUITE="$suite"
    E2E_ROOT="$(mktemp -d "/tmp/pi2-e2e-${suite}.XXXXXX")"
    export E2E_ROOT
    export E2E_REPO E2E_PLUGIN E2E_NVIM_BIN E2E_PLAYWRIGHT_MODULE

    export PI2_RUNTIME_DIR="$E2E_ROOT/run"
    export PI2_DATA_DIR="$E2E_ROOT/data"
    export PI2_STATE_DIR="$E2E_ROOT/state"
    # The daemon (`src/core/paths.ts`) reads PI_CODING_AGENT_DIR; `pi` itself
    # reads the same variable. Keep both names in sync so discovery cannot see
    # the user's real ~/.pi/agent sessions.
    export PI_CODING_AGENT_DIR="$E2E_ROOT/agent"
    export PI2_CODING_AGENT_DIR="$E2E_ROOT/agent"
    export PI2_WORKSPACE_ROOTS="$E2E_ROOT/workspaces"
    export PI2_PORT=0
    export PI2_LOG_LEVEL="${PI2_LOG_LEVEL:-info}"
    export PI2_STATIC_DIR="${PI2_STATIC_DIR:-$E2E_REPO/web/dist}"
    export PI2_NVIM_INIT="${PI2_NVIM_INIT:-$E2E_REPO/scripts/e2e/host-init.lua}"
    export PI2_E2E_PLUGIN="$E2E_PLUGIN"
    export PI2_NVIM_BIN="$E2E_NVIM_BIN"

    mkdir -p "$PI2_RUNTIME_DIR" "$PI2_DATA_DIR" "$PI2_STATE_DIR" \
        "$PI2_CODING_AGENT_DIR" "$PI2_WORKSPACE_ROOTS" \
        "$E2E_ROOT/logs" "$E2E_ROOT/screens" "$E2E_ROOT/report"
    E2E_LOG="$E2E_ROOT/logs/$suite.log"
    : >"$E2E_LOG"

    trap e2e_stop EXIT INT TERM

    e2e_need node
    e2e_need nvim
    e2e_need pi
    e2e_need jq
    e2e_need curl
    [ -n "$E2E_NVIM_BIN" ] || e2e_fail "nvim not found"
    [ -f "$E2E_PLUGIN/lua/pi/web/commands.lua" ] ||
        e2e_fail "plugin worktree has no web layer: $E2E_PLUGIN"
    [ -f "$E2E_REPO/dist/cli/pi2.js" ] ||
        e2e_fail "dist/cli/pi2.js missing; run e2e_build"
    [ -f "$E2E_REPO/scripts/e2e/host-init.lua" ] || e2e_fail "host-init.lua missing"

    e2e_log "==> $suite root: $E2E_ROOT"
    e2e_log "    plugin: $E2E_PLUGIN ($(git -C "$E2E_PLUGIN" rev-parse --short HEAD 2>/dev/null || echo '?'))"
    e2e_log "    daemon: $E2E_REPO ($(git -C "$E2E_REPO" rev-parse --short HEAD 2>/dev/null || echo '?'))"
}

e2e_build() {
    local web="${1:-0}"
    e2e_log "==> build daemon"
    (cd "$E2E_REPO" && ./node_modules/.bin/tsc -p tsconfig.json) >>"$E2E_LOG" 2>&1 ||
        e2e_fail "daemon build failed (see $E2E_LOG)"
    if [ "$web" = "1" ]; then
        e2e_log "==> build web bundle"
        (cd "$E2E_REPO/web" && npm_config_verify_deps_before_run=false pnpm -s build) >>"$E2E_LOG" 2>&1 ||
            e2e_fail "web build failed (see $E2E_LOG)"
        [ -f "$E2E_REPO/web/dist/index.html" ] || e2e_fail "web/dist/index.html missing"
    fi
}

# Wait until the daemon publishes run/daemon.json, then environment-ready.
e2e_start_daemon() {
    local log="$E2E_ROOT/logs/daemon.log"
    : >"$log"
    e2e_log "==> starting pi2 daemon (isolated, port 0)"
    # `exec` makes $! the node process itself, not the wrapping subshell, so
    # the trap can actually stop the daemon.
    (cd "$E2E_REPO" && exec node dist/cli/pi2.js daemon --foreground >"$E2E_ROOT/logs/daemon.stdout" 2>"$log") &
    E2E_DAEMON_PID=$!
    export E2E_DAEMON_PID

    local _
    for _ in $(seq 1 200); do
        [ -f "$PI2_RUNTIME_DIR/daemon.json" ] && break
        kill -0 "$E2E_DAEMON_PID" 2>/dev/null || {
            tail -40 "$log" >&2 || true
            e2e_fail "pi2 daemon exited before writing daemon.json"
        }
        sleep 0.05
    done
    [ -f "$PI2_RUNTIME_DIR/daemon.json" ] || e2e_fail "daemon.json was not written"

    E2E_PORT="$(jq -r '.port' "$PI2_RUNTIME_DIR/daemon.json")"
    E2E_BASE="http://127.0.0.1:$E2E_PORT"
    E2E_CLI_TOKEN="$(tr -d '\n' <"$PI2_RUNTIME_DIR/cli.token")"
    export E2E_PORT E2E_BASE E2E_CLI_TOKEN

    for _ in $(seq 1 100); do
        if curl -fsS --max-time 2 "$E2E_BASE/api/v1/health" >/dev/null 2>&1; then
            break
        fi
        sleep 0.05
    done
    curl -fsS --max-time 3 "$E2E_BASE/api/v1/health" >/dev/null 2>&1 ||
        e2e_fail "daemon did not answer /api/v1/health"
    e2e_log "    listening on $E2E_BASE"
}

e2e_api() { # e2e_api <method> <path> [curl args...]
    local method="$1" path="$2"
    shift 2
    curl -sS --max-time 30 -X "$method" \
        -H "Authorization: Bearer $E2E_CLI_TOKEN" \
        -H 'Content-Type: application/json' "$@" "$E2E_BASE$path"
}

e2e_cmd() { # e2e_cmd '<json>'
    e2e_api POST /api/v1/cmd -d "${1:?json body}"
}

e2e_http_status() { # e2e_http_status <method> <path> [curl args...]
    local method="$1" path="$2"
    shift 2
    curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X "$method" \
        -H "Authorization: Bearer $E2E_CLI_TOKEN" \
        -H 'Content-Type: application/json' "$@" "$E2E_BASE$path"
}

e2e_pair() {
    local name="${1:-E2E browser}"
    local created code token
    created="$(e2e_cmd '{"method":"pair.create","params":{"ttlSec":600}}')" ||
        e2e_fail "pair.create failed"
    code="$(jq -r '.code // empty' <<<"$created")"
    [ -n "$code" ] || e2e_fail "pair.create returned no code: $created"

    token="$(curl -sS --max-time 10 -X POST -H 'Content-Type: application/json' \
        -d "{\"code\":\"$code\",\"deviceName\":\"$name\",\"kind\":\"laptop\"}" \
        "$E2E_BASE/api/v1/pair" | jq -r '.token // empty')"
    [ -n "$token" ] || e2e_fail "pair redeem failed"
    E2E_DEVICE_TOKEN="$token"
    E2E_PAIR_CODE="$code"
    export E2E_DEVICE_TOKEN E2E_PAIR_CODE
    e2e_log "    paired device ${token:0:8}…"
}

e2e_add_workspace() { # e2e_add_workspace <dir> -> workspace id on stdout
    local dir="$1" resp id
    mkdir -p "$dir"
    resp="$(e2e_cmd "$(jq -nc --arg cwd "$dir" '{method:"workspace.add",params:{cwd:$cwd,trust:true}}')")" ||
        e2e_fail "workspace.add failed for $dir"
    id="$(jq -r '.workspace.workspaceId // .workspaceId // empty' <<<"$resp")"
    [ -n "$id" ] || e2e_fail "workspace.add returned no id: $resp"
    printf '%s' "$id"
}

e2e_ensure_instance() { # e2e_ensure_instance <workspaceId> [timeout-seconds]
    local id="$1" timeout="${2:-20}" status
    e2e_cmd "$(jq -nc --arg id "$id" '{method:"instance.ensure",params:{workspaceId:$id}}')" >/dev/null ||
        e2e_fail "instance.ensure failed for $id"
    for _ in $(seq 1 $((timeout * 10))); do
        status="$(e2e_api GET /api/v1/workspaces |
            jq -r --arg id "$id" '.[] | select(.workspaceId==$id) | .instance.status // empty')"
        case "$status" in
        ready) return 0 ;;
        degraded | stopped) e2e_fail "instance $id became $status" ;;
        esac
        sleep 0.1
    done
    e2e_fail "instance $id was not ready within ${timeout}s (last: ${status:-unknown})"
}

# PIDs that belong to this run. The daemon does not carry E2E_ROOT in argv,
# so also match its environment (PI2_RUNTIME_DIR is inherited by the managed
# nvim hosts and their pi children).
e2e_pids() {
    local pid
    {
        ps -eo pid=,args= | grep -F -- "$E2E_ROOT" | grep -v -F -- 'grep -F' | awk '{print $1}' || true
        for pid in $(pgrep -f 'pi2\.js daemon|pi\.host|pi --mode rpc|nvim --headless' 2>/dev/null || true); do
            if tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null |
                grep -Fxq "PI2_RUNTIME_DIR=$PI2_RUNTIME_DIR"; then
                echo "$pid"
            fi
        done
    } | sort -u
}

# Kill every process that belongs to this run (daemon, managed nvim hosts and
# their pi children), then verify nothing is left behind.
e2e_reap() {
    local pids pid
    pids="$(e2e_pids)"
    for pid in $pids; do
        kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 0.2
    pids="$(e2e_pids)"
    for pid in $pids; do
        kill -KILL "$pid" 2>/dev/null || true
    done
    sleep 0.1
    pids="$(e2e_pids)"
    if [ -n "$pids" ]; then
        e2e_log "WARN: processes still reference $E2E_ROOT: $pids"
    fi
}

e2e_stop() {
    local code=$?
    trap - EXIT INT TERM
    if [ -n "${E2E_DAEMON_PID:-}" ]; then
        kill -TERM "$E2E_DAEMON_PID" 2>/dev/null || true
        for _ in $(seq 1 100); do
            kill -0 "$E2E_DAEMON_PID" 2>/dev/null || break
            sleep 0.05
        done
        kill -KILL "$E2E_DAEMON_PID" 2>/dev/null || true
        wait "$E2E_DAEMON_PID" 2>/dev/null || true
    fi
    e2e_reap
    if [ "${E2E_KEEP:-0}" = "1" ]; then
        e2e_log "artifacts kept: $E2E_ROOT"
    else
        rm -rf "$E2E_ROOT"
    fi
    exit "$code"
}
