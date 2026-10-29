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
| Node | **>= 20** (`engines` field for npm install); **none** for compiled binary | daemon + CLI (npm/Node install) |
| Neovim | **>= 0.9** | managed instances; `nvim --remote-ui` for `pi2 attach` |
| pi CLI | any recent version | agent sessions inside nvim |
| pi2.nvim | `lua/pi/web/bridge.lua` present | the plugin that dials the daemon |

The compiled standalone binary (`bun build --compile`) needs no Node at all and reports
its runtime as `bundled` (e.g. `bundled bun 1.3.14`). `pi2 doctor` checks all of the above
(see [§8.3](#83-pi2-doctor)).

## 2. Build

### Node / npm package build

```bash
pnpm install
pnpm build            # tsc -> dist/ (dist/cli/pi2.js)
pnpm --dir web build  # optional: web/dist for the browser console
```

The daemon serves the browser console from `<repo>/web/dist` (or `PI2_STATIC_DIR`).
Without it `/` returns 404/SPA fallback behaviour and `/api/v1/health` reports
`static=FAIL`; the API and `pi2` keep working.

For an npm install, there is exactly one entrypoint script, `dist/cli/pi2.js` (client
commands **and** the `daemon` subcommand). It is ESM and starts with a `#!` line.

### Compiled binary build

```bash
pnpm build:binary     # or: bash scripts/build-binary.sh
```

Produces the standalone artifact tree under `dist-bin/`:
- `dist-bin/bin/pi2` — compiled executable (`bun build --compile`) with injected `PI2_BUILD_VERSION`
- `dist-bin/share/pi2d/web/dist/` — web console assets
- `dist-bin/LICENSE` — license file
- `dist-bin/pi2d-<version>-<os>-<arch>.tar.gz` — distribution tarball containing `bin`, `share`, and `LICENSE`

Cross-compilation targets (`bun-linux-x64`, `bun-linux-arm64`, `bun-linux-x64-musl`,
`bun-linux-arm64-musl`, `bun-darwin-x64`, `bun-darwin-arm64`):
```bash
bash scripts/build-binary.sh --target bun-linux-x64
```

To run the whole test gate against the compiled artifact:
```bash
bash scripts/smoke-binary.sh   # or: pnpm smoke:binary
```
It asserts daemon startup on ephemeral port 0, `GET /api/v1/info`, `GET /` (HTML from
`share/pi2d/web/dist`), `GET /api/v1/health` (`static` ok), `pi2 doctor` (bundled runtime
reports ok, no node failure), `pi2 install-service --dry-run` (`ExecStart` contains no
`node` or `pi2.js`), and clean `SIGTERM` cleanup.

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

Exactly one line goes to **stdout** (the host in that line is the configured bind, so a wildcard bind prints `0.0.0.0`):

```
pi2 daemon listening on http://0.0.0.0:7676
```

Every log record is JSONL on **stderr** (that is what systemd/launchd capture).
Every daemon error is one line on stderr prefixed `pi2: `.

Flags (`pi2 daemon [start] …`):

| Flag | Meaning |
|---|---|
| `--port <n>`, `-p <n>` | TCP port; `0` = ephemeral (the real port lands in `daemon.json`) |
| `--host <addr>` | bind address (default `0.0.0.0` (all interfaces)) |
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

### Install shape and asset resolution

`pi2` runs in two shapes (see [ADR 0002](adr/0002-install-and-run.md)):
1. **npm / Node package**: executed via Node (`node …/dist/cli/pi2.js`), where assets sit
   next to the source tree.
2. **Compiled single binary**: compiled via Bun (`bun build --compile`) and installed as
   `<prefix>/bin/pi2` with assets at `<prefix>/share/pi2d/web/dist`.

How `pi2` discovers its own version and web UI (`src/core/install.ts`):
- **Version**: build-time define (`PI2_BUILD_VERSION`, injected by `scripts/build-binary.sh`)
  → on-disk `package.json` (`../../package.json` next to `dist/cli/` for npm/dev checkout)
  → `0.0.0` (`UNKNOWN_VERSION`).
- **Static UI directory** (`defaultStaticDir()`): probed in order, first with `index.html` wins:
  1. `<exe>/../share/pi2d/web/dist` — release layout: `<prefix>/bin/pi2` plus
     `<prefix>/share/pi2d/web/dist` (what the curl installer, Homebrew tap, and AUR `-bin` package install)
  2. `<exe>/web/dist` — portable unpacked directory (`pi2` next to its UI)
  3. `<repo>/web/dist` — npm install or dev checkout relative to module location
- **Environment override**: `PI2_STATIC_DIR` still wins over all candidate paths when set.

## 4. Configuration

Everything is environment-driven (`src/config.ts` + `src/core/paths.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PI2_PORT` | `7676` | HTTP/WS port, `0` = ephemeral |
| `PI2_HOST` | `0.0.0.0` | bind address (all interfaces); set `127.0.0.1` for a loopback-only daemon |
| `PI2_PUBLIC_URL` | – | external base URL, e.g. `https://myhost.tail1234.ts.net` (no trailing slash) |
| `PI2_ORIGINS` | – | **extra** CORS/Origin allowlist entries (comma separated), added to the derived origins |
| `PI2_STATIC_DIR` | install layout (`<prefix>/share/pi2d/web/dist` for a compiled binary, `web/dist` for an npm/dev checkout), resolved by `src/core/install.ts` | built web UI (`PI2_STATIC_DIR` overrides it) |
| `PI2_RUNTIME_DIR` | Linux `$XDG_RUNTIME_DIR/pi2`, macOS `~/Library/Caches/pi2/run` | sockets, lock, tokens |
| `PI2_DATA_DIR` | Linux `$XDG_DATA_HOME/pi2`, macOS `~/Library/Application Support/pi2` | `devices.json`, `workspaces.json` |
| `PI2_STATE_DIR` | Linux `$XDG_STATE_HOME/pi2`, macOS `~/Library/Logs/pi2` | instance logs |
| `PI2_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`/`silent` |
| `PI2_WORKSPACE_ROOTS` | `$HOME` | allowlist for `workspace.add`, and the root set for `PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS` (comma separated, `~` expanded) |
| `PI2_WORKSPACE_HIDE_TEMP` | `1` | hide workspaces under the absolute `$TMPDIR` (ignored when relative), `/tmp`, `/var/tmp`, `/var/folders`, `/private/var/folders` |
| `PI2_WORKSPACE_HIDE_GHOSTS` | `1` | hide workspaces whose `cwd` no longer exists (session files are kept) |
| `PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS` | `0` | hide workspaces outside `PI2_WORKSPACE_ROOTS` (opt-in: hides real repos outside `$HOME`) |
| `PI2_WORKSPACE_STALE_DAYS` | `0` (= off) | hide workspaces idle for more than `n` days (opt-in: hides real repos) |
| `PI2_PLUGIN_DIR` | `~/.local/share/nvim/lazy/pi2.nvim` | pi2.nvim checkout: `pi2 doctor` probes it and spawned instances prepend it to `runtimepath`; a leading `~/` is expanded |
| `PI2_NVIM_BIN` | `nvim` | nvim binary for managed instances, resolved on the **daemon's** `PATH` (read once, at daemon start) |
| `PI2_NVIM_INIT` | – (daemon-generated init) | unset ⇒ a generated minimal init that prepends `PI2_PLUGIN_DIR`/the discovered plugin; `user` ⇒ load the user's own nvim config (no `-u`); any other value ⇒ that file via `-u` |
| `PI2_ENSURE_TIMEOUT_MS` | `10000` | how long `instance.ensure` waits for a spawned nvim to say `hello`; expiry answers `E_INSTANCE_STARTING` |
| `PI2_CODING_AGENT_DIR`, falling back to `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi session storage (discovery) |

There is no config file: the environment *is* the configuration.

A spawned instance inherits the **daemon's** environment, not your shell's, so `PATH` is the
service's. Each spawn writes the child's stdout/stderr to
`PI2_STATE_DIR/instances/<instanceId>.log` (`0600`, appended per start); the last lines of that
file are folded into `instance_state.reason`, which is what the console and `pi2 status` show when
a workspace fails to open.

### Service environment file (`~/.config/pi2/env`)

For background services, the systemd unit automatically includes:
```ini
EnvironmentFile=-%h/.config/pi2/env
```
The leading `-` instructs systemd to ignore the file if it does not exist (missing is fine).

Example `~/.config/pi2/env`:
```sh
PI2_HOST=127.0.0.1
PI2_PORT=7676
PI2_PUBLIC_URL=https://myhost.tail1234.ts.net
PI2_WORKSPACE_ROOTS=/home/user/Workspace,/home/user/Projects
```
Set permissions to `0600` (`chmod 0600 ~/.config/pi2/env`) to protect tokens or sensitive paths.
Note that macOS `launchd` has no direct `EnvironmentFile` equivalent (`ServicePaths.envFile` is
ignored on Darwin); configure environment variables in `launchd` via the plist's
`EnvironmentVariables` dictionary or shell environment.

### Workspace list (noise policy)

`GET /api/v1/workspaces` always returns **every** known workspace, so
`/workspace/<workspaceId>` deep links keep resolving. The noise policy is a
derived, non-persisted `visibility` (`default` | `secondary`) plus
`visibilityReason` (`hidden` | `ghost` | `temp` | `outside-roots` | `stale`),
with this precedence (first match wins):

1. `hidden: true` → secondary (explicit intent, never rescued).
2. A live instance (`instance != null` or `liveCount > 0`), `pinned` or
   `trusted` → default (rescue: a workspace you are using is never hidden).
3. `PI2_WORKSPACE_HIDE_TEMP` → secondary/`temp`.
4. `PI2_WORKSPACE_HIDE_GHOSTS` → secondary/`ghost`.
5. `PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS` → secondary/`outside-roots`.
6. `PI2_WORKSPACE_STALE_DAYS` → secondary/`stale` (`lastActiveAt: null` never
   counts as stale).
7. Otherwise default.

Boolean switches accept `1/true/yes/on` and `0/false/no/off`; anything else
falls back to the default. `workspace.add` always clears `hidden`, so opening a
previously hidden path brings it back. In the browser console the workspaces
page lists `default` rows only behind a persisted “Show N hidden” toggle
(`localStorage` key `pi2-workspaces-show-all`, default off) that reveals the
secondary rows dimmed with a reason badge; any workspace picker offers
`default` rows only, while lookups by id ignore `visibility` entirely.

### Binding and reachability

The daemon listens on **all interfaces** (`0.0.0.0`) by default: the console is meant to
be opened from a phone as well as from the desktop, and it is the **pairing code** — not
the bind address — that grants access (each device then holds its own revocable token).
`PI2_HOST` narrows the bind:

| `PI2_HOST` | Reachable from | Use when |
|---|---|---|
| unset (default `0.0.0.0`) | this machine, the LAN, a tailnet | the normal homelab setup |
| `127.0.0.1` | this machine only | you always put `tailscale serve` (or another proxy) in front, or you want the console strictly local |

`corsOrigins` are *derived*, not configured: loopback plus **every IPv4 address of this
host** at the bound port, plus the origin of `PI2_PUBLIC_URL`, plus anything in
`PI2_ORIGINS`. A browser that loaded the console from `http://192.168.11.7:7676` sends an
`Origin` header that is not loopback, so the allowlist has to cover the address the user
actually typed. Origins are normalized (trailing `/` stripped, empties dropped) and
deduped; `PI2_ORIGINS` never replaces the derived list.

The daemon never terminates TLS. For a tailnet, point `PI2_PUBLIC_URL` at the
`tailscale serve` URL (`https://host.tail1234.ts.net`): the origin is then allowed,
`pi2 pairing` advertises that base, and `pi2 doctor` reports the bind as `ok` instead of
warning about the missing TLS.

The pairing link follows the same preference (public URL → LAN address → loopback) and
is chosen by the **daemon**, not the client: `POST /api/v1/pair` returns the URL together
with the QR matrix and every base a browser could use, and accepts `base` to pin a
different entry. `:PiWebPair` renders that list as the "pick the interface" menu; the
reasoning is in [ADR 0001](adr/0001-phone-first-pairing.md).

## 5. Runtime files

All of these live in `PI2_RUNTIME_DIR` (created `0700`):

| File | Mode | Purpose |
|---|---|---|
| `d.sock` | `0600` | plugin ↔ daemon JSONL socket (nvim dials it) |
| `d.sock.token` | `0600` | handshake token for `hello`; rotated per daemon start |
| `daemon.lock` | `0600` | singleton lock: `{pid, bootId, port, daemonId, startedAt, protocolVersion, host?, publicUrl?}` |
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

1. **Device tokens** (paired phones/laptops): created by `POST /api/v1/pair/redeem`
   (mint is authenticated `POST /api/v1/pair`, redemption is public
   `POST /api/v1/pair/redeem`) or `pair.create`; only SHA-256 hashes are stored in
   `PI2_DATA_DIR/devices.json`.
2. **Local CLI token**: `PI2_RUNTIME_DIR/cli.token`, minted by `pi2 daemon` on
   each start. Any request carrying it authenticates as the synthetic device
   `{id:"local-cli", name:"local CLI", kind:"laptop"}`
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
`local browser` device (`kind:"laptop"`) and answers
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

### 8.0b `pi2 stop` / `pi2 daemon stop`

```bash
pi2 stop                    # stop a running daemon (SIGTERM, waits up to 5s)
pi2 daemon stop             # alias for `pi2 stop`
pi2 stop --force            # escalate to SIGKILL if SIGTERM times out
pi2 stop -t 10              # wait up to 10 seconds before failing / escalating
```

Locates the running daemon via `<runtime>/daemon.json` (or `daemon.lock`), verifies
that the PID belongs to this boot, sends `SIGTERM`, and waits for the process to exit.
If the daemon was already dead (stale lock/json), it cleans up the stale files and reports
that no daemon is running. With `--force`, it escalates to `SIGKILL` if the daemon does not
exit within the timeout.

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
| `node` | < 20 (npm/Node install) | – (compiled binary reports `bundled bun <ver> — bundled runtime, no separate node needed`) |
| `nvim` | missing, or < 0.9 | version unparsable |
| `pi` | – | not on `PATH` |
| `curl` | – | missing → `not found on PATH (:PiWeb cannot sign the browser in automatically; pair instead)`; present but unparsable → `could not parse version of <path>` |
| `plugin` | `lua/pi/web/bridge.lua` not found | bridge present but `lua/pi/host.lua` missing — the daemon cannot spawn a workspace from the console |
| `runtime-dir` | missing | mode not `0700` |
| `cli-token` | mode not `0600` | missing (daemon not started yet) |
| `socket` | `d.sock` missing (and no daemon) | missing but daemon answers |
| `daemon` | `/api/v1/info` unreachable | – |
| `port` | – (reports bound/free) | – |
| `bind` | – | non-loopback bind without an `https:` `PI2_PUBLIC_URL` (`all interfaces/7676 — no TLS; pairing codes gate access, set PI2_HOST=127.0.0.1 to restrict`) |
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

### 8.5 `pi2 pairing [--base <url>]`

`POST /api/v1/pair` with the local token, then prints a scannable report:

```
url     http://192.168.2.10:7676/pair/ABCD2345
code    ABCD2345
expires in 600s (2026-10-21T04:30:15.085Z)

  ▄▄▄▄▄▄▄ ▄▄ ▄▄▄▄▄▄▄
  █ ▄▄▄ █ ▀█▄▀█ ▄▄▄ █
  █ ███ █ ▄▀▄ █ ███ █
  …
```

The daemon owns the URL, the QR matrix and the base list (see
[ADR 0001](adr/0001-phone-first-pairing.md) §3); the CLI only renders them. The base is
chosen for reachability, first non-empty wins:

| # | Base (`kind`) | When |
|---|---|---|
| 1 | `PI2_PUBLIC_URL` (`public`) | behind `tailscale serve` or another proxy |
| 2 | primary LAN address (`lan`) | the default — the daemon binds `0.0.0.0` |
| 3 | other routed / tailnet address (`other`, `tailscale`) | multi-homed hosts |
| 4 | `http://127.0.0.1:<port>` (`loopback`) | `PI2_HOST=127.0.0.1`, or a host with no LAN address |

`--base <url>` pins a different address; the daemon validates it against the list it
just returned and answers `400` for anything else, so a link can never point at an
address nothing listens on.

`GET /pair/<code>` answers `302` to `/connect?code=<code>&auto=1`, which is what makes a
scanned link zero-input: the console redeems the code against its own origin and lands on
`/workspaces` without a form.

`qr` is byte mode, EC level M, versions 1–10, and lives in `src/core/qr.ts`; `rows` is the
raw module matrix without a quiet zone (`size` strings of `size` `1`/`0` characters). The
HTTP mint response carries the same matrix, so the console and a terminal draw the same
symbol. A URL too long for version 10 is printed without a QR, with a note.

Machines and editor plugins use `--json`, which prints the normalised mint payload
(`{url, code, expiresAt?, qr?, bases[]}`) instead of the human report. `:PiWebPair` in
pi2.nvim renders exactly that payload, so it no longer speaks HTTP itself.

### 8.6 `pi2 install-service` / `pi2 service`

See [§9](#9-services-systemd--launchd). `install-service --dry-run` (default)
prints the file and the follow-up commands; `--write` writes the file (`0644`)
and prints the commands — it never executes `systemctl`/`launchctl`.

`pi2 service …` is the explicit control surface the editor plugin calls, so the
plugin never talks to a service manager itself:

```bash
pi2 service status [--json]   # manager, unit path, installed/enabled/active, linger
pi2 service start             # systemctl --user start pi2.service / launchctl kickstart -k
pi2 service stop              # systemctl --user stop pi2.service  / launchctl kill TERM
pi2 service enable            # … enable --now                      / launchctl bootstrap + enable
pi2 service disable           # … disable --now                     / launchctl bootout
```

`service status` always exits `0` and reports the world as it is (no manager,
no unit and a dead service are reports, not errors). The four mutating actions
exit `1` with the manager's first stderr line when it refuses; they refuse to
run at all when the unit file is missing (run `pi2 install-service --write`
first).

## 9. Services (systemd / launchd)

```bash
pi2 install-service --dry-run     # inspect, nothing written
pi2 install-service --write       # ~/.config/systemd/user/pi2.service
pi2 service enable                # daemon-reload + enable --now (one explicit command)
# or, by hand:
systemctl --user daemon-reload
systemctl --user enable --now pi2.service
```

The unit is rendered with absolute paths and supports both install shapes:

```ini
[Unit]
Description=pi2 daemon
After=network.target

[Service]
Type=simple
# For a compiled binary install:
ExecStart=/home/user/.local/lib/pi2d/bin/pi2 daemon --foreground
# Or for an npm / Node install:
# ExecStart=/usr/bin/node /repo/dist/cli/pi2.js daemon --foreground
EnvironmentFile=-%h/.config/pi2/env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

The `ExecStart` line adapts automatically to how `pi2` was invoked:
- **Compiled binary install**: `<prefix>/bin/pi2 daemon --foreground` (invokes the compiled executable directly).
- **npm / Node install**: `<nodePath> <scriptPath> daemon --foreground` (e.g. `/usr/bin/node /repo/dist/cli/pi2.js daemon --foreground`).

The unit includes `EnvironmentFile=-%h/.config/pi2/env`, where the leading `-` tells systemd that a missing file is completely fine.

`XDG_CONFIG_HOME` is honoured for the target directory. On macOS the same
command writes `~/Library/LaunchAgents/com.pi2.daemon.plist` (`RunAtLoad`,
`KeepAlive`, absolute binary or node + script paths in `ProgramArguments`,
`StandardOutPath`/`StandardErrorPath` under `PI2_STATE_DIR`) and prints:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi2.daemon.plist
launchctl enable gui/$(id -u)/com.pi2.daemon
```

Note: `launchd` on macOS has no direct equivalent for systemd's `EnvironmentFile=`.
Environment variables on macOS must be set in the plist `EnvironmentVariables` dictionary
or via shell environment.

`uninstall-service --write` removes the file and prints the disable commands
(`pi2 service disable` runs the `--now` variant when you want the daemon stopped
too). For a login-less service to keep running on Linux enable linger
(`loginctl enable-linger $USER`, `pi2 doctor` warns when it is off;
`pi2 service status --json` reports `linger`).

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
| `pi2 --version prints 0.0.0` | compiled binary built without injected version define; rebuild with `scripts/build-binary.sh` (or `pnpm build:binary`) |
| `401 E_UNAUTHORIZED` from `curl` | send `Authorization: Bearer $(cat $PI2_RUNTIME_DIR/cli.token)` |
| `EADDRINUSE` on an explicit port | pick another `--port` (only the default port retries) |
| `403` with the browser console | origin not in `PI2_ORIGINS` (derived from the port) |
| `pi2 open` → `403 console login is loopback-only` | the request came from a non-loopback address; pair the device instead |
| `pi2 doctor` → `bind warn` | the daemon listens on a non-loopback address without TLS; that is the default posture — pair each device, or set `PI2_HOST=127.0.0.1` / `PI2_PUBLIC_URL=https://…` |
| `health: static=FAIL` / UI 404 | web assets not found next to binary (expected at `<exe>/../share/pi2d/web/dist`) or `<repo>/web/dist` missing — reinstall release tarball, build web UI, or set `PI2_STATIC_DIR` |
| Browser console loads but no workspaces | no nvim with the plugin has connected yet; run `pi2 attach` in a project |
| `pi2 doctor` → `plugin FAIL` | install pi2.nvim, or point `PI2_PLUGIN_DIR` at the checkout |
| `pi2 doctor` → `linger warn` | services stop at logout; `loginctl enable-linger $USER` |
| unit points at a node path that no longer exists | mise/nvm/fnm or system Node upgrade changed the binary path; re-run `pi2 install-service --write && systemctl --user daemon-reload` |
| Instances gone after a wifi/laptop sleep | daemon restarted: nvim reconnects automatically; check `pi2 status` |

### Opening a project fails

Opening a workspace from the web console spawns a headless nvim on demand, so a broken spawn is
what a failed “open” looks like. Work the symptoms in this order:

1. **`pi2 doctor` → `plugin warn`/`plugin fail`** (or a spawn error naming the plugin): install or
   update pi2.nvim. The daemon needs `lua/pi/host.lua`; the bridge alone is not enough.
2. **`E_INSTANCE_UNAVAILABLE … failed to spawn nvim`**: the binary is not on the daemon's `PATH`
   (a service PATH is not your shell's). Point `PI2_NVIM_BIN` at an absolute nvim path and
   restart the daemon.
3. **`… did not say hello within 10000ms`** (`E_INSTANCE_STARTING`): nvim started but the plugin
   never loaded. Read `$PI2_STATE_DIR/instances/<instanceId>.log` — `instance_state.reason`
   quotes its tail.
