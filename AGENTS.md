# AGENTS.md — pi2d

`pi2 daemon`: the web-console daemon for [pi2.nvim](https://github.com/zgs225/pi2.nvim).
A browser talks HTTP/WS to it; it relays JSONL to one nvim per workspace. It is a router and
supervisor — it never runs `pi` and never owns session state.

**This file is an index and must stay under 100 lines.** When something needs more than a line
or two, put the depth in `docs/` or a skill under `.agents/skills/` and leave a pointer here.
Adding bulk to this file is a mistake, not a contribution.

## Quick reference

| Task | Command |
|---|---|
| Install | `pnpm install && pnpm --dir web install` |
| Typecheck | `pnpm typecheck && pnpm --dir web typecheck` |
| Unit tests | `pnpm test` (daemon) · `pnpm --dir web exec vitest run` (web) |
| Build | `pnpm build` → `dist/` · `pnpm build:web` → `web/dist/` |
| Smoke | `bash scripts/smoke.sh` — isolated tmp dirs, asserts HTTP, static UI, tokens, clean SIGTERM |
| E2E | `bash scripts/e2e/run-all.sh` — API suite then Playwright; needs a real `pi`, `nvim`, `curl` |
| Dev loop | `pnpm dev` (:7676) · `pnpm --dir web dev` (:5173, proxies `/api` + `/ws`) |
| Release | skill `.agents/skills/release/` |

## Layout

| Path | Contents |
|---|---|
| `src/protocol/` | wire types, command/event vocabulary, error codes, canonical reducer |
| `src/daemon/` | HTTP/WS/SSE, auth, static assets, routing, event relay |
| `src/instances/` | discovery, lazy spawn, one-instance-per-workspace, crash handling |
| `src/workspaces/` | registry, disk discovery, aliases/trust, visibility policy |
| `src/cli/` | `pi2` — `daemon`, `open`, `attach`, `status`, `doctor`, `pairing`, `install-service` |
| `src/config.ts` | env-only configuration (`PI2_*`, `PI2_HOST`, `PI2_WORKSPACE_*`) |
| `src/core/network.ts` | reachable addresses: kind classification, `bases[]` order, CORS origins |
| `src/core/qr.ts` | zero-dependency QR encoder (pairing links; rows, no quiet zone) |
| `web/` | React console (own lockfile + workspace); built into `web/dist` and served by the daemon |
| `fixtures/` | golden event streams + expected state, shared with pi2.nvim conformance tests |
| `test/` | vitest, hermetic, injectable I/O |
| `scripts/` | `smoke.sh`, `e2e/` drivers, `gen-expected.ts` |

## Hard rules

1. **`docs/protocol.md` is the contract.** Any wire change lands with the daemon, the web client
   and the pi2.nvim bridge in view; `fixtures/` are regenerated via `scripts/gen-expected.ts`.
2. **The daemon is not an agent runtime.** No `pi` spawning, no JSONL session parsing, no session
   state. Snapshots and mutations are relayed to the plugin, which stays the single authority.
3. **`dist/` and `web/dist/` are build output** — gitignored, never committed. They ship inside
   the npm tarball through `prepack` + the `files` allowlist.
4. **Two lockfiles.** Root `pnpm-lock.yaml` and `web/pnpm-lock.yaml` are independent: use
   `pnpm --dir web …` for anything web-side, never a root install.
5. **Tests are hermetic.** No real sockets, spawns or networks outside `scripts/e2e/`; inject
   probes (`DoctorContext`, `WorkspaceStoreOptions.env`, fake instance managers) and keep
   `fixtures/` byte-identical.
6. **Local sign-in is loopback-only.** `POST /api/v1/console/session` requires the CLI token from
   the runtime dir, the browser token travels in the URL fragment only, device tokens are stored
   hashed, and `lan`/`tailscale` modes never auto-sign-in.
7. **Conventional commits** (`feat(daemon):`, `fix(web):`, `docs:`, `ci:`), scoped to the area.

## Naming, so you do not get lost

npm package `@yuez/pi2d` (scoped — the unscoped `pi2d` is rejected by the registry's similarity
filter), executable `pi2`, GitHub repo `zgs225/pi2d` (the trusted publisher matches on
owner/repo/workflow filename, not the npm name).

## Where to read deeper

| Doc | Contents |
|---|---|
| `docs/protocol.md` | the browser ↔ daemon ↔ plugin wire contract |
| `docs/deployment.md` | env vars, runtime files, ports, auth, services, troubleshooting |
| `docs/e2e.md` | scenario ids, isolation, skip conditions, report paths |
| `docs/releasing.md` | npm Trusted Publishing, the bootstrap phases, verification |
| `README.md` | install paths, `:PiWeb`, binding & pairing |
| `.agents/skills/release/` | how to cut and verify a release |

## Before you say "done"

`pnpm typecheck && pnpm test && pnpm --dir web typecheck && pnpm --dir web exec vitest run &&
bash scripts/smoke.sh` green; docs updated where behaviour changed; no build output staged.
