# pi2 daemon — pi2 web console daemon

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

## Quick start

```bash
pnpm install
pnpm test
pnpm dev            # starts on 127.0.0.1:7676
```

The daemon is the `pi2 daemon` subcommand of the single shipped `pi2` binary — there is no
separate executable. The plugin starts it lazily when it is not running; you normally do not
start it by hand.

## Layout

| Path | Purpose |
|---|---|
| `src/protocol/` | wire types, event/command vocabulary, error codes, canonical reducer |
| `src/daemon/` | HTTP/WS/SSE, auth, static assets, routing, event relay |
| `src/instances/` | discovery, lazy spawn, single-instance enforcement, crash handling |
| `src/workspaces/` | workspace registry, disk discovery, aliases/trust |
| `src/cli/` | `pi2` — the `daemon` subcommand plus `attach`/`status`/`doctor` |
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
