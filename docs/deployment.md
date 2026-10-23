# Deployment and operations

`pi2 daemon` is the pi2 web-console daemon. It owns the HTTP/WS surface, the
workspace registry, the instance supervisor (one managed nvim per workspace)
and the device/CLI auth. It is **a subcommand of the single shipped `pi2`
binary**, not a separate executable. This document covers running it, its
runtime files, the `pi2` CLI and the day-to-day ops commands.

```
browser ──HTTP + WS/SSE──▶ pi2 daemon ──JSONL over unix socket──▶ plugin (nvim)
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
   - [`pi2 daemon [start]`](#80-pi2-daemon-start)
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
pnpm build            # tsc -> dist/ (dist/cli/pi2.js)
pnpm --dir web build  # optional: web/dist for the browser console
```

The daemon serves the browser console from `<repo>/web/dist` (or `PI2_STATIC_DIR`).
Without it `/` returns 404/SPA fallback behaviour and `/api/v1/health` reports
`static=FAIL`; the API and `pi2` keep working.

There is exactly one built binary, `dist/cli/pi2.js` (client commands **and** the
`daemon` subcommand). It is ESM and starts with a `#!` line.

## 3. Running the daemon

The daemon is a subcommand of the single `pi2` binary (there is no separate
executable to install or ship):

```bash
node dist/cli/pi2.js daemon --foreground    # or: pnpm dev  (tsx watch)
```

`pi2 daemon`, `pi2 daemon start` (alias) and `pi2 daemon --foreground` all start
the same foreground process — `main` is dispatched from `src/cli/pi2.ts` to
`src/cli/daemon.ts` and the `start` positional is dropped before parsing. There
is no detaching mode; that is what the systemd/launchd units below rely on.

`pi2 daemon --help` prints the usage block (`Usage: pi2 daemon [start] [options]`),
`pi2 daemon --version` prints `pi2 <version>`, and an unknown daemon positional
exits `2` without starting anything.

Exactly one line goes to **stdout**:

```
pi2 daemon listening on http://127.0.0.1:7676
```

Every log record is JSONL on **stderr** (that is what systemd/launchd capture).
Every daemon error is one line on stderr prefixed `pi2: `.

Flags (`pi2 daemon [start] …`):

| Flag | Meaning |
|---|---|
| `--port <n>`, `-p <n>` | TCP port; `0` = ephemeral (the real port lands in `daemon.json`) |
| `--host <addr>` | bind address (default `127.0.0.1`) |
| `--static-dir <p>` | built web UI directory |
| `--force`, `-f` | take the lock even if another `pi2 daemon` holds it |
| `--foreground` | stay attached to the terminal (default; used by unit files) |
| `--version`, `-V` | print `pi2 <version>` and exit |
| `--help`, `-h` | print the usage block and exit |

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
| `PI2_HOST` | `127.0.0.1` (`0.0.0.0` in `lan` mode) | bind address; wins over the mode default |
| `PI2_ACCESS_MODE` | `local` | `local` / `lan` / `tailscale` (see below) |
| `PI2_PUBLIC_URL` | – | external base URL, e.g. `https://myhost.tail1234.ts.net` (no trailing slash) |
| `PI2_ORIGINS` | – | **extra** CORS/Origin allowlist entries (comma separated), added to the derived origins |
| `PI2_STATIC_DIR` | `<repo>/web/dist` | built web UI |
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

### Access modes

| `PI2_ACCESS_MODE` | bind (unless `PI2_HOST`) | derived `corsOrigins` |
|---|---|---|
| `local` (default) | `127.0.0.1` | `http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>` |
| `lan` | `0.0.0.0` | loopback three **plus** `http://<detected-lan-ip>:<port>` |
| `tailscale` | `127.0.0.1` | loopback three **plus** the origin of `PI2_PUBLIC_URL` |

Origins are normalized (trailing `/` stripped, empties dropped) and
`PI2_ORIGINS` is appended — never a replacement. LAN detection is best effort:
when the address is unknown that extra origin is simply skipped. `tailscale`
assumes `tailscale serve` terminates TLS in front of the loopback daemon; the
daemon never does TLS itself. An unknown mode fails startup with one line:
`pi2: PI2_ACCESS_MODE must be local, lan or tailscale`. Changing the mode
requires restarting `pi2 daemon`.

## 5. Runtime files

All of these live in `PI2_RUNTIME_DIR` (created `0700`):

| File | Mode | Purpose |
|---|---|---|
| `d.sock` | `0600` | plugin ↔ daemon JSONL socket (nvim dials it) |
| `d.sock.token` | `0600` | handshake token for `hello`; rotated per daemon start |
| `daemon.lock` | `0600` | singleton lock: `{pid, bootId, port, daemonId, startedAt, protocolVersion, access?, publicUrl?}` |
| `daemon.json` | `0600` | same payload, written **after** `listen()` so tools learn the real port |
| `cli.token` | `0600` | 32-byte hex local admin token, rotated per daemon start |

Plus `i/` (per-instance nvim `--listen` sockets) and, under `PI2_STATE_DIR`,
`instances/<instanceId>.log` for spawned nvim output.

`daemon.lock` and `daemon.json` are removed on a clean shutdown; a stale pair
from a crash is detected as stale (dead pid **or** different boot id) and
overwritten on the next start.

## 6. Ports and the singleton lock

- One daemon per runtime dir. A second `pi2 daemon` exits `1` with
  `pi2: another pi2 daemon is running (pid …, port …); use --force to override`.
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
2. **Local CLI token**: `PI2_RUNTIME_DIR/cli.token`, minted by `pi2 daemon` on
   each start. Any request carrying it authenticates as the synthetic device
   `{id:"local-cli", name:"local CLI", scopes:["read","steer","control","admin"]}`
   (constant-time compare, never persisted, not revocable, not listed by
   `GET /api/v1/devices`). Rotating the file invalidates the old value
   immediately.

`GET /api/v1/info` and `GET /api/v1/health` are readable from loopback without
a token; everything else under `/api/*` needs `Authorization: Bearer …`.
Unknown `/api/*` paths answer `401` when unauthenticated and `404` when
authenticated (auth runs before routing).

### Local-browser login (`POST /api/v1/console/session`)

`pi2 open` calls this endpoint (loopback **and** local CLI token required) to
sign the browser in without a pairing code: it rotates the single
`local browser` device (`kind:"laptop"`, all four scopes) and answers
`{token, device, url}` with
`url = http://127.0.0.1:<actual bound port>/#t=<token>`. The token lives in the
fragment, so it never reaches a request line, a `Referer` header or a proxy
access log, and the daemon never logs it. Every call rotates the token (same
device `id`) and invalidates the previous URL.

Non-loopback callers get `403 E_FORBIDDEN` (`console login is loopback-only`);
remote browsers pair instead (see §8.5).

## 8. The `pi2` CLI

`pi2` discovers the daemon from `daemon.json` (port) and `cli.token` (auth) in
`PI2_RUNTIME_DIR`, so it needs no flags. Every command exits non-zero with a
one-line `pi2: …` message on failure.

### 8.0 `pi2 daemon [start]`

```bash
pi2 daemon                  # foreground; the plugin/browser needs this running
pi2 daemon start            # same thing (explicit subcommand alias)
pi2 daemon --foreground     # same thing (the flag is the default)
pi2 daemon -p 0             # ephemeral port
pi2 daemon --help           # Usage: pi2 daemon [start] [options]
```

All three forms start the identical foreground process; the `start` positional is
dropped before the flag parser runs, and an unknown daemon positional exits `2`.
The daemon is dispatched *inside* `pi2` (`src/cli/pi2.ts` → `src/cli/daemon.ts`):
it is not a separate executable, nothing is re-exec'd, and there is no detaching
mode. Flags, stdout contract and startup order: [§3](#3-running-the-daemon).

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
| `access` | `lan`/`tailscale` with a non-loopback bind and no `PI2_PUBLIC_URL` | `lan`/`tailscale` (adds `— no TLS, prefer \`tailscale serve\`` without an `https:` public URL) |
| `service-manager` | – | systemd/launchd not found |
| `linger` (Linux) | – | `Linger=no` |
| `web-dist` | – | missing |
| `protocol` | daemon `v` ≠ CLI `v` | – |

`--json` emits `{ok, checks:[{name,status,detail}]}` (`status` ∈ `ok|warn|fail`);
only `fail` makes `ok:false`/exit `1`. All probes are injectable, so the checks
are unit tested without touching the host.

### 8.4 `pi2 open [--print] [--no-browser]`

```bash
pi2 open              # mint a loopback session and open the browser, signed in
pi2 open --print      # print the signed-in URL only (implies --no-browser)
pi2 open --no-browser # print the URL instead of launching a browser
```

Resolves `daemon.json` + `cli.token`, `POST`s `/api/v1/console/session`, then
launches `xdg-open` (Linux) / `open` (macOS) detached. The opener never blocks
the command: if it is missing or fails, `pi2 open` prints the URL and still
exits `0`. This is a local-only shortcut; use `pi2 pairing` for LAN/Tailscale
browsers.

### 8.5 `pi2 pairing [--public-url <url>]`

`POST /api/v1/pair` with the local token and prints:

```
url     http://127.0.0.1:7676/pair/ABCD2345
code    ABCD2345
expires 2026-10-21T04:30:15.085Z (600s)
qr      {"v":1,"code":"ABCD2345","url":"…","expiresAt":…,"nonce":"…"}
```

The URL is rebuilt from the *actual* daemon base URL because the daemon's own
`url` field is derived from the configured port (stale after a retry or
`--port 0`). `--public-url <url>` rebuilds both the printed `url` and the QR
payload's `url` on that base (e.g. `https://host.ts.net/pair/ABCD2345`); it
defaults to `daemon.json`'s `publicUrl`, then `PI2_PUBLIC_URL`. The code, expiry
and nonce are unchanged.

### 8.6 `pi2 install-service` / `pi2 uninstall-service`

See [§9](#9-services-systemd--launchd). `--dry-run` (default) prints the file
and the follow-up commands; `--write` writes the file (`0644`) and prints the
commands. The CLI never executes `systemctl`/`launchctl`.

## 9. Services (systemd / launchd)

```bash
pi2 install-service --dry-run     # inspect, nothing written
pi2 install-service --write       # ~/.config/systemd/user/pi2.service
systemctl --user daemon-reload
systemctl --user enable --now pi2.service
```

The unit is rendered with absolute paths:

```ini
[Unit]
Description=pi2 daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /repo/dist/cli/pi2.js daemon --foreground
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

`XDG_CONFIG_HOME` is honoured for the target directory. On macOS the same
command writes `~/Library/LaunchAgents/com.pi2.daemon.plist` (`RunAtLoad`,
`KeepAlive`, absolute node + script paths, `ProgramArguments`
`node /repo/dist/cli/pi2.js daemon --foreground`, `StandardOutPath`/
`StandardErrorPath` under `PI2_STATE_DIR`) and prints:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi2.daemon.plist
launchctl enable gui/$(id -u)/com.pi2.daemon
```

`uninstall-service --write` removes the file and prints the disable commands.
For a login-less service to keep running on Linux enable linger
(`loginctl enable-linger $USER`, `pi2 doctor` warns when it is off).

## 10. Logs and health

- `pi2 daemon` logs JSONL to stderr: `systemctl --user status pi2` /
  `journalctl --user -u pi2 -f` on Linux (`pi2.service`), and
  `~/Library/Logs/pi2/pi2-daemon.log` (`pi2-daemon.err.log` for stderr) on macOS.
  Raise verbosity with `PI2_LOG_LEVEL=debug` (in the unit's
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

- **SIGINT/SIGTERM/SIGHUP** (`pi2 daemon`): close HTTP + WS, close the plugin socket,
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

Builds, starts `pi2 daemon` on an ephemeral port with throwaway
`PI2_RUNTIME_DIR`/`PI2_DATA_DIR`/`PI2_STATE_DIR`, waits for `daemon.json`, then
asserts: `/api/v1/info` (200, `v=1`), `/api/v1/health` (200 ok), `/` (200 html
from `web/dist`), `/api/v1/nope` (404 with token, 401 without),
`/api/v1/workspaces` (200 array with the CLI token, 401 without/with a bogus
token), the `cli.token` format/mode, the lock payload, and a clean `SIGTERM`
exit with lock + `daemon.json` removed. Prints one `PASS` line per assertion.
`PI2_SMOKE_KEEP=1` keeps the temp dir (and the `pi2-daemon.log` daemon log) for
debugging.

## 13. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `pi2: another pi2 daemon is running (pid …)` | a live daemon owns this runtime dir. Stop it, or `--force` |
| `pi2: no running pi2 daemon (…/daemon.json missing)` | daemon not started, or started with a different `PI2_RUNTIME_DIR` |
| `pi2: missing CLI token (…/cli.token)` | token deleted or daemon restarted; restart `pi2 daemon` |
| `401 E_UNAUTHORIZED` from `curl` | send `Authorization: Bearer $(cat $PI2_RUNTIME_DIR/cli.token)` |
| `EADDRINUSE` on an explicit port | pick another `--port` (only the default port retries) |
| `403` with the browser console | origin not in `PI2_ORIGINS` (derived from the port) |
| `pi2 open` → `403 console login is loopback-only` | the request came from a non-loopback address; pair the device instead |
| `pi2 doctor` → `access FAIL` | `PI2_ACCESS_MODE=lan/tailscale` binds a non-loopback address without `PI2_PUBLIC_URL`; set it or use `tailscale serve` |
| `health: static=FAIL` | `web/dist` missing — build the web UI or set `PI2_STATIC_DIR` |
| Browser console loads but no workspaces | no nvim with the plugin has connected yet; run `pi2 attach` in a project |
| `pi2 doctor` → `plugin FAIL` | install pi2.nvim, or point `PI2_PLUGIN_DIR` at the checkout |
| `pi2 doctor` → `linger warn` | services stop at logout; `loginctl enable-linger $USER` |
| Instances gone after a wifi/laptop sleep | daemon restarted: nvim reconnects automatically; check `pi2 status` |
