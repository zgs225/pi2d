# pi2d — pi2 web console daemon

The always-on web side of [pi2.nvim](https://github.com/zgs225/pi2.nvim). It is a **router + supervisor**, not an agent runtime:

```
browser ──HTTP/WS──▶ pi2 daemon ──JSONL unix socket──▶ one nvim per workspace (pi2.nvim)
                                                         └── one pi --mode rpc per active session
```

Hard rules (see `docs/protocol.md`):

1. `pi2 daemon` never spawns `pi`, never reads session JSONL, never owns session state.
2. A workspace maps to **exactly one** managed nvim instance.
3. All mutations are commands relayed to the plugin; the plugin (inside nvim) is the single source of truth.
4. The web client keeps a render cache only; a `snapshot` from the plugin replaces it wholesale.

## Install

The documented model is **CLI-first** ([ADR 0002](docs/adr/0002-install-and-run.md)): install the `pi2` CLI, optionally run it as a user service, and let the Neovim plugin attach as a client.

Requirements: **Node >= 20** (for the npm channel; the curl installer and system packages ship bundled binaries with no Node dependency), **Neovim >= 0.9**, and the **`pi` CLI** on `PATH`.

> **Status.** The daemon CLI, the web console and the standalone installer are ready today (`npm i -g @yuez/pi2d` and `install.sh` work today). `:PiWeb` and `:PiWebInstall` land with the next pi2.nvim release, so today the flow is `pi2 daemon` + `pi2 open` (or running the daemon as a user service).

### Channel A: Global package manager (Node >= 20)

If your machine has Node >= 20:

```bash
npm i -g @yuez/pi2d
# or:
pnpm add -g @yuez/pi2d
bun add -g @yuez/pi2d
mise use -g npm:@yuez/pi2d
```

### Channel B: Standalone curl installer (no Node required)

For machines without Node, with an older distro Node (e.g. Debian 12 ships 18), or where you want a self-contained installation with no global npm or root access:

```bash
curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh
```

Installs the precompiled binary and web console to `~/.local/lib/pi2d` and symlinks the executable to `~/.local/bin/pi2`.

To uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh -s -- --uninstall
```

### Channel C: System packages (Homebrew & AUR)

*(Available once the release that publishes binaries has shipped)*:

- **macOS / Linux (Homebrew tap):**
  ```bash
  brew install zgs225/tap/pi2d
  ```
- **Arch Linux / Manjaro / EndeavourOS (AUR):**
  ```bash
  paru -S pi2d-bin   # or: yay -S pi2d-bin
  ```

For full installation options and a situation-based guide, see the [Decision table in docs/install.md](docs/install.md#decision-table).

## Run

`pi2` is the only executable (`@yuez/pi2d` is the npm package name); `pi2 daemon` is a subcommand of it. Choose one of three run modes:

### 1. User service (recommended for an always-on console)

The daemon's value proposition is an always-on URL that stays up across editor restarts and reboots. Generate and write the service unit:

```bash
pi2 install-service --write
```

- **Linux (`systemd --user`)**: writes `~/.config/systemd/user/pi2.service` (loads environment variables from `~/.config/pi2/env` if present). Enable and start it:
  ```bash
  systemctl --user daemon-reload
  systemctl --user enable --now pi2.service
  ```
  Logs stream to systemd journal:
  ```bash
  journalctl --user -u pi2.service -f
  ```
  *(To keep the service running across SSH logouts, run `loginctl enable-linger`.)*
- **macOS (`launchd`)**: writes `~/Library/LaunchAgents/com.pi2.daemon.plist`. Load and start it:
  ```bash
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi2.daemon.plist
  launchctl enable gui/$(id -u)/com.pi2.daemon
  launchctl kickstart -k gui/$(id -u)/com.pi2.daemon
  ```
  Logs go to `~/Library/Logs/pi2/pi2-daemon.log` and `pi2-daemon.err.log`.

To remove the service: `pi2 uninstall-service --write`. Note that in service mode, stopping the daemon must go through your service manager (e.g. `systemctl --user stop pi2.service`), as process kills will trigger service restarts.

### 2. Foreground process

For testing or debugging, run directly in a terminal:

```bash
pi2 daemon                 # foreground; logs stream to terminal stdout/stderr
pi2 open                   # open console signed in (local browser)
pi2 stop                   # stop the running daemon from another terminal (or: pi2 daemon stop)
```

### 3. Neovim plugin autostart (coming with next pi2.nvim release)

When configured with `web.autostart = "spawn"`, pi2.nvim spawns a detached background `pi2 daemon` when you invoke `:PiWeb`. Logs go to `$PI2_STATE_DIR/daemon.log` (`~/.local/state/pi2/daemon.log` on Linux, `~/Library/Logs/pi2/daemon.log` on macOS).

See the [Decision table in docs/install.md](docs/install.md#decision-table) for how to pick the right mode for your workflow.

### Useful CLI commands

```bash
pi2 daemon                 # foreground daemon
pi2 stop                   # stop running daemon (alias: pi2 daemon stop)
pi2 open                   # open browser console signed in (loopback only)
pi2 install-service --write   # render and write user service file
pi2 uninstall-service --write # remove user service file
pi2 status                 # daemon status, active instances, and health
pi2 doctor                 # verify node/runtime, nvim, pi, curl, sockets, protocol
pi2 --version              # print version
```

Runtime files, ports, auth, services and troubleshooting: [docs/deployment.md](docs/deployment.md).

### Neovim plugin

```lua
{
    "zgs225/pi2.nvim",
    opts = {},                    -- add `web = { enabled = true }` to start the bridge at setup
    cmd = { "PiWeb", "PiWebStart", "PiWebStatus" },
}
```

The plugin acts as a client: it connects to the running daemon or starts one using `pi2` on `$PATH`.
Once connected, `:PiWeb` opens your browser already signed in to the current workspace.

The plugin resolves the daemon binary in this order (`:PiWebStatus` reports which one won):

| # | Source | Where |
|---|---|---|
| 1 | `web.binary` / `$PI2_DAEMON_BIN` | explicit path or command name |
| 2 | `pi2` on `PATH` | a global CLI install (recommended) |
| 3 | plugin data dir | `<stdpath("data")>/pi2d/node_modules/.bin/pi2` (only if `:PiWebInstall` ran) |
| 4 | repo checkout | `node_modules/.bin/pi2` (developing pi2d itself) |

## Remote access (phone, LAN, Tailscale)

The daemon binds `0.0.0.0` by default, so a phone on the same network can open the console;
access is gated by pairing codes and per-device tokens, never by the bind address. Set
`web.host = "127.0.0.1"` (or `PI2_HOST=127.0.0.1`) for a loopback-only daemon, and
`web.public_url` when a `tailscale serve` portal is in front.

| Bind (`PI2_HOST`) | Browser access | Login |
|---|---|---|
| unset → `0.0.0.0` | `http://127.0.0.1:7676` on the desktop, `http://<lan-ip>:7676` from a phone, or a `tailscale serve` URL | desktop: automatic one-time token; other devices: pairing code / QR |
| `127.0.0.1` | this machine only (put `tailscale serve` in front if you need remote access) | automatic one-time token |

Pair a device from the CLI:

```bash
pi2 pairing                   # phone-reachable URL + code + terminal QR
pi2 pairing --base https://myhost.tail1234.ts.net   # pin the interface to advertise
```

The link is built on the primary LAN address by default, so scanning it from a phone
actually works — the link carries host, port and code, so opening it pairs the device with
no further input; the mint response additionally carries the QR module matrix (`qr.rows`) and every
selectable base (`bases`), which is what `:PiWebPair` in Neovim uses: pick an interface
(name + IP), then draw the code.

Or from the web console's device page. Tokens are per-device, revocable, and stored
hashed; `pi2 doctor` reports the active mode and warns when a non-loopback bind has no TLS.

## Developing pi2d

```bash
pnpm install
pnpm --dir web install
pnpm dev            # daemon on 127.0.0.1:7676 (tsx watch)
pnpm --dir web dev  # vite dev server on :5173, proxying /api and /ws to the daemon
```

The dev proxy presents the daemon's own `Origin`, so the :5173 server needs no `PI2_ORIGINS`
(the daemon's allowlist is derived from its port). Sign in to :5173 once by opening
`http://localhost:5173/#t=<token>` with the fragment from `pnpm exec tsx src/cli/pi2.ts open --print`;
`localStorage` is per origin, so the :7676 session does not carry over.

`pnpm build` → `dist/`, `pnpm build:web` → `web/dist/`. The published tarball ships both, so
`pi2 daemon` serves the web console from its own package with no extra step.

Releasing: bump `version` in `package.json`, tag `v<version>`, push the tag. That is the whole
flow — `.github/workflows/release.yml` verifies the tag matches `package.json`, runs the
checks, and publishes to npm. Authentication is **OIDC trusted publishing**: the publish step
holds no npm token, and `id-token: write` lets the npm CLI exchange a short-lived GitHub OIDC
token for publish rights (provenance is attached automatically). There is no `NPM_TOKEN` secret
to configure or rotate, and a guard step fails the run if one ever exists. The one-time bootstrap
(first publish by hand, then the npmjs.com trusted-publisher setup), the local dry run and
troubleshooting: [docs/releasing.md](docs/releasing.md).

## Layout

| Path | Purpose |
|---|---|
| `src/protocol/` | wire types, event/command vocabulary, error codes, canonical reducer |
| `src/daemon/` | HTTP/WS/SSE, auth, static assets, routing, event relay |
| `src/instances/` | discovery, lazy spawn, single-instance enforcement, crash handling |
| `src/workspaces/` | workspace registry, disk discovery, aliases/trust |
| `src/cli/` | `pi2` — the `daemon` subcommand plus `attach`/`status`/`doctor` |
| `web/` | the React web console (built into `web/dist`, served by the daemon) |
| `fixtures/` | golden event streams + expected session state (shared with pi2.nvim tests) |
| `docs/protocol.md` | the wire contract (browser ↔ daemon ↔ plugin) |

## Testing

Unit contracts are hermetic (`pnpm test` → `vitest run`; `pnpm lint` typechecks). The web-console
gate is end-to-end and real: a daemon, one headless nvim per workspace, a real `pi --mode rpc`
behind it and, for the browser layer, Playwright against the built bundle.

```bash
pnpm test                              # unit: daemon + web (vitest)
bash scripts/e2e/run-api.sh            # A0–A12: API/WS against a real backend
bash scripts/e2e/run-ui.sh             # B1–B14, C1–C4: Playwright against web/dist
bash scripts/e2e/run-all.sh            # both, API first
```

Every suite runs in its own `mktemp` root with isolated runtime/data/state/agent dirs and
`pi` sessions redirected away from `~/.pi/agent`; `E2E_SKIP_BUILD=1` reuses an existing build
and `E2E_KEEP=1` keeps the artifacts (report, logs, screenshots). Scenario ids, isolation
details, skip conditions and report paths: [docs/e2e.md](docs/e2e.md).
