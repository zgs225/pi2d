# pi2d — pi2 web console daemon

The always-on web side of [pi2.nvim](https://github.com/…/pi2.nvim). It is a **router + supervisor**, not an agent runtime:

```
browser ──HTTP/WS──▶ pi2d ──JSONL unix socket──▶ one nvim per workspace (pi2.nvim)
                                                   └── one pi --mode rpc per active session
```

Hard rules (see `docs/protocol.md`):

1. `pi2d` never spawns `pi`, never reads session JSONL, never owns session state.
2. A workspace maps to **exactly one** managed nvim instance.
3. All mutations are commands relayed to the plugin; the plugin (inside nvim) is the single source of truth.
4. The web client keeps a render cache only; a `snapshot` from the plugin replaces it wholesale.

## Quick start

```bash
pnpm install
pnpm test
pnpm dev            # starts on 127.0.0.1:7676
```

The plugin starts the daemon lazily when it is not running; you normally do not start it by hand.

## Layout

| Path | Purpose |
|---|---|
| `src/protocol/` | wire types, event/command vocabulary, error codes, canonical reducer |
| `src/daemon/` | HTTP/WS/SSE, auth, static assets, routing, event relay |
| `src/instances/` | discovery, lazy spawn, single-instance enforcement, crash handling |
| `src/workspaces/` | workspace registry, disk discovery, aliases/trust |
| `src/cli/` | `pi2d` (daemon) and `pi2` (attach/status/doctor) |
| `fixtures/` | golden event streams + expected session state (shared with pi2.nvim tests) |
| `docs/protocol.md` | the wire contract (browser ↔ daemon ↔ plugin) |
