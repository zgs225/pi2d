# ADR 0002 — Installation and run model: CLI first, service-owned daemon, plugin attaches

- Status: accepted (implementing)
- Date: 2026-10-28
- Supersedes: the implicit "the plugin installs and spawns the daemon" default in
  `README.md` §Install and the resolution table (explicit path → `PATH` → plugin
  data dir → repo checkout → `npx @latest`)

## Context

`pi2d` is two things at once, and that is why its install story drifted:

1. a **CLI** (`pi2` + `pi2 daemon`) that serves the web console and supervises one
   headless nvim per workspace, and
2. a **dependency of a Neovim plugin** (`:PiWeb` is the only way most users will
   ever meet it).

Today the documented path is the second one: the plugin finds no daemon, `npm
install`s `@yuez/pi2d` into `<stdpath("data")>/pi2d`, spawns it detached, and mints
a loopback token. It works, but it makes the plugin an installer and a supervisor,
which is the exact shape the rest of the ecosystem avoids. Nine reference
implementations were surveyed (see §1).

## 1. How the reference implementations do it

| Agent | Install channels | Long-lived process | Self-update | How editors attach |
|---|---|---|---|---|
| **pi** (`@earendil-works/pi-coding-agent`) | `curl -fsSL https://pi.dev/install.sh \| sh` → *managed install*: its own Node under `~/.local/share/pi-node`, launcher in `~/.local/bin`, `managed-install.json` marker; `npm i -g --ignore-scripts` (Node ≥22.19); `nix profile add`; bun-compiled single binary in releases | foreground CLI; `pi --mode rpc` is the long-lived JSONL process a client drives | `pi update [self]` (`pi update` cannot update Nix installs) | the plugin **spawns** `pi --mode rpc` and speaks JSONL; the SDK embeds it in-process |
| **dsh** (DeepSeek Harness) | npm package under a version manager (mise `npm-deepseek-ai-dsh`), `dsh` launcher; profile plugins via `dsh plugin … pnpm` | `dsh web` = foreground HTTP+WS server (3080, `--host/--port/--no-open/--public-url/--tls-*`); also `dsh tui`, `dsh headless` | package manager | `dsh.nvim` spawns a **node bridge** (`bridge/bridge.mjs`) that dials `dsh web`; `auto_start` spawns the *server*, never installs it |
| **Claude Code** | native installer `curl -fsSL https://claude.ai/install.sh \| bash` (auto-updates); brew cask; winget; apt/dnf/apk; npm (legacy) | foreground CLI; IDE extensions spawn it and connect over a WS MCP socket | background auto-update (native); manual for brew/winget | `claudecode.nvim` runs the WS MCP **server inside nvim**; the `claude` binary on `PATH` is a hard requirement |
| **Codex CLI** | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` → standalone binaries (releases.openai.com, GitHub fallback); `npm i -g @openai/codex`; `brew install --cask codex`; raw tarballs | foreground CLI; `codex app-server` for IDE clients | package manager | IDE extension |
| **opencode** | `curl -fsSL https://opencode.ai/install \| bash`; npm/bun/pnpm/yarn; brew tap; pacman/AUR; choco/scoop; `mise use -g github:…`; Docker; raw releases | **TUI *and* a server**: `opencode serve` (default `127.0.0.1:4096`, OpenAPI 3.1 at `/doc`, `--mdns`, `--cors`, basic auth via `OPENCODE_SERVER_PASSWORD`) | package manager | IDE plugins drive a **running server** (`/tui` endpoint); the TUI itself is just a client |
| **gemini-cli** | `npx @google/gemini-cli`; `npm i -g` (`latest`/`preview`/`nightly`); brew; macports; conda | foreground CLI | npm dist-tag | (retired in favour of Antigravity) |
| **aider** | `curl -LsSf https://aider.chat/install.sh \| sh` (uv-backed, brings Python 3.12); `aider-install`; `uv tool install`; pipx; Docker | foreground CLI | `--upgrade` / package manager | — |
| **crush** | brew tap; `npm i -g @charmland/crush`; pacman; nix/NUR; apt repo; winget/scoop; FreeBSD pkg | foreground TUI (single Go binary) | package manager | — |
| **mason.nvim** (editor-side counter-example) | the *editor* installs into `stdpath("data")`, one `bin/` added to `$PATH`, registry-driven | n/a | `:MasonUpdate` | n/a |

Common denominators, all nine agreeing:

1. **The agent is a first-class CLI installed by a package manager or a `curl | sh`
   installer — never by the editor plugin.** Plugins that *do* install (`mason.nvim`)
   are infrastructure whose entire purpose is installing, with a registry behind them.
2. **Installers that bypass the OS package manager manage their own runtime** (pi
   pins Node, aider pins Python via uv, claude/codex ship native binaries). "Your
   distro's Node is too old" is never allowed to block the install.
3. **Self-update is an explicit command or an explicit policy** (`pi update`,
   `claude`'s background updater, gemini dist-tags, brew upgrades), because agents
   move faster than distros.
4. **The long-lived process is an explicit, separately-documented mode** (`pi --mode
   rpc`, `dsh web`, `opencode serve`, `codex app-server`) with a stable wire contract,
   and **the editor is a client of it**.
5. **Server modes bind loopback by default and take auth seriously** (opencode
   password env, dsh accepts only a concrete interface, our loopback CLI token).
6. **Nobody silently auto-updates the server behind the editor's back.** Version skew
   is handled by a version field in the handshake or a startup compatibility check.

`pi2d`'s one genuine asymmetry: the daemon is **not** the agent. It routes to nvim,
which owns sessions. So a daemon alone does nothing (`/workspaces` would be empty of
live instances), and a plugin without a daemon has no browser console. Neither side
can be "the" entry point — but the *install* and the *process* can each have exactly
one owner, and today the plugin wrongly claims both.

## 2. Decision

### 2.1 Install: Tier-1 distribution channels and Node floor

The primary distribution shifts from plugin-orchestrated npm installs to first-class
CLI distribution channels.

#### Node engine floor: lowered to >= 20

The `package.json` `engines` requirement and `pi2 doctor` checks are lowered to
`node >= 20` (from `>= 22`). Nothing in `src/` requires Node 22-only features (no
`node:sqlite`, no `styleText`, no `import.meta.dirname`, no `--experimental-*`).
Lowering to Node 20 broadens compatibility for npm users (including enterprise LTS
and Debian/Ubuntu environments). When running as a compiled binary, no Node runtime
is needed at all.

#### Tier-1 distribution channels (shipped as compiled binaries)

Instead of the installer downloading and managing a separate Node runtime, all three
primary channels ship identical precompiled standalone binaries (`bun build --compile`):

| Channel | Method | Target audience | Runtime dependency |
|---|---|---|---|
| **curl installer** | `curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh \| sh` | Generic Linux & macOS | None (zero external dependencies) |
| **Homebrew tap** | `brew install zgs225/tap/pi2d` | macOS & Linux | None (standalone binary formula) |
| **Arch AUR (`-bin`)** | `paru -S pi2d-bin` / `yay -S pi2d-bin` | Arch Linux, EndeavourOS, Manjaro | None (standalone binary package) |
| **npm global** | `npm i -g @yuez/pi2d` (or `pnpm add -g`, `bun add -g`) | Node developers | Node >= 20 |
| **repo checkout** | `git clone … && pnpm install && pnpm build` | Contributors, offline development | Node >= 20, pnpm |

The curl installer, Homebrew tap, and Arch AUR package are launched simultaneously (T1).
Because they distribute compiled binaries, the installer no longer needs to pin or install
Node under `~/.local/share/pi2-node`.

#### Rejection of `npx` as an install or execution path

Using `npx @yuez/pi2d@latest` or `npx` auto-execution is explicitly rejected:
1. **Network overhead on startup**: `npx` queries npm registries on first use or tag resolution,
   introducing multi-second latency to editor startup.
2. **Phantom dependencies**: creates ephemeral cache directories or uncontrolled
   `node_modules` under `stdpath("data")`.
3. **Supply chain exposure**: `@latest` resolution opens unpinned supply chain attack vectors.
4. **Version drift**: different editor sessions or background runs can resolve different
   daemon versions simultaneously, corrupting singleton socket expectations.

The plugin's `:PiWebInstall` becomes an explicit convenience command that prompts for
confirmation before installing a pinned version matching the plugin into
`<stdpath("data")>/pi2d`. It never runs `npx`.

### 2.2 Run: the daemon owns its own lifecycle

| Mode | Who starts it | When to use |
|---|---|---|
| **user service (default)** | `pi2 install-service --write` → `systemctl --user` / `launchd`; `:PiWeb` only *uses* it | daily use, especially phone/another-browser access — the console has to be up when nvim is not |
| **plugin spawn** | `:PiWeb` spawns a detached `pi2 daemon` if nothing runs (`web.autostart = "spawn"`) | a machine where the user does not want a service; logs to `PI2_STATE_DIR/daemon.log` |
| **foreground** | the user, in a terminal | debugging, `pi2 daemon --foreground` |

#### `web.autostart = "auto"` semantics

The plugin setting `web.autostart = "auto"` follows strict three-step semantics:
1. **Attach if running**: Check if a daemon is already active (via `daemon.json` / `d.sock`).
   If running, connect immediately — **never** spawn a second daemon.
2. **Start user service**: If an installed user service unit is found (`systemctl --user` or
   `launchctl`), trigger unit start (`systemctl --user start pi2.service` or `launchctl kickstart`).
3. **Spawn detached**: If no service is installed, spawn a detached `pi2 daemon` process and
   notify the user once in the editor.

#### `:PiWebStop` behavior in service mode

When the daemon is managed by a service manager (`systemd` or `launchd`), `:PiWebStop`
**must refuse** to stop the process. If a client terminates a service-managed daemon directly
via SIGTERM, `Restart=on-failure` (systemd) or `KeepAlive` (launchd) will immediately
attempt to restart it or enter an inconsistent state. The plugin must advise the user to
use `systemctl --user stop pi2` or `:PiWebService disable`.

### 2.3 The plugin is a client

`pi2.nvim` resolution order becomes, in order, with `:PiWebStatus` reporting the
winner:

1. `web.binary` / `$PI2_DAEMON_BIN` (explicit path or command name)
2. `pi2` on `$PATH` (the normal case — the CLI install of §2.1)
3. `<stdpath("data")>/pi2d/node_modules/.bin/pi2` (only if `:PiWebInstall` created it)
4. repo checkout `dist/cli/pi2.js` / `node_modules/.bin/pi2` (developing pi2d)
5. **nothing** → one-line error with the install command, no `npx` fallback

Commands: `:PiWeb` (ensure + open), `:PiWebStatus`, `:PiWebStart`, `:PiWebStop`,
`:PiWebPair`, `:PiWebInstall`, `:PiWebService`, `:PiWebLog`. `:checkhealth pi` grows a
`web` section: binary source, version, daemon reachability, protocol match, service
state, autostart mode.

### 2.4 Configuration stays environment-only

The daemon keeps `PI2_*` env as the single config surface (`src/config.ts`, no file
parser, no precedence rules). Two additions: `pi2 config` prints the resolved
configuration plus the paths that produced it, and the systemd unit carries
`EnvironmentFile=-%h/.config/pi2/env` (the leading `-` instructs systemd to ignore missing
files). A `pi2.toml` is rejected: ~20 knobs, all deployment-time, all naturally expressed
as environment variables.

### 2.5 Packaging: standalone binary contract

#### Artifact contract

Stand-alone binary releases are compiled with Bun (`bun build --compile`) and packaged
by `scripts/build-binary.sh` for six cross-compilation targets:
- `linux-x64`
- `linux-arm64`
- `linux-x64-musl`
- `linux-arm64-musl`
- `darwin-x64`
- `darwin-arm64`

Each release produces a tarball named `pi2d-<version>-<target>.tar.gz` and a top-level
`SHA256SUMS` manifest.

#### Archive layout contract

Every tarball unpacks with the exact layout:
```
bin/
  pi2
share/
  pi2d/
    web/
      dist/
        index.html
        ...
LICENSE
```

#### Filesystem prefix rule: `<prefix>/bin` + `<prefix>/share/pi2d/web/dist`

This directory structure conforms to standard Unix filesystem hierarchies (FHS). It is
the exact path probed at runtime by `src/core/install.ts`:
```typescript
resolve(dirname(executablePath()), "..", "share", "pi2d", "web", "dist")
```
Every distribution channel preserves this relationship under its installation prefix:
- **curl installer**: prefix `~/.local/lib/pi2d` (with symlink `~/.local/bin/pi2`)
- **Homebrew**: prefix `#{prefix}` (`/opt/homebrew` or `/usr/local`)
- **Arch AUR**: prefix `/usr`

#### npm package remains JS-only for Node >= 20

The npm package (`@yuez/pi2d`) deliberately remains pure JavaScript/TypeScript output
in `dist/` and `web/dist/`, running under Node >= 20. Packaging native platform binaries
into npm optional dependencies (e.g. `@yuez/pi2d-linux-x64`) is intentionally avoided
for now (Decision 3 '先不修改') to prevent publishing complexity across npm and GitHub
releases before justified by demand.

### 2.6 Upgrade and restart semantics

1. **npm upgrade**: running `npm i -g @yuez/pi2d@latest` (or `pnpm`/`bun`) updates the
   script in place. The running daemon process continues until restarted via
   `systemctl --user restart pi2` or `pi2 stop && pi2 daemon`.
2. **Binary upgrade (installer / brew / AUR)**: package managers or `install.sh`
   replace the binary on disk. Under Unix filesystem semantics, an open file descriptor
   to the running executable remains valid; existing daemon operations continue uninterrupted
   until the service is restarted.
3. **Systemd `Restart=on-failure`**: does not fight intentional shutdowns. A clean `SIGTERM`
   (e.g. via `pi2 stop`) causes `pi2 daemon` to exit with code `0`. Systemd considers exit 0
   a clean stop and does not trigger restart.
4. **Node path staleness**: units created for an npm install hardcode the absolute node
   path (`process.execPath`). Upgrading Node via a version manager (`mise`, `nvm`, `fnm`)
   invalidates that path. `pi2 doctor` detects when node cannot run, and re-running
   `pi2 install-service --write` re-renders the unit with the updated path.
5. **Daemon restart & client reconnection**:
   - **Managed Neovim instances**: spawned nvim processes do not terminate when the daemon
     stops. They dial `d.sock` with exponential backoff (200 ms to 5 s) and reconnect
     automatically when the daemon restarts.
   - **Web browsers**: WebSocket disconnects trigger client-side reconnection. During the
     initial handshake (`hello`), the daemon presents its newly minted `daemonId`. If the
     `daemonId` has changed, the browser recognizes a restarted daemon and resynchronizes state.

### 2.7 Compatibility and protocol handshake

1. **Protocol v1 handshake**: Every connection over WebSocket or unix socket begins with
   a `hello` exchange containing:
   - `daemonVersion`: semantic version of the running daemon (e.g. `0.1.5`)
   - `protocolVersion`: integer protocol version (currently `1`, defined in `src/protocol/types.ts`)
   - `daemonId`: unique UUID minted per daemon process run
2. **Version skew handling**:
   - The plugin compares `protocolVersion` against its supported range.
   - If the protocol version does not match, the plugin refuses to proceed, prints an
     actionable error message, and displays the exact upgrade command for the user's platform.
   - `pi2 doctor` probes the live daemon (`/api/v1/info`) and verifies CLI/daemon protocol parity.

### 2.8 Security hardening

1. **Service environment file**: `EnvironmentFile=-%h/.config/pi2/env` uses the leading `-`
   to ensure systemd boots cleanly even if the file is missing. Recommended permissions are
   `0600` (`chmod 0600 ~/.config/pi2/env`) to protect tokens and configuration from other users.
2. **No tokens in logs**:
   - Local admin token (`cli.token`) is randomly generated per boot, mode `0600`.
   - Device tokens are stored only as SHA-256 hashes in `devices.json`.
   - Browser console login (`POST /api/v1/console/session`) passes the session token strictly
     within the URL fragment (`#t=<token>`), preventing tokens from leaking into server logs,
     HTTP headers, or `Referer` fields.
3. **Pairing rate limits**:
   - `POST /api/v1/pair/redeem` enforces strict rate limits: 5 attempts/minute/IP and 50 attempts/hour globally. Exceeding limits returns `429 Too Many Requests`.
   - Pairing codes expire in 10 minutes and are single-use.
4. **Service bind warnings**: `pi2 install-service` checks if the daemon is configured to
   bind to all interfaces (`0.0.0.0`) without TLS and prints an explicit security warning.
5. **Doctor posture checks**: `pi2 doctor` verifies file permissions (`0700` for runtime dir,
   `0600` for `cli.token`), warns when linger is disabled on Linux, and requires explicit
   acknowledgement when running non-loopback without an `https:` `PI2_PUBLIC_URL`.

### 2.9 Deferred features and acceptance criteria

The following items are deferred to future revisions:

1. **`pi2 update` in-place self-updater**:
   - *Rationale*: Package managers (Homebrew, AUR, npm) already provide robust upgrade mechanisms.
   - *Acceptance criteria*: Detects if installed via standalone installer (`~/.local/lib/pi2d`);
     queries GitHub Releases API for newer version; verifies release `SHA256SUMS`; performs
     atomic replacement of `bin/` and `share/`; signals running systemd/launchd service to
     restart; refuses self-update when managed by Homebrew, AUR, or npm with instructions to use
     the native package manager.
2. **npm platform-binary packages (`@yuez/pi2d-<os>-<arch>`)**:
   - *Rationale*: The npm package works well as pure JS for Node >= 20. Adding platform-specific
     npm packages in `optionalDependencies` complicates CI/CD and release publishing.
   - *Acceptance criteria*: CI builds and publishes target-specific packages containing only the
     compiled binary; root `@yuez/pi2d` package delegates to platform binary if present,
     falling back to Node JS entrypoint.
3. **Upstream distribution repositories (`homebrew-core`, Alpine `aports`, `winget`)**:
   - *Rationale*: A custom tap (`zgs225/tap`) and AUR package provide fast release iteration
     without third-party review bottlenecks.
   - *Acceptance criteria*: Stable v1.0 release, official submission to `homebrew-core` (requires
     source-based build), official Alpine community package, and signed Windows MSIX/winget package.

## Consequences

- **Documentation order changes**: install the CLI → (optionally) enable the service →
  install the plugin → `:PiWeb`. `:PiWeb` stops being the whole install path.
- **Migration for existing users**: users who relied on the legacy auto-install into
  `<stdpath("data")>/pi2d` must install the `pi2` CLI via one of the Tier-1 channels
  (curl, brew, AUR, or npm). `:PiWeb` stops silently installing or executing via `npx`.
- **Documentation rewrite**: `README.md`, `docs/deployment.md`, and `docs/install.md` are
  rewritten to emphasize the CLI-first model and the compiled binary options.
- **Explicit `:PiWebInstall`**: `:PiWebInstall` remains available as an explicit fallback,
  installing a pinned version strictly matching the plugin release after user confirmation.
- **Node floor lowered to >= 20**: broader compatibility for npm users without compromising
  runtime stability.
- **Standalone binaries eliminate Node dependencies**: users of curl, Homebrew, and AUR
  require no Node installation, eliminating "distro Node is too old" issues entirely.
- **Service is optional**: `pi2 daemon` runs standalone in the foreground, and `pi2 doctor`
  treats missing service managers or linger as warnings, never fatal errors.
