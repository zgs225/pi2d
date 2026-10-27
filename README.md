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

Requirements: **Node >= 22**, **Neovim >= 0.9**, the **`pi` CLI** on `PATH`.

You do not normally install this by hand. The pi2.nvim plugin detects a missing daemon,
offers to install it into its own data directory (no sudo, no global `PATH` edits) and
starts it lazily. The result is one command inside Neovim:

```
:PiWeb
```

…which opens your browser already signed in, showing the current workspace.

> **Status.** The npm package, the packaged web console and the lazy-start contract are
> ready (`npm i -g @yuez/pi2d` works today). `:PiWeb`, `:PiWebInstall` and the access-mode prompt
> land with the next pi2.nvim release; until then use `:PiWebStart` plus a manual install.

### Package managers (optional, for CLI-first users)

```bash
npm i -g @yuez/pi2d   # installs the `pi2` binary
pnpm add -g @yuez/pi2d
bun add -g @yuez/pi2d
```

Then:

```bash
pi2 daemon                 # foreground; the plugin/browser needs this running
pi2 stop                   # stop a running daemon (or: pi2 daemon stop)
pi2 install-service --write   # or run it at login: systemd --user / launchd
pi2 status                 # daemon + instances + health
pi2 doctor                 # node/nvim/pi/curl/plugin/runtime/web-dist/protocol checks
```

`pi2` is the only executable (`@yuez/pi2d` is the npm package name); `pi2 daemon` is a subcommand
of it, not a separate process. Runtime files, ports, auth, services and troubleshooting:
[docs/deployment.md](docs/deployment.md).

### Neovim plugin

```lua
{
    "zgs225/pi2.nvim",
    opts = {},                    -- add `web = { enabled = true }` to start the bridge at setup
    cmd = { "PiWeb", "PiWebStart", "PiWebStatus" },
}
```

`:PiWeb` is the whole install path: it resolves the daemon binary, installs it if needed,
spawns it, waits for the socket, and hands the browser a one-time login token. Nothing else
to configure.

The plugin looks for the daemon in this order, and `:PiWebStatus` reports which one won:

| # | Source | Where |
|---|---|---|
| 1 | `web.daemon` / `$PI2_DAEMON_BIN` | explicit path or command name |
| 2 | `pi2` on `PATH` | a global install |
| 3 | plugin data dir | `<stdpath("data")>/pi2d/node_modules/.bin/pi2` |
| 4 | repo checkout | `node_modules/.bin/pi2` (developing pi2d itself) |
| 5 | `npx -y @yuez/pi2d@latest` | last resort when nothing is writable |

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
