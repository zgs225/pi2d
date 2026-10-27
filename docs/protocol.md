# pi2 wire protocol (v1)

Single vocabulary, three surfaces. **The plugin inside nvim is the only authority for session state.**

```
browser  <──HTTP + WS/SSE──>  pi2 daemon  <──JSONL over unix socket──>  plugin (nvim)
```

- `pi2 daemon` never spawns `pi`, never parses session JSONL, never stores session state.
- The browser keeps a **render cache** only; a `snapshot` replaces it wholesale.
- One workspace maps to exactly one managed nvim instance.

## 1. Envelope

Every record is one JSON object per line (plugin↔daemon) or one WS message (browser↔daemon):

```jsonc
{
  "v": 1,
  "type": "hello | hello_ack | instance_state | workspace_update | subscribe | sub.subscribe | sub.unsubscribe
         | snapshot | event | cmd | ack | error | resync_required | presence | bye",
  "id": "req-…",                 // request/response correlation for cmd/ack
  "workspaceId": "ws-…",
  "sessionId": "…",
  "epoch": "instance-uuid",      // restart detection; seq is only valid within an epoch
  "seq": 42,                     // per session, monotonic, produced by the plugin
  "ts": 1733234400123,           // wall clock, produced by the plugin
  "mono": 918273,                // monotonic ms, produced by the plugin (durations)
  "origin": { "clientId": "…", "kind": "nvim|web|cli|daemon|system" },
  "payload": { … }
}
```

Rules:

- `seq` is **per session** and assigned by the plugin. The daemon never renumbers.
- `epoch` changes when the plugin process (re)starts or the session is re-opened by a different instance.
  A client holding a `(epoch, seq)` pair that no longer exists must `resync`.
- `ts`/`mono` are authoritative; browsers never compare clocks across hosts.

## 2. Plugin ↔ daemon

The plugin dials the daemon (`<runtime>/d.sock`), sends `hello` first.

```jsonc
// plugin → daemon
{"v":1,"type":"hello","instanceId":"i-…","workspaceId":"ws-…","cwd":"/repo","pid":1234,
 "hasUI":true,"listenAddr":"/run/user/1000/pi2/i/ab12.sock","pluginVersion":"1.8.0","capabilities":["snapshot","attention"]}

// daemon → plugin
{"v":1,"type":"hello_ack","daemonId":"d-…","limits":{"maxFrameBytes":8388608},"policy":{"attention":"all"}}

// plugin → daemon
{"v":1,"type":"instance_state","payload":{"status":"ready","sessions":[{"sessionId":"s1","status":"busy","name":"Refactor","tab":2,"model":{"provider":"anthropic","id":"claude-sonnet-4-5"}}]}}
{"v":1,"type":"snapshot","sessionId":"s1","epoch":"e1","seq":10,"payload":{"state":{ /* SessionState */ },"entries":[]}}
{"v":1,"type":"event","sessionId":"s1","epoch":"e1","seq":11,"ts":1733234400123,"payload":{"event":{ /* SessionEvent */ }}}
{"v":1,"type":"ack","id":"req-1","seq":12,"payload":{"disposition":"started"}}
{"v":1,"type":"error","id":"req-1","payload":{"code":"E_LEASE","message":"session is owned by instance i-2","retryable":false}}

// daemon → plugin
{"v":1,"type":"cmd","id":"req-1","sessionId":"s1","payload":{"method":"prompt.send","params":{"text":"hi"},"clientRequestId":"c-9"}}
{"v":1,"type":"sub.subscribe","sessionId":"s1"}
{"v":1,"type":"sub.unsubscribe","sessionId":"s1"}
{"v":1,"type":"instance.shutdown","payload":{"mode":"drain"}}
{"v":1,"type":"workspace.query","id":"req-2","payload":{"kind":"sessions"}}
// a session-scoped read keeps the sid on the envelope (see §3.1 entries)
{"v":1,"type":"workspace.query","id":"req-3","sessionId":"s1","payload":{"kind":"entries","limit":50}}
```

Plugin obligations:

- **Subscribe before prompt**: the daemon calls `sub.subscribe` before forwarding a command; the plugin
  answers every new subscription with a `snapshot` (state + a tail of entries).
- Throttle deltas: `text_delta`/`thinking_delta` coalesced to ≤30 fps (50 ms), `tool_execution_update` to 100 ms.
- Write-queue cap 4 MB per connection; on overflow drop low-priority events and emit one `dropped` marker.
- Reconnect forever with exponential backoff (200 ms → 5 s). Never exit because the daemon is down.

## 3. Browser ↔ daemon

### 3.1 REST (reads)

| Endpoint | Notes |
|---|---|
| `GET /api/v1/info` | `{v, daemonId, machineId, platform, hostname, os, version, uptimeMs, pid, port, capabilities, limits}` |
| `GET /api/v1/health` | `{ok, items:[{name, ok, detail}]}` |
| `GET /api/v1/workspaces` | `WorkspaceInfo[]` (registry + disk index + instance state) |
| `GET /api/v1/workspaces/:id/sessions` | relayed `workspace.query{kind:"sessions"}` (row fields below) |
| `GET /api/v1/sessions/:sid/entries?before=&limit=&workspaceId=&sessionFile=` | relayed `workspace.query{kind:"entries"}`; plugin paginates |
| `GET /api/v1/attention?workspaceId=` | pending attention for one workspace |
| `GET /api/v1/devices` | paired devices (daemon-owned; `{id, name, kind, createdAt, lastSeenAt, revokedAt}`) |
| `POST /api/v1/pair` | **authenticated**; mints `{code, url, expiresAt, nonce, qr, bases}` |
| `POST /api/v1/pair/redeem` | public + rate limited (`E_RATE_LIMITED`); `{code, kind, deviceName}` → `{token, device}` |
| `GET /pair/:code` | public; `302 /connect?code=<code>&auto=1` (scanned links) |
| `GET /api/v1/models?workspaceId=` | relayed to the instance |
| `GET /api/v1/resources` | instances, sessions, RSS totals for the soft-limit notice |
| `GET /api/v1/diagnostics` | connections, event rates, slow queries, instance table |

The entries read is the only query that is *about a session*. `workspaceId` from the
caller routes it (a disk-only row has no live owner); the `sid` always travels on the
record envelope, so the plugin resolves the session — and its file — from its own
registry. `sessionFile` is an optional fallback for a session the receiving instance
does not know. A session that exists but has no JSONL yet (`pi` creates the file with
the first entry) answers an **empty page** (`{entries:[], cursor:{hasMore:false}}`),
never an error: a new session has no history to fail on.

Workspace row (`GET /api/v1/workspaces`) — registry entry ∪ disk discovery ∪ live instance state. Every known workspace is returned; rows are never filtered, so `/workspace/<workspaceId>` deep links always resolve:

| Field | Notes |
|---|---|
| `workspaceId` | `sha256(realpath(cwd)).slice(0,16)` |
| `cwd`, `name`, `alias` | `name` falls back to `alias`, then `basename(cwd)` |
| `pinned`, `hidden`, `trusted` | persisted user intent from `workspaces.json` |
| `exists` | `false` = ghost (the cwd is gone; the session files are not) |
| `sessionCount`, `liveCount`, `lastActiveAt` | disk projection (`lastActiveAt` may be `null`) |
| `instance` | live `InstanceState` or `null` |
| `visibility?: "default" \| "secondary"` | derived, never persisted: the workspace-noise policy. Missing ⇒ `default` |
| `visibilityReason?` | `hidden` \| `ghost` \| `temp` \| `outside-roots` \| `stale`; absent for `default` rows |

The classification is advisory and client-side only (precedence, first match wins):

1. `hidden: true` → `secondary`/`hidden` — explicit user intent always wins, no rescue.
2. A live instance (`instance != null` or `liveCount > 0`), `pinned` or `trusted` → `default` (rescue).
3. `PI2_WORKSPACE_HIDE_TEMP=1` (default `1`) and `cwd` is under `$TMPDIR`, `/tmp`, `/var/tmp`, `/var/folders` or `/private/var/folders` → `secondary`/`temp`.
4. `PI2_WORKSPACE_HIDE_GHOSTS=1` (default `1`) and `exists === false` → `secondary`/`ghost`.
5. `PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS=1` (default `0`) and `cwd` is outside `PI2_WORKSPACE_ROOTS` → `secondary`/`outside-roots`.
6. `PI2_WORKSPACE_STALE_DAYS=<n>` (default `0` = off) and `lastActiveAt` older than `n` days → `secondary`/`stale` (`lastActiveAt: null` never counts).
7. Otherwise `default`.

A client that lets the user *choose* a workspace should list only `default` rows by
default; `secondary` rows belong behind a “show hidden” toggle. Lookups by
`workspaceId` must ignore `visibility` entirely.

Session row (`GET /api/v1/workspaces/:id/sessions`) — a subset of `SessionState` plus list metadata (`usage`, `flags`, `entries` and `attention` arrive via snapshot/events, not on this row):

| Field | Notes |
|---|---|
| `sessionId`, `sessionFile?`, `name?`, `cwd?`, `timestamp?`, `modified?`, `firstMessage?` | identity + disk projection |
| `tab?` | live projection of `Session.attached_tab`; present ⇒ this row is an nvim tab |
| `tabRank?` | live projection: 1-based visual position of `tab` in `nvim_list_tabpages()`; absent on plugins that predate it |
| `live?` | live projection: the session's `pi --mode rpc` process runs (a detached sub-session is live without a `tab`) |
| `status?` | live status when `live` (`busy`, `compacting`, `idle`, `exited`); otherwise the child's manifest status (`dormant`, `done`, `error`, `interrupted`, `exited`). Absent on a non-live root. |
| `model?`, `thinking?` | per-session model pin; the child's manifest thinking level |
| `visible: boolean` | always present; the plugin's `:PiSessions` visibility decision |
| `parentId?: string` | sub-session rows only: the parent session id (normally present in the same list) |
| `task?`, `agentSpawned?`, `reported?` | sub-session rows only, carried through from the spawn request |
| `createdAt?`, `lastActiveAt?` | epoch ms; optional ordering/aging hints — the console degrades gracefully when they are absent |

The console mirrors `:PiSessions` ordering: roots are ranked by `tabRank` (1-based visual position) and fall back to the `tab` handle (where handle order diverges after `:tabmove` or mid-tabline insertions), with a lineage placed at the earliest tab slot of the root and all its descendants. Tab-less roots are placed last (rank `+Infinity`); note that `:PiSessions` never renders a tab-less root at all, and the console retains one only when it serves as the parent row of a live child-view tab (or an orphan). Ties among roots are broken deterministically by `createdAt` desc, `lastActiveAt` desc, `sessionId` asc — this tie-break chain is a console-side determinism rule rather than `:PiSessions` behaviour. Siblings are ordered by `createdAt` desc then id asc (matching `manifest.lua`'s `created_at` desc + `_id` asc), with child session rows inheriting the same-id manifest entry's `createdAt`.

The list is a union of every session JSONL the workspace has on disk and its live
sessions, so a client must not assume every row is an nvim tab. A row carrying
`tab` is a tab; a tab-less root row is *history* — it has no live owner, and a
command routed to it answers `E_SESSION_NOT_FOUND`. A client that mirrors the
nvim session list renders the tab-backed component: the rows with a `tab` plus
every row linked to them through `parentId` in either direction (their
sub-sessions, and the parent row when a tab is in a child view). That approximates
`:PiSessions` (`Sessions.list()` plus children); pi2 web applies this filter in
`web/src/features/chat/session-state.ts` (`tabSessionRows`). Known gaps from nvim:
a history parent row with no live owner is kept; manifest-entry existence is not
consulted; and child ownership across a lineage with two live roots is decided by
`parentId` alone (nvim also uses `conversation_epoch`). A history row is a
`session.resume` target, never a prompt target.

Sub-session rows sit in the same flat list as their parent: build the tree from `parentId`
(an unknown `parentId`, or one whose row was pruned, promotes the row to a root so a row is
never lost). `status` of a non-live child is one of `dormant|done|error|interrupted|exited`;
a live child reports its live status.

Visibility follows the plugin's `:PiSessions` policy (`visible: false` = hidden), but the
field is advisory: a client may still render hidden rows on request (pi2 web's “show hidden
sub-sessions” toggle) or when the row is the routed/selected session. An active search filter
takes precedence over the routed row in pi2 web (a non-matching row stays out, even when it is
selected). A manifest `pi2:subagents` entry that also has a session row (same id) must render
as that row only — the session row wins. `pi2:subagents` entries may additionally carry
`parentId?`, `visible?`, `createdAt?`, `lastActiveAt?`.

### 3.2 Commands (writes)

`POST /api/v1/cmd` with `{method, params, sessionId?, clientRequestId?}` → `202 {accepted, disposition}`.

Routing:

| Method | Routed to |
|---|---|
| `instance.ensure`, `instance.shutdown`, `workspace.*`, `pair.*`, `device.revoke`, `system.*` | daemon |
| everything else (`session.*`, `prompt.*`, `queue.*`, `attention.*`, `subagent.*`, `task.*`) | plugin of the workspace that owns `sessionId` (or of `params.workspaceId` for `session.create`/`session.open`) |

Idempotency: `clientRequestId` is deduplicated for 5 minutes; replays return the original `ack`.

### 3.3 WS events

Client → server: `{"type":"subscribe","payload":{"workspaceId":"ws-1"}}` (workspace scope) or
`{"type":"subscribe","payload":{"sessionIds":["s1"]}}`; `{"type":"unsubscribe",...}`; `{"type":"ping"}`.

Server → client (same envelope as above): `hello_ack`, `instance_state`, `workspace_update`, `snapshot`,
`event`, `presence`, `resync_required`, `dropped`, `error`.

A session `subscribe` is answered with a `snapshot` as soon as the plugin's reply
arrives (the daemon waits briefly for the plugin's `sub.subscribe` snapshot and also
forwards every later plugin snapshot to current subscribers).

`GET /events` (SSE) emits the same `event` records for degraded transports.

## 4. Session state

```ts
interface SessionState {
  sessionId: string; workspaceId: string; cwd: string; name: string | null;
  status: "starting" | "busy" | "compacting" | "idle" | "exited" | "interrupted";
  flags: { attention: boolean; done: boolean; error: boolean };
  model: { provider: string; id: string } | null;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  contextUsage: { tokens: number; window: number; percent: number } | null;
  queue: { id: string; text: string; steer: boolean }[];
  todos: { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }[];
  tasks: { id: string; command: string; status: "running" | "completed" | "failed" | "stopped";
           startTime: number; durationMs?: number; exitCode?: number | null; outputFile?: string }[];
  batches: { batchId: string; status: "running" | "completed" | "partial" | "failed" | "cancelled";
             items: { ref: string; name?: string; status: string; error?: string }[];
             summary?: { total: number; done: number; ok: number; failed: number; cancelled: number; running: number } }[];
  subagents: { id: string; name?: string; status: "active" | "completed" | "failed" | "interrupted" | "dormant";
               model?: string; thinking?: string; task?: string; children?: unknown[];
               parentId?: string; visible?: boolean }[];
  attention: { requestId: string; method: string; title?: string; message?: string;
               options?: { id: string; label: string }[]; payload?: unknown; timeoutSec?: number;
               createdAt: number; receivedAt: number }[];
  entries: Entry[];

  // List metadata — enriched by the session list (`§3.1`) / snapshot from the
  // web client's cached row, never emitted by the reducer.
  parentId?: string | null;   // null = root (client-side only; the plugin omits the field)
  visible?: boolean;          // plugin `:PiSessions` visibility decision
  task?: string;              // subagent task description from the spawn request
  firstMessage?: string | null; // first user message of the session file (provisional title)
}

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "tool"; toolCallId: string; name: string; args?: unknown; output?: { text?: string; details?: unknown; isError?: boolean };
      state: "pending" | "running" | "done" | "error"; durationMs?: number }
  | { type: "error"; text: string };

interface Entry {
  id: string; role: "user" | "assistant" | "system" | "notice";
  ts: number; blocks: Block[]; done: boolean;
  messageId?: string; images?: { mimeType: string; data: string }[];
}
```

### 4.1 Reducer rules (canonical, `src/protocol/reducer.ts`)

| Event | Effect |
|---|---|
| `agent_start` | `status=busy`, `flags.done=false`, `flags.error=false` |
| `agent_settled{aborted}` | `status=idle` (unless exited/interrupted), `flags.done=!aborted`, `flags.error \|= aborted` |
| `compaction_start` / `compaction_end` | `status=compacting` / back to `idle` |
| `session_info_changed{name}` | `name = name ?? null` |
| `thinking_level_changed{level}` | `thinking = level` |
| `queue_update{steering,followUp}` | `queue = [{id:"q:steer:N",steer:true}, {id:"q:follow:N",steer:false}]` |
| `message_start{message}` | user/assistant entry created (`m1`, `m2`, …), blocks from `content`, `done=false` |
| `message_update{assistantMessageEvent}` | text/thinking deltas by `contentIndex`; `toolcall_*` creates/updates a tool block; `error` appends an error block |
| `tool_execution_start/update/end` | updates the tool block by `toolCallId` (`running` → `done|error`, `output`, `durationMs`) |
| `message_end{message}` | replaces the entry blocks with authoritative content (tool blocks keep execution state), `done=true`, assistant `usage` is **accumulated** into session totals (`cost.total` → `usage.cost`) |
| `pi2:session{session}` | shallow patch of `status/name/model/thinking/usage/contextUsage/flags` |
| `pi2:todo{todos}` | replaces `todos` |
| `pi2:batch{batchId,status,items,summary}` | upserts into `batches` |
| `pi2:task{task}` | upserts into `tasks` by `id` |
| `pi2:subagents{subagents}` | replaces `subagents` |
| `pi2:attention_request{…}` | upserts into `attention`, `flags.attention=true` |
| `pi2:attention_resolved{requestId}` | removes from `attention`, `flags.attention = attention.length>0` |
| `pi2:process_exit{code}` | `status = code===0 ? exited : interrupted`, `flags.done=true` |
| `pi2:error{message}` | appends an error block, `flags.error=true` |

Fixtures: `fixtures/<case>/events.jsonl` + `expected.json` (generated by `pnpm tsx scripts/gen-expected.ts`,
reviewed, committed). Both the TypeScript and Lua reducers must reproduce `expected.json` byte-for-byte.

## 5. Routing and lifecycle

```
browser cmd(sessionId=s1)
  └─ daemon: find session owner
        ├─ known session → instance of that workspace → relay
        ├─ unknown → resolve workspace from session file → ensure instance (spawn if needed) → relay
        └─ instance missing/degraded → start it (once), else 503 E_INSTANCE_UNAVAILABLE
```

- `instance.ensure{workspaceId}` is idempotent and returns the current `instance_state`.
- The daemon enforces **one managed instance per workspace**; a second nvim for the same cwd is reported
  as `unmanaged` and never receives browser commands.
- Instances are never stopped automatically. Only `instance.shutdown` (user action, confirm in UI) stops one.
- On disconnect the daemon marks the instance `degraded`; sessions become `interrupted` when the instance
  reports process exit, or when the instance is restarted (epoch change).

## 6. Attention

- `pi2:attention_request` is broadcast to **every** client subscribed to that session and to the
  workspace inbox. The local nvim dialog is shown only when `#nvim_list_uis() > 0`.
- The first successful `attention.respond` wins; the plugin emits `pi2:attention_resolved{requestId,by,response}`.
  Everyone else closes and shows "resolved by <client>".
- A second response returns `E_ATTENTION_RESOLVED`.
- Requests without a pi-level timeout are cancelled by the plugin after 120 s (`cancelled`).

## 7. Errors

| Code | HTTP | Meaning |
|---|---|---|
| `E_BAD_REQUEST` | 400 | malformed JSON / missing field |
| `E_UNAUTHORIZED` | 401 | missing/invalid device token |
| `E_FORBIDDEN` | 403 | bad `Origin`, cwd outside `PI2_WORKSPACE_ROOTS` |
| `E_RATE_LIMITED` | 429 | too many pairing attempts (per client and globally) |
| `E_NOT_FOUND` | 404 | unknown workspace/session/instance |
| `E_PROTOCOL_VERSION` | 426 | `v` unsupported |
| `E_PAYLOAD_TOO_LARGE` | 413 | body/frame > limits |
| `E_RATE_LIMITED` | 429 | per-IP or per-room limit |
| `E_INSTANCE_STARTING` | 409 (retryable) | instance is booting |
| `E_INSTANCE_UNAVAILABLE` | 503 (retryable) | no instance and spawn failed |
| `E_INSTANCE_UNMANAGED` | 409 | workspace served by an unmanaged nvim |
| `E_LEASE` | 409 | session owned by another instance |
| `E_EXTERNAL_SESSION` | 409 | session written by a process outside pi2 |
| `E_SESSION_NOT_FOUND` | 404 | |
| `E_ATTENTION_RESOLVED` | 409 | already answered elsewhere |
| `E_UNSUPPORTED` | 501 | capability missing |
| `E_INTERNAL` | 500 | |

`message` is English/debug only; the browser maps `code` to localized text.
