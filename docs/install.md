# Installation & Run Guide

`pi2d` follows a **CLI-first architecture** ([ADR 0002](adr/0002-install-and-run.md)): install the `pi2` CLI on your machine, optionally run it as a persistent user service, and let editor plugins (like [pi2.nvim](https://github.com/zgs225/pi2.nvim)) connect as clients.

This document is the canonical reference for installing, running, configuring, upgrading, and troubleshooting `pi2d`.

---

## Decision table

Find your situation in the table below to choose the right installation command and run model:

| Situation | Recommended Command | What it gives you |
|---|---|---|
| **I have Node 20+** | `npm i -g @yuez/pi2d`<br>*(or `pnpm add -g`, `bun add -g`, `mise use -g npm:@yuez/pi2d`)* | The `pi2` CLI running directly on your existing Node.js environment, updated via standard package manager commands. |
| **no Node / old Node** | `curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh \| sh` | Standalone compiled binary in `~/.local/lib/pi2d` symlinked to `~/.local/bin/pi2`. Requires zero Node/npm dependencies and no root access. |
| **macOS** | `brew install zgs225/tap/pi2d`<br>*(or the curl installer)* | Native Homebrew formula. Places `pi2` in `$(brew --prefix)/bin` and web assets in `$(brew --prefix)/share/pi2d/web/dist`. |
| **Arch / EndeavourOS** | `paru -S pi2d-bin`<br>*(or `yay -S pi2d-bin`)* | Native Arch package managed by pacman. Binary in `/usr/bin/pi2`, web assets in `/usr/share/pi2d/web/dist`. |
| **NixOS** | `curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh \| sh`<br>*(or dev checkout)* | Standalone binary in user home (`~/.local/bin/pi2`). Bun's `-musl` binaries are dynamically linked against the musl loader, so running a prebuilt binary on NixOS needs `nix-ld` (or an FHS env / `steam-run`-style wrapper). |
| **I want it to survive reboot and logout** | `pi2 install-service --write`<br>`systemctl --user enable --now pi2.service`<br>`loginctl enable-linger $USER` | Background systemd user service (or launchd on macOS) that starts at boot and stays alive when SSH sessions disconnect. |
| **I only want to try it** | Install via curl or npm, then run:<br>`pi2 daemon` | Foreground daemon in your current terminal. Logs stream to stdout/stderr. Stop anytime with `Ctrl-C` or `pi2 stop`. |
| **I develop pi2d itself** | `git clone https://github.com/zgs225/pi2d.git`<br>`pnpm install && pnpm --dir web install` | Source checkout with hot-reloading backend (`pnpm dev`) and Vite dev server (`pnpm --dir web dev`). |

---

## Install channels

`pi2d` distributes through three primary channels:

### Channel A: Global package manager (Node >= 20)

Best when your workstation or server already has Node.js (version 20 or later) installed.

```bash
# npm
npm i -g @yuez/pi2d

# pnpm
pnpm add -g @yuez/pi2d

# bun
bun add -g @yuez/pi2d

# mise
mise use -g npm:@yuez/pi2d
```

**Where files land**:
- Executable binary: `$(npm config get prefix)/bin/pi2`
- Node package & web assets: `$(npm config get prefix)/lib/node_modules/@yuez/pi2d/` (with web assets in `web/dist/`)

---

### Channel B: Standalone curl installer (no Node required)

Best for systems with no Node runtime, machines with older distributions (such as Debian 12 shipping Node 18), or environments where you do not want to manage global npm packages.

```bash
curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh
```

The script automatically detects OS (`linux`, `darwin`), architecture (`x64`, `arm64`), and C library (`glibc`, `musl`). It downloads the corresponding precompiled standalone archive from GitHub Releases, verifies its SHA256 checksum, and extracts it with zero root privileges needed.

**Where files land**:
- Base directory: `~/.local/lib/pi2d/`
  - `~/.local/lib/pi2d/bin/pi2` (the compiled binary)
  - `~/.local/lib/pi2d/share/pi2d/web/dist/` (the web console UI assets)
  - `~/.local/lib/pi2d/LICENSE`
- Symlink: `~/.local/bin/pi2` points to `~/.local/lib/pi2d/bin/pi2`

Ensure `~/.local/bin` is in your `$PATH` (e.g. in your `~/.bashrc` or `~/.zshrc`):
```bash
export PATH="$HOME/.local/bin:$PATH"
```

#### Installer environment knobs

You can customize the installer behavior using environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PI2_VERSION` | latest GitHub release | Release version tag to install (e.g. `0.1.6`) |
| `PI2_INSTALL_DIR` | `$HOME/.local/lib/pi2d` | Directory where the binary and web bundle are extracted |
| `PI2_BIN_DIR` | `$HOME/.local/bin` | Directory where the `pi2` executable symlink is created |
| `PI2_ARCHIVE` | unset | Path to a local `.tar.gz` archive (skips network download) |
| `PI2_SKIP_CHECKSUM` | `0` | Set to `1` to bypass SHA256 checksum verification |
| `PI2_BASE_URL` | GitHub releases URL | Override download mirror or release asset base URL |
| `PI2_CHECKSUM_FILE` | unset | Explicit path to a local `SHA256SUMS` file |

Example installing a specific version to a custom prefix:
```bash
PI2_VERSION=0.1.6 PI2_BIN_DIR=/usr/local/bin PI2_INSTALL_DIR=/usr/local/lib/pi2d curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh
```

---

### Channel C: System packages (Homebrew & AUR)

*(Note: These channels are available once the release publishing compiled binaries has shipped).*

#### macOS / Linux (Homebrew Tap)
```bash
brew install zgs225/tap/pi2d
```
- Executable: `$(brew --prefix)/bin/pi2`
- UI Assets: `$(brew --prefix)/share/pi2d/web/dist`

#### Arch Linux / Manjaro / EndeavourOS (AUR)
```bash
paru -S pi2d-bin
# or:
yay -S pi2d-bin
```
- Executable: `/usr/bin/pi2`
- UI Assets: `/usr/share/pi2d/web/dist`

---

## Run modes

`pi2` is the CLI; `pi2 daemon` is the long-lived HTTP/WS gateway. Three run modes are supported:

### 1. User service (recommended)

Running `pi2` as a background user service is the recommended default. Because `pi2d` provides a web console with pairing links, QR codes, and remote device tokens, having the URL always reachable across editor sessions and reboots gives the best experience.

#### Rendering and writing the service

Run `pi2 install-service` to render the platform-appropriate service file:

```bash
# Preview what will be installed
pi2 install-service --dry-run

# Write the service file
pi2 install-service --write
```

The CLI inspects how it was installed:
- If running as a standalone compiled binary, `ExecStart` directly executes the binary (e.g. `/home/user/.local/lib/pi2d/bin/pi2 daemon --foreground`).
- If running via Node, `ExecStart` points to `<node> <scriptPath> daemon --foreground`.

#### Linux (`systemd --user`)

`pi2 install-service --write` creates `~/.config/systemd/user/pi2.service`.

1. **Enable and start the service**:
   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now pi2.service
   ```

2. **Enable lingering across logout**:
   On systemd-based distributions, user managers and their services terminate when the user's last session (desktop login or SSH session) closes. To keep `pi2.service` running 24/7 on servers or remote workstations:
   ```bash
   loginctl enable-linger $USER
   ```
   *(Check linger status anytime with `loginctl show-user $USER --property=Linger` or `pi2 doctor`.)*

3. **View logs**:
   ```bash
   journalctl --user -u pi2.service -f
   ```

4. **Service control**:
   ```bash
   systemctl --user status pi2.service   # check status
   systemctl --user restart pi2.service  # restart daemon
   systemctl --user stop pi2.service     # stop daemon
   ```

> **Important**: When running under systemd with `Restart=on-failure`, do **not** use `:PiWebStop` inside Neovim or process kill signals to shut down the daemon. Always use `systemctl --user stop pi2.service` so systemd does not interpret the shutdown as a failure and immediately restart it.

#### macOS (`launchd`)

`pi2 install-service --write` creates `~/Library/LaunchAgents/com.pi2.daemon.plist`.

1. **Bootstrap and start the agent**:
   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pi2.daemon.plist
   launchctl enable gui/$(id -u)/com.pi2.daemon
   launchctl kickstart -k gui/$(id -u)/com.pi2.daemon
   ```

2. **View logs**:
   Logs are configured directly in the plist:
   - Standard output: `~/Library/Logs/pi2/pi2-daemon.log`
   - Standard error: `~/Library/Logs/pi2/pi2-daemon.err.log`
   ```bash
   tail -f ~/Library/Logs/pi2/pi2-daemon.log
   ```

3. **Stop or unload the agent**:
   ```bash
   launchctl bootout gui/$(id -u)/com.pi2.daemon
   ```

#### Removing the service

To remove the installed service unit from either platform:
```bash
pi2 uninstall-service --write
```

---

### 2. Foreground process

For quick evaluation, local experiments, or debugging, run the daemon directly in a terminal:

```bash
pi2 daemon
```

- Output logs stream in real-time to stdout/stderr.
- In another terminal, open the console signed in:
  ```bash
  pi2 open
  ```
- Stop the foreground daemon with `Ctrl-C` in its terminal, or from any shell via:
  ```bash
  pi2 stop
  ```

---

### 3. Neovim plugin autostart (lazy spawn)

If you prefer not to keep a continuous daemon running, the Neovim plugin can start it on demand.

Configure pi2.nvim:
```lua
require("pi").setup({
  web = {
    autostart = "spawn", -- or "auto" (default: checks service first, then spawns)
  },
})
```

When you run `:PiWeb`, the plugin discovers `pi2` on `$PATH`, spawns a detached `pi2 daemon` process, and monitors its health.
- Logs are written to `$PI2_STATE_DIR/daemon.log` (`~/.local/state/pi2/daemon.log` on Linux, `~/Library/Logs/pi2/daemon.log` on macOS).
- Stop the spawned daemon with `:PiWebStop` in Neovim or `pi2 stop` from your terminal.

---

## Configuration

Daemon configuration is **strictly environment-only** ([ADR 0002](adr/0002-install-and-run.md)). There is no configuration file parser, complex precedence hierarchy, or file drift.

When running as a systemd user service, the generated unit includes:
```ini
EnvironmentFile=-%h/.config/pi2/env
```
The leading `-` prefix instructs systemd to ignore the file if it does not exist. Creating this file allows you to configure your daemon persistently without editing the service unit.

### Example `~/.config/pi2/env`

Create `~/.config/pi2/env`:

```bash
# ~/.config/pi2/env — Environment configuration for pi2 daemon

# Port to bind (default: 7676)
PI2_PORT=7676

# Network interface bind address:
#   0.0.0.0   = bind all interfaces (default; allows LAN / phone pairing)
#   127.0.0.1 = loopback only (local machine only)
PI2_HOST=0.0.0.0

# Public URL when accessed through a reverse proxy or Tailscale Serve:
# PI2_PUBLIC_URL=https://laptop.tail1234.ts.net

# Allowed workspace root directories (comma-separated):
# PI2_WORKSPACE_ROOTS=/home/user/workspace,/home/user/projects

# Logging verbosity: trace | debug | info | warn | error (default: info)
PI2_LOG_LEVEL=info

# Custom directory overrides (optional, default to standard XDG paths):
# PI2_RUNTIME_DIR=/run/user/1000/pi2
# PI2_STATE_DIR=/home/user/.local/state/pi2
# PI2_DATA_DIR=/home/user/.local/share/pi2
```

After editing `~/.config/pi2/env`, restart the systemd service:
```bash
systemctl --user restart pi2.service
```

*(On macOS, since launchd lacks an `EnvironmentFile` directive, set system environment variables or pass custom values when rendering via `pi2 install-service`).*

---

## Upgrading and uninstalling

### Upgrade per channel

- **Channel A (npm / pnpm / bun / mise)**:
  ```bash
  npm i -g @yuez/pi2d@latest
  # or:
  pnpm add -g @yuez/pi2d@latest
  bun add -g @yuez/pi2d@latest
  mise use -g npm:@yuez/pi2d@latest
  ```

- **Channel B (Standalone curl installer)**:
  Re-run the installer. It replaces the binary and assets cleanly in `~/.local/lib/pi2d`:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh
  ```

- **Channel C (Homebrew)**:
  ```bash
  brew update && brew upgrade pi2d
  ```

- **Channel C (Arch AUR)**:
  ```bash
  paru -Syu pi2d-bin
  # or:
  yay -Syu pi2d-bin
  ```

### Uninstall per channel

- **Channel A (npm / pnpm / bun)**:
  ```bash
  npm rm -g @yuez/pi2d
  # or: pnpm rm -g @yuez/pi2d / bun rm -g @yuez/pi2d
  ```

- **Channel B (curl installer)**:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh -s -- --uninstall
  ```
  *(Or manually delete `rm -rf ~/.local/lib/pi2d ~/.local/bin/pi2`)*.

- **Channel C (Homebrew)**:
  ```bash
  brew uninstall pi2d
  ```

- **Channel C (Arch AUR)**:
  ```bash
  sudo pacman -R pi2d-bin
  ```

If you configured a user service, remember to remove it before uninstalling the binary:
```bash
pi2 uninstall-service --write
```

---

## Verifying your installation

Use these three CLI commands to verify everything is working properly:

### 1. Version check
```bash
pi2 --version
```
Prints the CLI version (e.g. `0.1.5`).

### 2. Runtime status
```bash
pi2 status
```
Shows:
- Whether the daemon is currently running and what port/host it is bound to.
- Connected instances (nvim instances supervised per workspace).
- Active resource consumption (RSS, heap memory).
- Health probes.

### 3. Comprehensive diagnostic (`pi2 doctor`)
```bash
pi2 doctor
```
Runs an end-to-end check of the environment and outputs a diagnostic table:
- **node/runtime**: checks Node version (>= 20) or confirms bundled runtime (`bundled bun <version>`).
- **nvim**: verifies Neovim >= 0.9 on `$PATH`.
- **pi**: verifies the `pi` coding-agent CLI on `$PATH`.
- **curl**: verifies HTTP client availability.
- **plugin**: checks for `pi2.nvim` bridge installation in Neovim runtime paths.
- **runtime**: checks permissions (`0700`) on `$PI2_RUNTIME_DIR`.
- **cli-token**: checks permissions (`0600`) on admin token.
- **socket / daemon**: checks local daemon connectivity and protocol compatibility.
- **service-manager / linger**: reports systemd/launchd availability and whether user linger is enabled.
- **web-dist**: verifies static web console bundle assets exist and are readable.

---

## Why `npx` is not an install path

In earlier versions, invoking `npx -y @yuez/pi2d@latest` was considered as an automated fallback. [ADR 0002](adr/0002-install-and-run.md) explicitly rejected this model for several critical reasons:

1. **Path instability**: `npx` installs packages into temporary, cache-managed paths (`~/.npm/_npx/...`). These directories are routinely evicted by npm cache sweeps or version updates, breaking long-lived processes.
2. **Requires Node anyway**: If a machine has Node installed, `npm i -g @yuez/pi2d` takes seconds, produces a stable binary on `$PATH`, works completely offline, and does not re-query the registry. If a machine does not have Node, `npx` cannot run at all.
3. **Unstable unit `ExecStart`**: Service managers (systemd, launchd) require an immutable, absolute executable path in `ExecStart`. Pointing a background service unit to `npx` causes network lookups at boot time, unpredictable delays, and catastrophic failure in offline environments.
4. **Supply chain and version skew**: Running `@latest` dynamically when opening Neovim introduces network roundtrips, startup lag, and unexpected breaking updates midway through an editing session.

Instead, installing `pi2` once via your package manager or the standalone curl installer gives you a predictable, deterministic, and offline-capable executable.
