# Web console v1 — end-to-end acceptance report

- Date: 2026-10-21
- Gate: `bash scripts/e2e/run-all.sh`
- Result: **GREEN — 31/31 scenarios PASS, 0 FAIL, 0 SKIP** (4m13s)
- Plan: [`docs/e2e.md`](e2e.md)

## Environment

| Component | Version |
|---|---|
| node | v22.23.1 |
| nvim | 0.12.6 |
| pi | 1.3.0 |
| daemon | `pi2d` @ `31f3630` + working-tree fixes |
| plugin | `pi2.nvim` `feat/web-console` @ `ffec47c` + working-tree fixes |
| browser | Chrome (Playwright 1.63, headless) |
| model | `cliproxyapi` (real turns; `deepseek-v4-pro` in the browser run) |

Every suite starts an isolated daemon on an ephemeral port with throwaway
`PI2_RUNTIME_DIR` / `PI2_DATA_DIR` / `PI2_STATE_DIR` / `PI_CODING_AGENT_DIR`
and a fresh workspace; real pi turns are used for streaming, abort, subagent,
attention/diff and history. No user state or the user's daemon on `:7676` is
touched.

## Results

### API/WS suite (`scripts/e2e/api-e2e.mjs`) — 13/13 PASS (49.1s)

A0 bootstrap/auth · A1 workspaces · A2 instance lifecycle · A3 session create +
snapshot · A4 prompt + streaming · A5 abort · A6 model/thinking · A7 history
pagination · A8 reconnect/resync · A9 multi-workspace isolation · A10 subagents ·
A11 attention/diff review · A12 error matrix.

A11 is deterministic: `scripts/e2e/attention-ext.ts` registers an `e2e_request`
tool that emits a diff-shaped `extension_ui_request`; the test asserts the file is
absent before consent, accepts the review, and verifies the file plus a second
answer returning `E_ATTENTION_RESOLVED`.

### Browser suite (`scripts/e2e/ui-e2e.mjs`) — 18/18 PASS (180.1s)

B1 guard · B2 manual pair · B3 paste-link pair · B4 workspaces/add · B5 session
tree/create/rename/close · B6 prompt + streaming · B7 abort · B8 model/thinking ·
B9 panels/subagent dispatch/preview/tasks · B10 attention dialog · B11 status/
devices/revoke/disconnect · B12 reconnect · B13 valid + unknown deep links ·
B14 i18n/theme · C1 responsive (1440/768/380) · C2 breakpoint navigation ·
C3 dark/light screenshots · C4 zero unexpected console errors/pageerrors.

## Bugs found by the E2E pass and fixed

### Plugin (`pi2.nvim`)

- `session.create`/`open` acked the placeholder `tmp-N`; the backend id migrated
  ~2 s later with no announcement, so the daemon could not route `prompt.send`
  (`E_SESSION_NOT_FOUND`) and the browser went dark. Commands now wait for the
  real id (≤5 s, `pending` on timeout), keep an alias, announce
  `pi2:session{sessionId,previousSessionId}` on the old id, and refresh
  `instance_state`.
- Attention leaked: resolution was only emitted from `send_response`, the snapshot
  cleared only non-empty queues, projections dropped title/options/timeout/payload,
  and a locally-open dialog removed the entry (blocking web answers). Every
  removal path now emits `pi2:attention_resolved`; requests default to 120 s;
  snapshots always project `attention[]`; diff requests are `method="diff"` with
  the files payload; a locally-open request stays answerable (first answer wins).
- Snapshots carried no entries; the reducer grew without bound. Snapshots now
  carry the newest ≤50 entries / ≤256 KB, the reducer retains 500.
- `text_delta` seq could regress when coalesced; seq is assigned at flush time.
- Unknown commands returned `E_INTERNAL`; the bridge routes them through
  `commands.dispatch` (`E_METHOD_NOT_ALLOWED`).
- `session.setThinking`/`setModel` accepted invalid values; both now validate
  (thinking levels; model against the workspace models cache).
- `queue.remove`/`setSteer` now accept the wire queue ids / mode; `task.output`
  is implemented; `subagent.dispatch` accepts the canonical `items[]` shape;
  `attention.respond` accepts the structured response table.

### Daemon (`pi2d`)

- Workspaces outside `PI2_WORKSPACE_ROOTS` returned `500 E_INTERNAL`; now
  `403 E_FORBIDDEN`.
- Snapshot `entries` tails were dropped (only `state` forwarded); the cache and
  the WS frame now preserve `{state, entries}` for cached and cold subscribes.
- The first WS subscribe for a fresh session sent no snapshot; snapshots are
  forwarded from the plugin bus and awaited on cold subscribe.
- `cli.token` was rotated before the singleton lock, invalidating a running
  daemon; it is now minted only after the lock is held.
- `/api/v1/info` gained additive `hostname`, `os`, `version`, `uptimeMs`, `pid`,
  `port`; `/health` reflects instance/workspace/auth state.

### Web (`pi2d/web`)

- Pairing posted `pair.redeem` to the bearer-gated `/api/v1/cmd` → every pairing
  401. The manual/scan flows now redeem the public `POST /api/v1/pair`
  (`{code,kind,deviceName}`), persist scopes, and keep the `next` deep link.
- WebSocket auth sent `Bearer <token>` while the daemon hashes the raw token;
  the client now strips the prefix on every socket.
- Duplicate assistant messages / `PONGONG`: snapshot tails and REST history had
  different id spaces, and coalesced deltas could arrive after `message_end`.
  Merge is now one-to-one with a text/ts fallback; late deltas for a done entry
  are dropped.
- Dialogs were unclickable (content behind the Radix overlay); fixed in the
  component + CSS.
- Chat commands used the wrong shapes for setModel, attention responses, diff
  accept/reject, subagent dispatch, queue remove/steer, task output and WS
  resume. All now match the plugin contract.
- Status devices read `{devices}` while the daemon returns an array; devices now
  list, revoke and disappear correctly; the WS state, identity fields and a live
  pairing code/QR are rendered.
- `/chat/<unknown>` silently fell back to `sessions[0]`; it now shows
  “Session not found” + Retry + back link and never renders another session.

## Non-blocking notes (accepted)

- A4 may warn that a coalesced `text_delta` is written after `agent_settled`
  (the 50 ms flush timer outlives the turn); the browser drops stale deltas.
- A6/B8 note that the selected model clamps `thinking=low` to a supported level
  (`high` here). The command is accepted and the UI reflects the clamped level;
  this is model capability, not a plugin failure.
- `diagnostics.eventRate` / `slowQueries` remain constants (no metric source).
- Attention `input`/`editor` methods still have no free-text web field (cancel
  only); tracked as a follow-up.
- `scripts/e2e/full-e2e.sh` and `visual.sh` predate the new harness; `run-all.sh`
  is the gate. They are kept for ad-hoc debugging.

## Reproduction

```bash
cd /home/yuez/Workspace/Neovim/pi2d
bash scripts/e2e/run-all.sh          # builds daemon + web, runs API then browser

# individual suites
bash scripts/e2e/run-api.sh
bash scripts/e2e/run-ui.sh
```

`E2E_KEEP=1` keeps the temp root (logs, `report/api-results.json`,
`report/ui-e2e.json`, `screens/*.png`); `E2E_SKIP_BUILD=1` reuses existing
`dist/` builds for a fast rerun.

## Residual risk

- The browser suite drives one real model (provider-dependent timing). Waits are
  bounded (120 s turns, 15 s instances) and the run is green, but a slow provider
  can still push a turn past the budget.
- The E2E harness is Linux-specific (`/proc`-based reaping) and expects
  `jq`, `nvim`, `pi`, node ≥22 and Playwright/Chrome available.
- Cross-source message dedupe is text/timestamp based for synthetic-id vs raw-id
  entries; identical repeated replies rely on one-to-one pairing and closest-ts
  ordering (message counts/text stay correct; ids may attach to the other copy).
