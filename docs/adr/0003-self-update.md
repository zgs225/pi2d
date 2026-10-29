# ADR 0003 — `pi2 update`: a versioned install layout and an install receipt

- Status: accepted (implementing)
- Date: 2026-10-29
- Extends: [ADR 0002](0002-install-and-run.md) §2.9.1 (the deferred `pi2 update`)

## Context

ADR 0002 deferred an in-place self-updater because "package managers already upgrade
well". That holds for Homebrew, the AUR and npm, but not for the **standalone channel**
(Channel B, `scripts/install.sh`): the upstream upgrade path there is "re-run the
installer", which the Neovim plugin cannot do safely and which forces a re-download of
the whole 35 MB artifact with no version arithmetic, no provenance check and no
rollback.

Two facts shaped the design:

1. **A compiled `bun build --compile` binary cannot be written in place** (`ETXTBSY`),
   but `rename()` over the running executable works on both Linux and macOS, and the
   running process keeps its old inode. So replacement must be a staged rename, never
   an in-place write.
2. **The install is two trees** (`bin/` + `share/pi2d/web/dist`), and renaming two
   directories is not atomic. A half-finished update would leave a new binary with an
   old UI.

`pi2` cannot guess its channel reliably from its own path: `~/.local/bin/pi2`,
`$(brew --prefix)/bin/pi2`, `/usr/bin/pi2` and `<data>/pi2d/node_modules/.bin/pi2` all
look equally like "some binary". Guessing wrong means either corrupting a
package-manager-owned tree or refusing a legitimate update.

## Decision

### 1. The curl channel installs into a versioned layout

```
<prefix>/                       default ~/.local/lib/pi2d (PI2_INSTALL_DIR)
  versions/
    0.1.6/
      bin/pi2
      share/pi2d/web/dist/…
      LICENSE
    0.1.7/                      ← one immutable tree per version
  current -> versions/0.1.7     ← relative symlink, the only thing that moves
  install.json                  ← the receipt (never inside a version tree)
<bin dir>/pi2 -> <prefix>/current/bin/pi2
```

A version tree is immutable once written, so `current` is the single atomic switch and
`bin/` + `share/` can never disagree. Rollback is one symlink write, and the previous
tree stays on disk (pruned to `current` + 1 previous). `PI2_BIN_DIR/pi2` points at
`current`, so the plugin, the user's `PATH` and the rendered service unit all keep
working across an update — **`ExecStart` must use the `current` path, not
`<prefix>/versions/<v>/bin/pi2`**, or the unit breaks on every update.

The tarball keeps its flat `bin/` + `share/` shape: the version directory is created by
the installer, not by the release artifact.

### 2. The installer writes a receipt, and only the receipt authorises an update

`<prefix>/install.json`:

```json
{
  "schema": 1,
  "installer": "curl",
  "layout": "versioned",
  "prefix": "/home/u/.local/lib/pi2d",
  "current": "/home/u/.local/lib/pi2d/current",
  "version": "0.1.6",
  "bin": "/home/u/.local/lib/pi2d/versions/0.1.6/bin/pi2",
  "asset": "pi2d-0.1.6-linux-x64.tar.gz",
  "sha256": "d560f84c…",
  "installed_at": "2026-10-29T07:32:00Z"
}
```

`pi2 update` refuses unless **all** of these hold:

| Condition | Failure message points at |
|---|---|
| running as a compiled binary | `npm i -g @yuez/pi2d@latest` (npm channel) |
| `<prefix>/install.json` exists | `brew upgrade pi2d` / an AUR helper / "re-run the installer once" (legacy flat layout) |
| `installer == "curl"` | the channel's own command (`brew upgrade`, `paru -Syu pi2d-bin`, `npm i -g`) |
| `bin == realpath(process.execPath)` | "another copy of pi2 is installed" |

`installer` is written by whoever installed it: `install.sh` writes `curl`; the
Homebrew formula and the AUR `PKGBUILD` write `brew` / `aur` when they can, and their
absence merely lands in the "no receipt" row above. npm installs never write one.

This is the `uv` model (`load_receipt()` + "assume a package manager when no receipt is
found"), which is the only channel detection that cannot be spoofed by a stray binary
on `PATH`.

### 3. `pi2 update` implements the transfer itself (native TypeScript)

Not "download and pipe the installer into `sh`" (uv's approach): the updater must be
hermetic-testable (`AGENTS.md` hard rule 5), must not execute remote code, and has to
verify provenance — none of which a `curl | sh` subprocess gives us. So:

- release + asset resolution via the GitHub API, cached by ETag in
  `<state>/update-check.json` (unauthenticated API is 60 req/h; `pi2 update --check`
  must not burn it),
- asset selection from the build-time `PI2_BUILD_TARGET` define, not runtime libc
  probing,
- `SHA256SUMS` verification, then **SLSA provenance** via `gh attestation verify`
  (required with `--require-attestation`; otherwise a warning, because `gh` is not
  guaranteed to be installed),
- extraction with a dependency-free tar reader, so no `tar`/`sh` subprocess,
- the staged binary is executed (`--version`) before anything is swapped.

### 4. Defaults

| Behaviour | Default | Override |
|---|---|---|
| restarts a running service | no, prints the command | — (`pi2 service stop && pi2 service start`) |
| downgrade | refused | `--force` |
| same version | "already up to date", no download | `--force` |
| attestation | verify when `gh` is available, else warn | `--require-attestation`, `--skip-attestation` |
| mirror / offline test | GitHub releases | `PI2_BASE_URL` (same knob as `install.sh`) |
| version lookups | cached 24 h | `PI2_UPDATE_CACHE_TTL` |

Restart stays manual on purpose: the daemon is shared by every Neovim instance and the
browser, and silently bouncing it mid-task is worse than asking.

## Consequences

- `scripts/install.sh` gains the versioned layout, the receipt and a migration from the
  flat layout; `pi2 install-service` must render the `current` path.
- The flat layout is dead for the curl channel. An existing flat install keeps working
  but cannot self-update until the installer runs once more.
- `pi2 update` is curl-only by design. Everything else is told to use its own package
  manager, which is what ADR 0002 wanted.
- A future single-file artifact (embedding `web/dist` into the binary) would make the
  swap a single rename, but `import … with { type: "file" }` gives no directory
  listing and no `realpath`, which the static-file guard in `src/daemon/static.ts`
  relies on. Not worth it today.
- Windows is out of scope: the whole release matrix is Linux/macOS, and an
  in-process on Windows self-replace needs a helper process.
