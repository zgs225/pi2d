# End-to-end test plan (web console v1)

Status: **authoritative for the v1 web-console E2E gate**. This plan covers the three
processes that make the console real, and describes the harness that implements it:
`scripts/e2e/lib.sh` (lifecycle, isolation) plus the `run-api.sh` / `run-ui.sh` /
`run-all.sh` drivers (see §2, §3 and §7).

```
browser (React in web/dist)
      │ HTTP + WS
      ▼
pi2 daemon (src/)  ── JSONL unix socket ──▶  headless nvim + pi2.nvim web layer
                                                       └── pi --mode rpc (real model)
```

Authority, highest first:

1. `docs/protocol.md` + `src/protocol/types.ts` (wire contract)
2. `pi2.nvim` `lua/pi/web/**` (state/command authority)
3. `lint`/`vitest` suites (unit contracts)
4. `pi2-web-ui-design/design/DESIGN-SPEC.md` + `web/ACCEPTANCE.md` (UI intent; some
   details are stale, see the design recon)

The static prototype repo is a **visual reference only**. Assertions in this plan target
the real daemon/plugin/browser, never `MOCK.*` data.

## 1. What “complete” means

The v1 gate is green when:

- **A0–A13** (API/WS against a real headless nvim + real pi) pass.
- **B1–B14** (Playwright against the daemon-served production bundle) pass.
- **C1–C4** (responsive, theme, language, no console errors) pass.
- `tsc --noEmit`, `vitest run` (daemon), `vitest run` (web) stay green.
- Every failure found while running this plan is either fixed and re-verified, or
  recorded as an explicit, justified non-blocking gap in the report.

Real model calls are allowed and expected (one short turn plus one abort turn, one
subagent turn). The suite must still be deterministic: each run uses a fresh workspace,
a fresh pairing code, ephemeral ports and isolated state directories.

## 2. Harness topology and isolation

Four scripts, not one: **`scripts/e2e/lib.sh`** is the lifecycle library (source, then call
`e2e_init <suite>`), and the three drivers are thin wrappers over it — **`run-api.sh`** (A*),
**`run-ui.sh`** (B*/C*), **`run-all.sh`** (both, API first, aggregating the exit code).
`e2e_init` creates a temp root per suite, so `run-all.sh` never shares state between the two
runs:

| Resource | Value |
|---|---|
| `E2E_ROOT` | `mktemp -d /tmp/pi2-e2e-<suite>.XXXXXX` — `api` and `ui` get separate roots |
| `PI2_RUNTIME_DIR` | `$E2E_ROOT/run` (`cli.token`, `daemon.json`, instance sockets) |
| `PI2_DATA_DIR` | `$E2E_ROOT/data` (devices, workspaces) |
| `PI2_STATE_DIR` | `$E2E_ROOT/state` (daemon + instance logs) |
| `PI_CODING_AGENT_DIR` **and** `PI2_CODING_AGENT_DIR` | `$E2E_ROOT/agent` — both names are exported: `pi` and daemon discovery each read one of them, so neither can fall back to `~/.pi/agent` |
| `PI2_WORKSPACE_ROOTS` | `$E2E_ROOT/workspaces` (only the test workspaces under it are addable) |
| `PI2_PORT` | `0` (ephemeral; the real port is read from `run/daemon.json`) |
| `PI2_STATIC_DIR` | `<repo>/web/dist` (rebuilt before the UI suite unless `E2E_SKIP_BUILD=1`) |
| `PI2_NVIM_INIT` | `<repo>/scripts/e2e/host-init.lua` |
| `PI2_E2E_PLUGIN` | plugin worktree (default `/home/yuez/Workspace/Neovim/pi2.nvim-web`; must contain `lua/pi/web/`) |
| `PI2_NVIM_BIN` | `nvim` from `PATH`, overridable |

Overridable knobs:

| Variable | Effect |
|---|---|
| `E2E_SKIP_BUILD=1` | Skip `e2e_build` (no `tsc`, no `pnpm -s build` in `web/`); requires a current `dist/` and `web/dist` |
| `E2E_KEEP=1` | Keep the temp root instead of deleting it; a **failing** suite forces it and prints the path |
| `E2E_REPO` | Repository root (default: two levels up from `lib.sh`) |
| `PI2_E2E_PLAYWRIGHT_MODULE` | Explicit `playwright` module path; otherwise `require("playwright")`, then the mise `npm-playwright` installs are tried |
| `PI2_E2E_CHROME` | Chrome binary for Playwright (default `/usr/bin/google-chrome-stable`, bundled Chromium when absent) |
| `PI2_LOG_LEVEL` | Daemon log level (default `info`) |

`scripts/e2e/host-init.lua` is the headless instance's `-u` init: it prepends the plugin under
test to `runtimepath`, disables swapfile/shada, and calls
`require("pi").setup({ web = { enabled = true, log = true, auto_start = false }, cli = { args = { "--extension", <dir>/attention-ext.ts } } })`.
The test-only extension (`scripts/e2e/attention-ext.ts`, asserted readable at init) is how A11
and B10 get a real `extension_ui_request`: it registers an `e2e_request` tool plus a
`before_agent_start` trigger keyed on the `[[e2e-attention]]` / `[[e2e-attention-reject]]`
markers, so the diff review does not depend on the model choosing to call the tool.

Rules:

- Before anything starts, `e2e_init` requires `node`, `nvim`, `pi`, `jq` and `curl`, a plugin
  worktree with `lua/pi/web/commands.lua`, a built `dist/cli/pi2.js`, and `host-init.lua`.
  Missing pieces exit 2 with the artifacts path.
- Never touch a daemon already running in the default runtime dir. `e2e_stop` terminates the
  daemon it started, then reaps every process whose command line contains `$E2E_ROOT`
  (headless nvim hosts and their `pi --mode rpc` children). No machine-wide `pkill`.
- Pairing codes are single-use and expire (600 s); one per suite.
- Workspaces are fresh empty dirs under the suite root. No previous-run workspace is reused.
- Browser language is pinned to `en` (`pi2-lang`) before the app boots; theme/width
  are set per case. Text assertions use the English catalog.
- Every wait is bounded: instance `ready` ≤ 20 s, model turn ≤ 120 s, abort settle ≤ 10 s,
  WS `hello_ack` ≤ 10 s.

## 3. Layers

| Layer | Runner | Covers |
|---|---|---|
| API/WS | `scripts/e2e/api-e2e.mjs` (Node, `ws`) | A* — protocol, commands, events, reducer-visible state |
| Browser | `scripts/e2e/ui-e2e.mjs` (Playwright, Chromium) | B* — pairing, pages, real interactions, streaming DOM |
| Visual/responsive | same browser script, `screens/` | C* — overflow, screenshots, theme, i18n, console errors |

`run-all.sh` runs the API suite first (it proves the backend the browser suite depends on)
then the browser suite, each in its own temp root. Both drivers are standalone when the
`E2E_*`/`PI2_*` environment is already set (`ui-e2e.mjs` additionally needs `E2E_BASE` and
`E2E_CLI_TOKEN`).

## 4. Scenarios

All scenario ids below are implemented in the two drivers: `scenario("A0", …)` … `scenario("A13", …)`
in `api-e2e.mjs`, `scenario("B1", …)` … `scenario("B14", …)` and `scenario("C1", …)` …
`scenario("C4", …)` in `ui-e2e.mjs`. A driver exits non-zero only on **FAIL**; SKIP is
tolerant, and every skip is printed with its reason and written into the report.

Known SKIP paths (deterministic by design, not failures):

- dependent scenarios when their prerequisite produced nothing (e.g. `A4`–`A12` skip when
  `A3` created no session);
- `A5` when the slow turn streamed no delta inside the abort window;
- `A11` when no `pi2:attention_request` and no `attention[]` entry arrives within 45 s — the
  skip message still says host init “enables only pi.web”, but `host-init.lua` does load
  `attention-ext.ts`; the scenario now skips only if the request genuinely never surfaces;
- `B8` when the workspace reports no models to switch to;
- `B10` when no attention dialog appears within 45 s (it notes whether the file was written
  without consent);
- `B12`/`B13` when `B6` produced no session to reuse;
- any scenario not reached because the suite's total runtime budget was exhausted.

The plan's original intent below is unchanged; the legend **P0**/**P1**/**P2** still applies.

### 4.1 A — API/WS suite

**A0 Bootstrap & auth**
- daemon starts on an ephemeral port, writes `daemon.json`, `cli.token` is 0600.
- `GET /api/v1/info` → `v=1`, `daemonId`/`capabilities` present.
- `GET /api/v1/health` → `ok=true`, `static` item ok (web/dist served).
- `GET /` → 200 HTML containing the app root.
- unauthenticated `GET /api/v1/workspaces` → 401 `E_UNAUTHORIZED`; bogus bearer → 401.
- `POST /api/v1/pair` redeem: valid code → `{token, device}`; same code again → 401;
  the token authorizes the API; `DELETE /api/v1/devices/:id` revokes it (next call 401).

**A1 Workspaces**
- `workspace.add {cwd, trust:true}` for W1/W2 → 202, 16-hex `workspaceId`, `trusted`.
- re-adding the same cwd returns the same id (idempotent).
- a cwd outside `PI2_WORKSPACE_ROOTS` → 4xx, no workspace created.
- `GET /api/v1/workspaces` shape: `workspaceId,cwd,name,sessionCount,liveCount,instance`.

**A2 Instance lifecycle**
- `instance.ensure {workspaceId}` (W1) → 202; poll `GET /workspaces` until
  `instance.status === "ready"` ≤ 15 s.
- `instance.ensure` is idempotent.
- `GET /api/v1/workspaces/:id/sessions` → `{sessions:[…]}` (object, not array).

**A3 Session create + snapshot**
- `session.create {workspaceId:W1}` → 202 with a non-placeholder `sessionId`.
- WS: `auth` → `hello_ack`; `subscribe {sessionIds:[sid]}` → `snapshot` with
  `sessionId/epoch/seq/state`; state has `sessionId,workspaceId,cwd,status,model,
  thinking,usage,contextUsage,queue,todos,tasks,batches,subagents,attention,entries`.
- `seq` is monotonic; every subsequent event has the same epoch and `seq+1`.
- the sessions REST record shows the new session as `live:true`.

**A4 Prompt + streaming (real model)**
- `prompt.send {text:"Reply with exactly the word PONG and nothing else."}`.
- WS events: `message_start`/`message_update` deltas for the assistant, no locally
  invented user entry (the user entry arrives as an event), `message_end` replaces the
  assistant blocks, `agent_settled` → status `idle`.
- final assistant text, trimmed and lowercased, is exactly `pong`; exactly one assistant
  entry for the turn; no duplicate entry ids; usage/contextUsage updated.
- `GET entries?limit=50` returns the same entry ids in the same order as the snapshot.

**A5 Abort**
- start a slow turn (`"Count from 1 to 200, one number per line."`); wait for the first
  assistant delta; `prompt.abort`; within 10 s `agent_settled{aborted:true}` and status
  `idle`; no assistant delta after the settle; a second abort is harmless (no error
  state; 2xx or idempotent error code).

**A6 Model / thinking**
- `GET /api/v1/models?workspaceId=W1` → `{providers:[{provider,models:[…]}]}`.
- `session.setThinking {level:"low"}` → ack; snapshot/session reports `thinking=low`.
- `session.setModel {model:{provider,id}}` with a listed model → ack; session reports
  that provider/id; the next snapshot preserves it.
- invalid level/model → 400 with a stable error code, no state change.

**A7 History pagination**
- after A4, fetch `entries?limit=2&workspaceId=W1&sessionFile=<file>` → `{entries,
  nextCursor|hasMore}`; the second page (`before=<cursor>`) returns different entries;
  concatenation has no duplicate ids and ends at the oldest entry; `hasMore=false` at
  the end; ordering is stable.

**A8 Reconnect / resync**
- open a second WS, subscribe to the session, close it mid-turn, reconnect with the
  daemon's resume shape (`payload.since={sessionId,epoch,seq}`).
- response is a `snapshot` (or `resync_required` followed by one); the final state
  contains the same entry ids as a fresh subscribe; no seq regression.

**A9 Multi-workspace isolation**
- create a session in W2 and send a short prompt; W1's session query never lists the W2
  session; a WS subscribed only to W1 receives no W2 events; W1 models query remains
  workspace-scoped.

**A10 Subagents**
- `subagent.dispatch {items:[{task:"Reply with exactly the word SUB and nothing else.",
  name:"e2e-sub"}]}` → ack; within 120 s `pi2:batch` (running → completed) and
  `pi2:subagents` with the child (active/completed); the child session is listed/queryable;
  `subagent.stop {targets:[<child>]}` → ack and child becomes `dormant`/`completed`;
  replaying the same `clientRequestId` does not create a second batch.

**A11 Attention / diff review (pre-execution)**
- host init enables diff review for `write`/`edit`; prompt the model to create
  `e2e-attention.txt` with content `hello-e2e`.
- before answering: `pi2:attention_request` arrives with `requestId/method/title/options/
  payload.files`, `attention[]` in the snapshot contains it, and the file does **not**
  exist yet.
- `attention.respond {requestId, response:{value: <JSON string {result:"Accepted"}>}}`
  → ack; `pi2:attention_resolved`; the file exists with the requested content; the tool
  block is accepted; a second respond gets `E_ATTENTION_RESOLVED`.
- reject case: another file is requested; respond `{cancelled:true}` (or Rejected);
  the file does not exist and the turn continues/settles without error state.

**A13 Console login handoff**
- `POST /api/v1/console/session` with the CLI token → 200, one `local browser`/`laptop`
  device with every scope, and a `http://127.0.0.1:<port>/#t=<token>` URL (fragment only,
  never `?t=`).
- the handed-off token authenticates; a second login returns the **same** token so a second
  `:PiWeb` does not log the open tab out.
- no CLI token → 401, a device token → 401 (loopback-only, local-CLI-only).
- revoking the device → 204, the old token → 401, and the next login mints a new token.

**A12 Errors**
- unknown session id → `E_SESSION_NOT_FOUND`; malformed `cmd` → `E_BAD_REQUEST`;
  unknown method → `E_METHOD_NOT_ALLOWED`; oversized/malformed JSON does not kill the
  daemon (next request still 200).
- every error is a JSON body with `code`, `message`, `retryable`.

### 4.2 B — Browser suite (Playwright, daemon-served bundle)

**B1 Unpaired guard**
- empty storage → `/workspaces` redirects to `/connect?next=%2Fworkspaces`; the connect
  page has **no** nav/rail/tabbar and no server chip; `/status` and `/chat` behave the same.
- `next` with an external URL is rejected; after pairing the user returns to the
  allow-listed `next`.

**B2 Pairing (manual)**
- enter host/port/pairing code/device name → `POST /api/v1/pair` succeeds; the summary
  shows server/endpoint/device/scopes; localStorage keys are written; redirect to `next`.
- wrong code → inline localized error, still unpaired, form stays usable.
- while paired, `/connect` shows the summary, not the form; disconnect asks for
  confirmation and clears the connection (returns to `/connect`).

**B3 Pairing (QR/deep link)**
- paste a `pi2://pair?host=…&port=…&code=…` link in the scan fallback → confirmation
  modal shows the masked token → confirm pairs; cancel changes nothing.
- the daemon's own `http://host:port/pair/<code>` URL is accepted by the parser.

**B4 Workspaces**
- seeded W1/W2 render as `[data-workspace-id]` rows, pinned/last-active order, context
  bar counts equal the API counts, no server selector.
- “Open new workspace” validates an empty path inline, then adds a real workspace via
  the API, shows a toast, and navigates into `/chat?workspace=<id>`.
- empty state and API-error + retry render without a white screen.

**B5 Chat: session tree**
- `/chat?workspace=W1` lists sessions from the API; a live session has a status dot;
  selecting a row navigates to `/chat/<sid>?workspace=W1`.
- “New session” creates a real session, routes to it, and the tree gains the row.
- rename persists through the plugin; close asks for confirmation and removes the row.
- the workspace selector switches trees (W1 → W2) without leaking rows.

**B6 Chat: prompt + streaming**
- send “Reply with exactly the word PONG and nothing else.” via Enter.
- exactly one user entry appears (sourced from the server), then an assistant entry
  grows while streaming and settles with exactly `PONG`; the composer send button
  returns from Abort to Send; status badge returns to idle; no console errors.
- Shift+Enter inserts a newline and does not send.

**B7 Chat: abort**
- start a slow prompt; while busy the send button is Abort; click it; within 10 s the
  status is idle, partial text remains, no further text arrives.

**B8 Chat: model/thinking**
- change the thinking select to `low` → API command sent, state/toast update, value
  survives a reload; change the model select → the same, and the tree subtitle updates.

**B9 Chat: panels (Subagents / Todo / Tasks)**
- panel tabs switch; each renders either real data or its empty state; no mock copy.
- Dispatch modal creates a real batch (`items[]`), the subagent row/batch appears, and
  the preview modal opens (real tail or an explicit empty state); “Back to parent” works.
- Tasks tab shows real tasks or the empty state; the task output modal shows the real
  output tail or an explicit unsupported state (no fake pid).

**B10 Attention**
- with a real diff request in flight, the blocking dialog appears with server-provided
  title/options; Accept writes the file; the dialog closes; a second client cannot answer.

**B11 Status**
- `/status` renders info/health/resources/models/tasks/devices/connection cards from the
  API; no server/workspace selector; resources refresh; health items show pass/fail.
- paired devices come from the API and can be revoked with confirmation; a revoked
  device token stops working.
- disconnect clears connection and returns to `/connect`.

**B12 Reconnect**
- take the browser offline (or restart the daemon) and restore it; the connection state
  indicator reflects reconnecting → open, history reloads/resyncs, and the composer is
  usable again; no duplicate entries.

**B13 Deep links**
- `/chat/<sid>?workspace=W1` and `/chat?workspace=W1` land on the intended
  workspace/session; an unknown session shows an error + retry, not a blank page.

**B14 i18n / theme**
- switch language via the topbar menu: `<html lang>` and visible copy change; switching
  back restores English; no missing-key placeholder.
- switch theme light/dark/system: `<html data-theme>` changes and persists.

### 4.3 C — Responsive / visual

- **C1** 1440×900, 768×1024, 380×780 on `/workspaces`, `/chat`, `/status`, `/connect`
  (unpaired): `documentElement.scrollWidth <= innerWidth + 1`; no element overflowing
  the viewport; screenshots saved to `$E2E_ROOT/screens/`.
- **C2** connect has no bottom tab bar; nav pages have exactly three navigation items at
  every breakpoint (tabbar <600, rail 600–839, sidebar ≥840).
- **C3** dark and light screenshots of each page are non-blank (>10 kB, >500 unique
  colors) and contain the page heading.
- **C4** no `pageerror` and no console `error` on any page load or interaction (allowlist
  only known-benign browser messages, recorded in the report).

## 5. Failure triage and fix ownership

For every failed assertion:

1. Record `scenario ID`, the exact command/UI step, observed vs expected, and the
   relevant daemon/instance/plugin log tail in `$E2E_ROOT/report/`.
2. Classify:
   - **harness bug** (flaky wait, wrong selector) → fix the harness, not the product.
   - **contract mismatch** (web sends a different shape than the plugin/daemon accepts)
     → align on the protocol shape; prefer fixing the web client when the plugin/daemon
     already matches `docs/protocol.md`.
   - **product bug** (state never emits, file written before consent, missing handler)
     → fix the owning layer.
3. Fix in one layer at a time, with exclusive file ownership per subagent; never let two
   agents edit the same file concurrently.
4. Re-run the failed scenario, then the full suite. Unit tests (`vitest` in the daemon repo and
   in `web/`) must stay green after every fix.
5. Do not mark a scenario PASS from a static grep or a screenshot alone; assert the
   observable behavior described above.

## 6. Report format

Both drivers write machine-readable + human-readable artifacts into `$E2E_ROOT/report/`:

| Suite | Files |
|---|---|
| API/WS | `report/api-results.json` (scenario, status, duration, checks, notes, evidence) and `report/summary.md` |
| Browser | `report/ui-e2e.json` and `report/ui-e2e.md`, screenshots in `screens/*.png` (`b10-no-attention.png` and per-failure shots included) |

`report/summary.md` (API) contains a per-scenario table, each failed assertion with
expected/observed, notes, an evidence block, a “Suspected product bugs” section built from
`DEVIATIONS`, and the daemon/plugin log tails. `ui-e2e.md` adds the seeded workspace ids,
the Playwright module/Chrome actually used, and one section per scenario with every
assertion. `ui-e2e.mjs` also copies its markdown to `/tmp/pi2-e2e-recon/e2e-ui-run.md`.

Logs live in `$E2E_ROOT/logs/`: `<suite>.log` (build output + driver stderr) and
`daemon.log` / `daemon.stdout` for the `pi2 daemon` process.

The summary must state which scenarios passed, which failed with observed vs expected,
which were skipped and why (non-blocking only), and the command that reproduces the run.

## 7. Commands

```bash
cd <repo>    # the pi2 CLI/daemon checkout (this repository)

# backend only (A0–A13): tsc, then `pi2 daemon` + headless nvim + real pi
bash scripts/e2e/run-api.sh

# browser (B1–B14, C1–C4): also builds web/dist (pnpm), then Playwright
bash scripts/e2e/run-ui.sh

# both, API first; exit 0 only when neither suite failed
bash scripts/e2e/run-all.sh
```

Both suites rebuild by default; when the build is already current:

```bash
E2E_SKIP_BUILD=1 bash scripts/e2e/run-api.sh
E2E_SKIP_BUILD=1 bash scripts/e2e/run-ui.sh
```

Artifacts: `$E2E_ROOT/{run,data,state,agent,workspaces,logs,screens,report}`. `E2E_KEEP=1`
keeps the temp root and prints its path; the default removes it after the report is written
(a failing suite forces `E2E_KEEP=1`).

Auxiliary scripts (not part of the gate): `scripts/e2e/full-e2e.sh` is the earlier single-run
smoke (daemon → headless nvim → pi → REST) that predates `lib.sh`, and
`scripts/e2e/visual.sh` only boots daemon + plugin and captures the four pages for design
review.

## 8. Non-goals (v1)

- Multi-server aggregation (single-server invariant; out of scope by contract).
- Golden-image pixel diffs (screenshots are artifacts + blank/overflow checks only).
- Load/backpressure benchmarks (P2; separate task).
- TUI ↔ browser live-sync timing (needs a GUI nvim; covered separately by the plugin's
  own e2e suites).
- Mobile camera scanning (no camera in CI; the paste fallback is tested instead).
