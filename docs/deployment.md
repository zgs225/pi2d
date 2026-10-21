# Deployment and operations

`pi2d` is the pi2 web-console daemon. It owns the HTTP/WS surface, the
workspace registry, the instance supervisor (one managed nvim per workspace)
and the device/CLI auth. This document covers running it, its runtime files,
the `pi2` CLI and the day-to-day ops commands.

```
browser ──HTTP + WS/SSE──▶ pi2d ──JSONL over unix socket──▶ plugin (nvim)
                             ▲
                    pi2 CLI │ (HTTP, local admin token)
```

Contents

1. [Requirements](#1-requirements)
2. [Build](#2-build)
3. [Running the daemon](#3-running-the-daemon)
4. [Configuration](#4-configuration)
5. [Runtime files](#5-runtime-files)
6. [Ports and the singleton lock](#6-ports-and-the-singleton-lock)
7. [Authentication](#7-authentication)
8. [The `pi2` CLI](#8-the-pi2-cli)
9. [Services (systemd / launchd)](#9-services-systemd--launchd)
10. [Logs and health](#10-logs-and-health)
11. [Restart and shutdown semantics](#11-restart-and-shutdown-semantics)
12. [Smoke test](#12-smoke-test)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Requirements

| Component | Requirement | Needed for |
|---|---|---|
| Node | **>= 22** (`engines` field) | daemon + CLI |
| Neovim | **>= 0.9** | managed instances; `nvim --remote-ui` for `pi2 attach` |
| pi CLI | any recent version | agent sessions inside nvim |
| pi2.nvim | `lua/pi/web/bridge.lua` present | the plugin that dials the daemon |

`pi2 doctor` checks all of the above (see [§8.3](#83-pi2-doctor)).

## 2. Build

```bash
pnpm install
pnpm build            # tsc -> dist/ (dist/cli/pi2d.js, dist/cli/pi2.js)
pnpm --dir web build  # optional: web/dist for the browser console
```

`pi2d` serves the browser console from `<repo>/web/dist` (or `PI2_STATIC_DIR`).
Without it `/` returns 404/SPA fallback behaviour and `/api/v1/health` reports
`static=FAIL`; the API and `pi2` keep working.

Binaries: `dist/cli/pi2d.js` (daemon, `pi2d`) and `dist/cli/pi2.js` (client,
`pi2`). Both are ESM and start with a `#!` line.

## 3. Running the daemon

```bash
node dist/cli/pi2d.js --foreground          # or: pnpm dev  (tsx watch)
```

Exactly one line goes to **stdout**:

```
pi2d listening on http://127.0.0.1:7676
```

Every log record is JSONL on **stderr** (that is what systemd/launchd capture).

Flags:

| Flag | Meaning |
|---|---|
| `--port <n>` | TCP port; `0` = ephemeral (the real port lands in `daemon.json`) |
| `--host <addr>` | bind address (default `127.0.0.1`) |
| `--static-dir <p>` | built web UI directory |
| `--force` | take the lock even if another `pi2d` holds it |
| `--foreground` | stay attached to the terminal (default; used by unit files) |
| `--version`, `--help` | print and exit |

Flags are applied to the environment before the config is loaded, so
`--port 8000` is equivalent to `PI2_PORT=8000`.

Daemon startup order: take `daemon.lock` → mint `cli.token` → start the plugin
unix socket → listen (with port retry) → write `daemon.json` → print the line.
The token is rotated only by the process that owns the lock, so a rejected
second daemon cannot invalidate the running one.

## 4. Configuration

Everything is environment-driven (`src/config.ts` + `src/core/paths.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PI2_PORT` | `7676` | HTTP/WS port, `0` = ephemeral |
| `PI2_HOST` | `127.0.0.1` | bind address |
| `PI2_STATIC_DIR` | `<repo>/web/dist` | built web UI |
| `PI2_ORIGINS` | `http://127.0.0.1:<port>,http://localhost:<port>` | CORS/Origin allowlist (comma separated) |
| `PI2_RUNTIME_DIR` | Linux `$XDG_RUNTIME_DIR/pi2`, macOS `~/Library/Caches/pi2/run` | sockets, lock, tokens |
| `PI2_DATA_DIR` | Linux `$XDG_DATA_HOME/pi2`, macOS `~/Library/Application Support/pi2` | `devices.json`, `workspaces.json` |
| `PI2_STATE_DIR` | Linux `$XDG_STATE_HOME/pi2`, macOS `~/Library/Logs/pi2` | instance logs |
| `PI2_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`/`silent` |
| `PI2_WORKSPACE_ROOTS` | `$HOME` | allowlist for `workspace.add` |
| `PI2_PLUGIN_DIR` | `~/.local/share/nvim/lazy/pi2.nvim` | plugin location for `pi2 doctor` |
| `PI2_NVIM_BIN` | `nvim` | binary used for managed instances |
| `PI2_NVIM_INIT` | – | extra `-u <init>` for managed instances |
| `PI2_CODING_AGENT_DIR` | `~/.pi/agent` | pi session storage (discovery) |

There is no config file: the environment *is* the configuration.

## 5. Runtime files

All of these live in `PI2_RUNTIME_DIR` (created `0700`):

| File | Mode | Purpose |
|---|---|---|
| `d.sock` | `0600` | plugin ↔ daemon JSONL socket (nvim dials it) |
| `d.sock.token` | `0600` | handshake token for `hello`; rotated per daemon start |
| `daemon.lock` | `0600` | singleton lock: `{pid, bootId, port, daemonId, startedAt, protocolVersion}` |
| `daemon.json` | `0600` | same payload, written **after** `listen()` so tools learn the real port |
| `cli.token` | `0600` | 32-byte hex local admin token, rotated per daemon start |

Plus `i/` (per-instance nvim `--listen` sockets) and, under `PI2_STATE_DIR`,
`instances/<instanceId>.log` for spawned nvim output.

`daemon.lock` and `daemon.json` are removed on a clean shutdown; a stale pair
from a crash is detected as stale (dead pid **or** different boot id) and
overwritten on the next start.

## 6. Ports and the singleton lock

- One daemon per runtime dir. A second `pi2d` exits `1` with
  `pi2d: another pi2d is running (pid …, port …); use --force to override`.
- `--force` takes over the lock; the displaced daemon keeps serving until it
  exits, and it will *not* delete the new lock on shutdown (ownership is
  checked by pid + `daemonId`).
- **Default-port retry:** when the port comes from the default (`7676`, no
  `--port`, no `PI2_PORT`), `EADDRINUSE` walks `+1 … +9` (`7677`–`7685`) and
  logs a warning per attempt. An explicitly configured port never moves —
  a conflict there is an error.
- Derived CORS origins follow the effective port, so a bumped port still works
  from the browser.

## 7. Authentication

Two token kinds:

1. **Device tokens** (paired phones/laptops): created by `POST /api/v1/pair`
   (redeem) or `pair.create`; only SHA-256 hashes are stored in
   `PI2_DATA_DIR/devices.json`.
2. **Local CLI token**: `PI2_RUNTIME_DIR/cli.token`, minted by `pi2d` on each
   start. Any request carrying it authenticates as the synthetic device
   `{id:"local-cli", name:"local CLI", scopes:["read","steer","control","admin"]}`
   (constant-time compare, never persisted, not revocable, not listed by
   `GET /api/v1/devices`). Rotating the file invalidates the old value
   immediately.

`GET /api/v1/info` and `GET /api/v1/health` are readable from loopback without
a token; everything else under `/api/*` needs `Authorization: Bearer …`.
Unknown `/api/*` paths answer `401` when unauthenticated and `404` when
authenticated (auth runs before routing).

## 8. The `pi2` CLI

`pi2` discovers the daemon from `daemon.json` (port) and `cli.token` (auth) in
`PI2_RUNTIME_DIR`, so it needs no flags. Every command exits non-zero with a
one-line `pi2: …` message on failure.

### 8.1 `pi2 attach [path]`

```bash
pi2 attach              # current directory
pi2 attach ../other
```

Resolves the path (`realpath`), lists workspaces, and looks for the one whose
`cwd` matches:

- **instance with a listen address** (`ready`/`degraded`): with a TTY,
  `exec nvim --server <listenAddr> --remote-ui`; without a TTY it prints the
  command and exits `0`.
- **no instance** (or no daemon at all): `exec nvim` in that directory — the
  plugin registers itself, the daemon does not spawn a headless nvim.

`attach` never spawns a managed (headless) instance; that only happens through
`instance.ensure` (browser/API).

### 8.2 `pi2 status [--json]`

Shows daemon identity (URL, `daemonId`, protocol `v`, platform), a table of
instances (`workspace`, `cwd`, `status`, `ui`, `sessions`, `pid`), the resource
summary (RSS total vs physical memory and the soft-limit warning) and the
health items. Exits `1` when `/api/v1/health` is not ok. `--json` prints one
object `{daemon, instances, resources, health}`.

### 8.3 `pi2 doctor [--json]`

| Check | Fails when | Warns when |
|---|---|---|
| `node` | < 22 | – |
| `nvim` | missing, or < 0.9 | version unparsable |
| `pi` | – | not on `PATH` |
| `plugin` | `lua/pi/web/bridge.lua` not found | – |
| `runtime-dir` | missing | mode not `0700` |
| `cli-token` | mode not `0600` | missing (daemon not started yet) |
| `socket` | `d.sock` missing (and no daemon) | missing but daemon answers |
| `daemon` | `/api/v1/info` unreachable | – |
| `port` | – (reports bound/free) | – |
| `service-manager` | – | systemd/launchd not found |
| `linger` (Linux) | – | `Linger=no` |
| `web-dist` | – | missing |
| `protocol` | daemon `v` ≠ CLI `v` | – |

`--json` emits `{ok, checks:[{name,status,detail}]}` (`status` ∈ `ok|warn|fail`);
only `fail` makes `ok:false`/exit `1`. All probes are injectable, so the checks
are unit tested without touching the host.

### 8.4 `pi2 pairing`

`POST /api/v1/pair` with the local token and prints:

```
url     http://127.0.0.1:7676/pair/ABCD2345
code    ABCD2345
expires 2026-10-21T04:30:15.085Z (600s)
qr      {"v":1,"code":"ABCD2345","url":"…","expiresAt":…,"nonce":"…"}
```

The URL is rebuilt from the *actual* daemon base URL because the daemon's own
`url` field is derived from the configured port (stale after a retry or
`--port 0`).

### 8.5 `pi2 install-service` / `pi2 uninstall-service`

See [§9](#9-services-systemd--launchd). `--dry-run` (default) prints the file
and the follow-up commands; `--write` writes the file (`0644`) and prints the
commands. The CLI never executes `systemctl`/`launchctl`.

## 9. Services (systemd / launchd)

```bash
pi2 install-service --dry-run     # inspect, nothing written
pi2 install-service --write       # ~/.config/systemd/user/pi2d.service
systemctl --user daemon-reload
systemctl --user enable --now pi2d.service
```

The unit is rendered with absolute paths:

```ini
[Unit]
Description=pi2 daemon (pi2d)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /repo/dist/cli/pi2d.js --foreground
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

`XDG_CONFIG_HOME` is honoured for the target directory. On macOS the same
command writes `~/Library/LaunchAgents/com.pi2.pi2d.plist` (`RunAtLoad`,
`KeepAlive`, absolute node + script paths, `StandardOutPath`/`StandardErrorPath`
under `PI2_STATE_DIR`) and prints:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi2.pi2d.plist
launchctl enable gui/$(id -u)/com.pi2.pi2d
```

`uninstall-service --write` removes the file and prints the disable commands.
For a login-less service to keep running on Linux enable linger
(`loginctl enable-linger $USER`, `pi2 doctor` warns when it is off).

## 10. Logs and health

- `pi2d` logs JSONL to stderr: `systemctl --user status pi2d` /
  `journalctl --user -u pi2d -f` on Linux, `~/Library/Logs/pi2/pi2d.log` on
  macOS. Raise verbosity with `PI2_LOG_LEVEL=debug` (in the unit's
  `Environment=` line) .
- Managed nvim output: `PI2_STATE_DIR/instances/<instanceId>.log`.
- `GET /api/v1/health` → `{ok, items:[{name, ok, detail}]}` (`instances`,
  `workspaces`, `auth`, `static`). `instances` fails when a managed instance is
  `degraded`; `workspaces` fails when every known workspace path is gone (ghost
  discovery entries are normal and only shown in `detail`); `auth` fails when
  there is neither an active device nor a local `cli.token`; `static` fails when
  `PI2_STATIC_DIR` is missing.
- `GET /api/v1/diagnostics` → uptime, connection count, event rate, slow
  queries, device/workspace/instance counts.
- `GET /api/v1/resources` → per-instance RSS, total vs physical memory, soft
  warning (`instances > 8` or RSS > 60 %).

## 11. Restart and shutdown semantics

- **SIGINT/SIGTERM/SIGHUP** (`pi2d`): close HTTP + WS, close the plugin socket,
  release `daemon.lock`/`daemon.json`, exit `0`. **Managed nvim processes are
  not stopped** — they keep running and reconnect (exponential backoff,
  200 ms → 5 s) the next time the daemon starts.
- `instance.shutdown {mode:"drain"|"stop"}` stops one instance (drain first,
  SIGTERM, then SIGKILL).
- `system.shutdown` (daemon-owned command) stops every managed instance before
  the daemon is expected to exit. Note: the current router ignores the `drain`
  parameter and stops instances with `mode:"stop"`.
- A crashed daemon leaves `d.sock`/`daemon.lock` behind; both are handled on
  the next start (socket unlinked, lock detected as stale).

## 12. Smoke test

```bash
bash scripts/smoke.sh
```

Builds, starts `pi2d` on an ephemeral port with throwaway
`PI2_RUNTIME_DIR`/`PI2_DATA_DIR`/`PI2_STATE_DIR`, waits for `daemon.json`, then
asserts: `/api/v1/info` (200, `v=1`), `/api/v1/health` (200 ok), `/` (200 html
from `web/dist`), `/api/v1/nope` (404 with token, 401 without),
`/api/v1/workspaces` (200 array with the CLI token, 401 without/with a bogus
token), the `cli.token` format/mode, the lock payload, and a clean `SIGTERM`
exit with lock + `daemon.json` removed. Prints one `PASS` line per assertion.
`PI2_SMOKE_KEEP=1` keeps the temp dir (and `pi2d` log) for debugging.

## 13. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `pi2d: another pi2d is running (pid …)` | a live daemon owns this runtime dir. Stop it, or `--force` |
| `pi2: no running pi2d (…/daemon.json missing)` | daemon not started, or started with a different `PI2_RUNTIME_DIR` |
| `pi2: missing CLI token (…/cli.token)` | token deleted or daemon restarted; restart `pi2d` |
| `401 E_UNAUTHORIZED` from `curl` | send `Authorization: Bearer $(cat $PI2_RUNTIME_DIR/cli.token)` |
| `EADDRINUSE` on an explicit port | pick another `--port` (only the default port retries) |
| `403` with the browser console | origin not in `PI2_ORIGINS` (derived from the port) |
| `health: static=FAIL` | `web/dist` missing — build the web UI or set `PI2_STATIC_DIR` |
| Browser console loads but no workspaces | no nvim with the plugin has connected yet; run `pi2 attach` in a project |
| `pi2 doctor` → `plugin FAIL` | install pi2.nvim, or point `PI2_PLUGIN_DIR` at the checkout |
| `pi2 doctor` → `linger warn` | services stop at logout; `loginctl enable-linger $USER` |
| Instances gone after a wifi/laptop sleep | daemon restarted: nvim reconnects automatically; check `pi2 status` |
