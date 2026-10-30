# ADR 0004 — One self-updating channel: the standalone artifact, owned by `pi2d`

- Status: accepted (implementing)
- Date: 2026-10-30
- Amends: [ADR 0002](0002-install-and-run.md) §2.1 (distribution channels) and §2.3 (the plugin is a client)
- Builds on: [ADR 0003](0003-self-update.md) (the install receipt and the versioned layout)

## Context

`pi2d` ships through four distributions — the curl installer, npm, a Homebrew tap and an AUR
`-bin` package — and ADR 0002 §2.1 kept `:PiWebInstall` in the plugin as an "explicit
convenience command" that installs the npm package into `<stdpath("data")>/pi2d`.

That gave two owners for one piece of software, and it broke in exactly the way two owners
always do. On a machine with a standalone (curl-installed) `pi2`, the plugin's npm copy sat in
`plugin-data` — a lower rung of the resolution ladder — so `:PiWebUpdate` upgraded a second copy
nobody ran, reported success, and the daemon kept serving the old version. The fix (dispatch on
`installShape`) landed first, but it papered over the design problem: the plugin should never
have been installing anything.

What the ecosystem does, checked against primary sources:

| Project | Stance |
|---|---|
| **nvim-lspconfig** | "nvim-lspconfig does not install language servers for you." The client plugin resolves a command on `PATH`. |
| **eglot** (Emacs) | Same: `eglot-server-programs` names executables; the user's package manager provides them. |
| **mason.nvim** | A *dedicated* installer ("Portable package manager for Neovim"), installing into `stdpath("data")/mason` and shelling out to `cargo`/`npm`. It exists because clients do not install. |
| **coc.nvim** | The counter-example: a Node service that owns `:CocInstall`. It pays by bundling a runtime and re-implementing a package manager. |
| **uv**, **deno**, **bun** | Upstream owns `self update`, and it *refuses* package-manager-owned trees with the command that owns them (uv reads an install receipt; deno prints "update through your package manager"). |
| **esbuild** | npm's way to ship a compiled binary: 26 `optionalDependencies` (`@esbuild/linux-x64`, …) plus a `bin` shim. |
| **pi / dsh / Claude Code / Codex / opencode / aider …** | (ADR 0002 §1) The agent is a first-class CLI installed by a package manager or `curl \| sh`; the editor plugin spawns or attaches, never installs. |

The common denominator: **whoever wrote the files owns the upgrade.** Anything else duplicates an
installer and guarantees a second, stale copy.

## Decision

### 1. One self-updating channel, owned by `pi2d`

The standalone release artifact is the only channel the project maintains end to end:

- `scripts/install.sh` installs it (versioned layout + receipt, ADR 0003),
- `pi2 update` upgrades it in place (verified digest, SLSA provenance, atomic `current` switch,
  one-step rollback),
- both live in this repository, next to the artifact they manage, and are the only place that
  knows the release matrix, the layout and the service unit.

### 2. npm, Homebrew and the AUR stay as *distributions*, not as install logic

They keep publishing, and their users keep upgrading with `npm i -g`, `brew upgrade pi2d` or
`paru -Syu pi2d-bin`. They are not channels we implement: `pi2 update` reads the receipt and
refuses them with their own command, which is the `uv` model and the reason a receipt exists.

### 3. The plugin is a client, and clients do not install

`pi2.nvim` resolves the daemon, uses it, and prints commands. Concretely:

- `:PiWebUpdate` drives `pi2 update` on the standalone channel, and prints the owning command on
  every other channel (no execution).
- `:PiWebInstall` stops installing anything: with no `pi2` it prints the install commands
  (standalone first); with a `pi2` it reports where it lives and points at `:PiWebUpdate`.
- `web.install_dir` and the `plugin-data` rung of the resolution ladder become deprecated
  read-only compatibility, so an existing npm copy keeps resolving while nothing writes a new one.

### 4. Deferred: shipping the binary through npm

An `optionalDependencies` shim (the esbuild model) would let npm deliver the *same* compiled
binary, collapsing `installShape` to a single value. It is not done now: it changes the npm
publish shape and buys nothing the standalone channel does not already provide.

## Consequences

- The plugin loses its installer (~200 lines and its specs); `pi2 update` gains no new code.
- `docs/install.md` and `README.md` reorder: the standalone installer is the path, the package
  managers are alternatives that own their own upgrades.
- A user who prefers npm keeps working unchanged, but upgrades with npm — and `:PiWebUpdate`
  tells them so instead of silently installing a second copy.
- The `mason.nvim`-shaped answer (a dedicated installer layer) stays available as a third party
  deciding to wrap `install.sh`; we do not need to build one.
