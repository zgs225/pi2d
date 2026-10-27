# Web UI visual parity harness

The visual gate for the pi2-web-ui-design v0.1.1 port (PLAN §3.3). Two scripts,
no new dependencies, no daemon and no `pi`:

```
scripts/ui-mock-server.mjs   zero-dependency mock of the daemon's browser surface
scripts/ui-shots.mjs         Playwright screenshot + assertion matrix
scripts/ui-fixtures.mjs      the fixture data both of them share
```

The mock answers the exact REST + WS contract the console speaks (`web/src/lib/api.ts`,
`web/src/lib/ws.ts`); the shooter drives the **built** console the way a user would,
then asserts the invariants a screenshot cannot show. Nothing here patches product
code: a red assertion is a finding, not something this harness may fix.

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| `web/dist/index.html` | the shooter serves the production bundle | `pnpm --dir web build` |
| Node ≥ 22 | `node:http`, `crypto`, `fetch` | `node -v` |
| Playwright **resolvable** (not a dependency) | browser driver, resolved like `scripts/e2e/ui-e2e.mjs` | `node -e "require('playwright')"` or a mise npm-global install |
| Chromium | headless browser | `/usr/bin/google-chrome-stable`, else Playwright's bundled build |

Playwright is resolved from `PI2_SHOTS_PLAYWRIGHT_MODULE`, `PI2_E2E_PLAYWRIGHT_MODULE`,
`require("playwright")`, then the mise `npm-playwright` install roots. Chrome comes from
`PI2_SHOTS_CHROME` / `PI2_E2E_CHROME` / the distro paths. Neither is added to
`package.json` — the harness must not change what the daemon ships.

## 2. Usage

```bash
# 1. build the UI you want to inspect
pnpm --dir web build

# 2. full matrix: 4 pages × 3 viewports × light/dark = 24 PNGs + report.json
node scripts/ui-shots.mjs --serve-static --round r1 --out /tmp/pi2d-port/shots/r1

# 3. quick matrix: 1440×900 × light/dark = 8 PNGs (fast loop while iterating)
node scripts/ui-shots.mjs --serve-static --matrix=quick --round scratch

# 4. shoot an already running daemon instead of the mock (real data, real auth)
node scripts/ui-shots.mjs --base http://127.0.0.1:7676 --round live
```

| Flag | Default | Meaning |
|---|---|---|
| `--serve-static` | off | spawn the mock daemon and serve `web/dist` from it |
| `--base <url>` | — | shoot a running daemon; disables spawning and the unpaired check |
| `--out <dir>` | `/tmp/pi2d-port/shots/<round>` | where PNGs and `report.json` go |
| `--round <label>` | `adhoc` | label stored in the report (and the default out dir) |
| `--matrix full\|quick` | `full` | 24 or 8 shots |
| `--static-dir <dir>` | `web/dist` | build output to serve |
| `--timeout <ms>` | `12000` | per-shot settle budget |

Exit codes: `0` every assertion passed, `1` at least one assertion failed (details on
stdout and in `report.json`), `2` the harness could not start (missing build, missing
Playwright/Chrome, mock server never reached `READY`).

### The mock server on its own

```bash
node scripts/ui-mock-server.mjs                  # API + WS, ephemeral port
node scripts/ui-mock-server.mjs --static auto    # also serve web/dist
node scripts/ui-mock-server.mjs --pair-only      # every auth → 401 (unpaired branch)
node scripts/ui-mock-server.mjs --log            # request log on stderr
```

It prints `READY <port>` on stdout once listening, accepts the fixture device tokens
only (`scripts/ui-fixtures.mjs`), and refuses `POST /api/v1/console/session` unless the
caller is loopback **and** presents the fixture CLI token — the same rule the real
daemon enforces (`src/daemon/http.ts`).

## 3. Matrix

| Page | Route | Why it is in the gate |
|---|---|---|
| `workspaces` | `/workspaces` | Quiet Workbench head/status line/card grid + the single "new workspace" primary |
| `chat` | `/chat/s-main?workspace=ws-main` | two-column tree + stream, tool families, queued messages, telemetry |
| `status` | `/status` | metric tiles, devices, tasks, models (zero primary) |
| `connect` | `/connect` | paired summary branch, no navigation chrome |

Viewports: `380×780` (mobile, no bottom bar), `1024×768` (single column), `1440×900`
(two column). Themes: `light`, `dark` (seeded `pi2-theme` + emulated `color-scheme`).
File names: `<page>-<w>x<h>-<theme>.png`.

Each shot gets a **fresh browser context**: its own storage (`pi2-connection=paired`,
device token, scopes, theme, `pi2-lang=en`), its own console log. Real pairing is not
replayed — pairing/redemption is covered by `web/tests/connect-page.test.tsx` and
`scripts/e2e/ui-e2e.mjs`; the unpaired **branch** is covered here (§5).

## 4. Assertions

Per shot, all must pass:

| Assertion | Expected | Meaning |
|---|---|---|
| `page-loaded` | `>60` chars of `#root` text | the shell actually rendered (blank screen / crash catcher) |
| `route` | page's own path | no redirect, not even the `/connect` guard |
| `paired` | `data-paired="true"` | the seeded connection survived boot (no silent sign-out) |
| `theme` | `data-theme="<theme>"` | the theme seed reached `next-themes` |
| `console-errors` | `0` | `console.error` volume; React/renderer exceptions land here |
| `page-errors` | `0` | uncaught exceptions (`pageerror`) |
| `api-errors` | `0` | no `/api/v1/*` response ≥ 400 — the fixture contract is complete |
| `no-horizontal-overflow` | `scrollWidth ≤ clientWidth + 1` | no sideways scroll; the report lists the overflowing elements |
| `no-tabbar` | `0 × .tabbar` | CHG-04/08: the bottom bar is gone, replaced by the rail + page pill |
| `no-unexpected-modal` | `0 × .modal-backdrop` | the shot shows the page, not a dialog. Pending attention deliberately hangs off `s-attention`, not the session the matrix opens, because the attention modal is blocking and Escape-proof |
| `connect-no-page-pill` / `connect-no-nav-item` | `0` each | `/connect` has no navigation chrome at all |
| `primary-count` | workspaces `1`, status `0`, connect `1` | one primary action per screen at most |

`chat` has no fixed primary budget (composer actions), so its count is reported but not
asserted. `.dot` (status dot) counts are reported; fewer than 3 dots on `chat`/`status`
is recorded as a **note** rather than a failure (PLAN §3.3 wants ≥3, but the tree can be
collapsed at 380 px, which legitimately hides rows).

## 5. The unpaired branch (`--serve-static`)

With `--serve-static` the harness also starts a second mock in `--pair-only` mode and,
in one storage-free context at `1440×900`/dark, asserts:

| Assertion | Expected |
|---|---|
| `unpaired-redirects-to-connect` | `/workspaces` lands on `/connect` |
| `unpaired-no-page-pill` / `unpaired-no-nav-item` / `unpaired-no-tabbar` | `0` each |
| `unpaired-connect-primary` | `1` (scan-to-pair is the only primary) |
| `unpaired-not-paired` | `data-paired="false"` |
| `unpaired-renders` | `>60` chars of app text |
| `unpaired-console-errors` | `0` — a refused `/api/v1/*` is expected, a console error is not |

The unpaired check produces **no PNG** (it would break the "one file per matrix cell"
rule); its metrics live in `checks[]` of the report.

## 6. Reading a failure

```
FAILURES
  workspaces-380x780-dark.png · no-horizontal-overflow
    expected: "380px"
    observed: {"scrollWidth":412,"offenders":["div.ws-grid [0→412]"]}
```

- Work top-down: `page-loaded`/`route` failures invalidate the rest of that shot —
  usually a mock/contract problem (check `api-errors`, then the mock server's `--log`).
- `console-errors` with `api-errors` set means a fixture answer no longer matches
  `web/src/lib/api.ts`; fix the **mock**, not the UI.
- `no-tabbar` / `primary-count` / `connect-no-*` are parity regressions: report them to
  the owning workstream (PLAN §2). The harness never edits `web/src/**`.
- `theme` failing means the seed is wrong (`pi2-theme`), not the tokens.
- Numbers that only fail at one viewport are real responsive bugs; reproduce with
  `--matrix=quick` first (desktop only) to rule out the seed.

`<out>/report.json` carries, per shot: page, viewport, theme, PNG path + bytes, the full
metrics object (route, title, `data-theme`, `data-ws-state`, text head, counts including
`.modal-backdrop`, scrollWidth/clientWidth) and every check with expected/observed. It also
records the bundle that was shot (`build.assets` + `index.html` mtime) — if another
workstream rebuilds `web/dist` mid-run the harness notes the hash change, because a
half-written dist can 503 a shot.

## 7. Endpoint coverage

Everything the console calls is answered from `scripts/ui-fixtures.mjs`:

| Endpoint | Fixture | Notes |
|---|---|---|
| `GET /api/v1/info`, `GET /api/v1/health` | `info`, `health` | public on loopback, real `port` injected |
| `POST /api/v1/console/session` | `MOCK_CLI_TOKEN`, `MOCK_DEVICE_TOKEN` | loopback + CLI token only; 403/401 otherwise |
| `POST /api/v1/pair` | `pairCode` | redeem (`{code}` → token+device) and mint (`{accepted,code,url,…}`) |
| `GET /api/v1/workspaces` | `workspaces` | 6 rows covering staged/hidden/ghost/tmp/degraded/untrusted |
| `GET /api/v1/workspaces/:id/sessions` | `sessions` | `{v,sessions,cursor}`; 6 sessions incl. child, attention, legacy, idle |
| `GET /api/v1/sessions/:sid/entries` | `entriesBySession` | raw pi entries, `before`/`limit` paging with a cursor |
| `GET /api/v1/attention` | `attentionByWorkspace` | flattened per workspace |
| `GET /api/v1/models` | `modelProviders` | `{providers:[…]}`, 3 providers |
| `GET /api/v1/devices` | `devices` | **bare array** (daemon shape), includes a revoked row |
| `DELETE /api/v1/devices/:id` | `devices` | 204, 404 for unknown ids |
| `GET /api/v1/resources` | `resources` | instances + RSS + physical memory |
| `GET /api/v1/diagnostics` | `diagnostics` | counters only |
| `POST /api/v1/cmd` | — | `{accepted:true,disposition:"mock"}`; no command is executed |
| `GET /ws` | `sessions` + `entriesBySession` | handshake, `auth`→`hello_ack`, `subscribe`→`snapshot{state,entries}`, `ping`→`pong` |

Two harness-only extras exist to make fixtures auditable: `GET /api/v1/sessions/:sid/queue`
and `…/tasks`. The daemon has **no** such routes — queue/tasks ride inside the session
state (`/sessions`) and the WS snapshot — so no web code calls them.

## 8. Known limits

- **No runtime.** Commands are acked and dropped; nothing streams, nothing re-renders
  from a live event. Streaming animations, `queue_update` transitions and attention
  answers are out of scope here (they belong to `scripts/e2e/ui-e2e.mjs`, which runs a
  real `pi` + nvim).
- **Snapshot-only WS.** `subscribe` answers one snapshot per session; no `event` frames,
  so "live" states are whatever the fixtures say. `--pair-only` refuses the upgrade
  entirely, which is what keeps the unpaired check honest.
- **No contrast sampling.** PLAN §3.3 asks for a ≥4.5 contrast sample and a
  `prefers-reduced-motion` sweep; neither is implemented yet (theme/value drift is
  pinned by `web/tests/tokens.test.ts` instead). Tracked as a gap.
- **Viewport screenshots** (`fullPage:false`): long pages are cropped by design, so the
  PNGs match the file-name dimensions; scrollable content is not proof-read.
- **Node 22's canvas** is whatever `next-themes` + Tailwind produce in Chromium; font
  substitution differs from macOS/Safari. Do not compare pixel-perfectly across hosts.
- **Stale data is intentional**: fixtures freeze `now` at mock start, so relative-times
  texts drift slowly across a long run (`--now <ms>` pins them exactly).
- **Concurrent builds**: `--serve-static` reads `web/dist` on every request, so running the
  matrix while another workstream runs `vite build` can 503 a shot (the asset/index files
  are momentarily missing). The report records the bundle hash; re-run once the build
  settles.
- **Fake IDs only.** No real workspace paths, tokens or machine ids are read; nothing
  under `~` is touched and no port is fixed (always `0`).

## 9. v0.1.1 移植映射（CHG → 落点）

上游 `pi2-web-ui-design` 的 20 条变更在 React 里的落点。契约细节见 `/tmp/pi2d-port/digests/01..05-*.md`
（抽取自原型源码，逐条带 `文件:行号`；该目录是过程产物，不在仓库内）。

| CHG | 落点 |
|---|---|
| 01 Quiet Workbench（外壳/Workspaces/Status/Connect） | `styles/tokens.css`、`styles/app.css`、`pages/{workspaces,status,connect}.tsx`、`features/workspaces/**`、`features/status/**`、`features/connect/**` |
| 02 Chat IA v3（单 workspace 树 / 子会话嵌套 / tray 取代右 panel） | `features/chat/{session-tree,session-tray,workspace-switch}.tsx`、`layout.tsx`、`store.ts` |
| 03 变更记录机制 | 上游仓库机制，不迁移 |
| 04 56px 单图标导航条 | `components/shared/nav-list.tsx` + `styles/app.css`（`.nav-item` 44×44、`has-tip`） |
| 05/06/09 工具族渲染 + 回归修复 | `features/chat/tools/**`、`styles/tool-*.css`、`features/chat/blocks.tsx` |
| 07/08 记录加固与数值修正 | 上游，不迁移（数值体现在 token 与断点） |
| 10 控件清理（ctx 环入状态行、删执行模式、树固定） | `features/chat/telemetry.tsx`、`layout.tsx`、`session-tree.tsx` |
| 11/12 Session / Subsession 单行 | `session-tree.tsx`（`.tree-row__main` + `.t-atten`，无副行/徽标） |
| 13 Session 行 body 级 popover | `features/chat/session-row-menu.tsx`（`createPortal` → `document.body`，`role=menu`） |
| 14 用户消息右对齐 | `blocks.tsx` + `styles/pages/chat-msg.css`（2px 右 rail；error 保持左 rail） |
| 15 active 图标重点色实底、去左竖条 | `styles/app.css`（`.nav-item.active`） |
| 16 待发送消息单一实体 + composer 状态条 | `features/chat/queued-messages.tsx`、`message-stream.tsx`、`composer.tsx` |
| 17 子代理筛选/派发移入行 popover | `session-row-menu.tsx` + `session-tree.tsx`（树顶只留搜索/新建/折叠） |
| 18 子代理视图与主会话同构 | `features/chat/subagent-view.tsx`（`?sub=` 深链、合成时间线） |
| 19 子代理状态线并入 telemetry | `telemetry.tsx`（`.telemetry--sub`，标题只留身份） |
| 20 移动端顶栏胶囊 + 页面 sheet、删除底栏 | `components/shared/{page-pill,page-sheet}.tsx`、`app.css`；`.tabbar` 与 `--tabbar-h` 已删除 |

### 9.1 与原型的有意偏差（数据模型所致）

| 原型 | pi2d 现实 | 我们的处理 |
|---|---|---|
| queued 消息是消息流里的 message，有 ts/发送中态 | `session.queue: QueueItem[]` 由 `queue_update` 投影，无 ts | 消息流尾部渲染 synthetic `.msg--queued`；`sending` 作为其变体；composer 只留 `role=status` 状态条 |
| 每条 queued 独立的 steer 开关 | `queue.setSteer` 是会话级 mode | 只显示会话级开关与说明，不做 per-item toggle |
| 子代理有独立 entries / todos / tasks | 只有 manifest + 父会话 entries | child view 用 `subagent.task` + 命中该代理的工具块/notice 合成只读时间线；tray 显示会话级数据并显式标注作用域 |
| `visible:false` 隐藏与 IA「只看活跃」是两个维度 | 同 | `activeOnly`（默认开，`pi2-active-only`）与 `showHidden` 分开 |
| 工具块 DTO `input/text/result/diff` | `{toolCallId,name,args,output,state,durationMs}` | `tools/adapt.ts` 单一适配层，保留旧字段降级 |

### 9.2 断点

外壳：`<600` 顶栏胶囊 + sheet，`600–839` 图标 rail，`≥840` 图标 sidebar（均为 56px）。
Chat：`≥1100` 树 280px + 流，`1000–1099` 树 240px，`<1000` 单栏 + 树抽屉。阅读列 `--reading-max: 52rem`。

### 9.3 已知缺口

- `scripts/e2e/ui-e2e.mjs` 需要真 `pi` + nvim 才能跑；本轮只做了选择器适配，未在该环境回归。
- 对比度抽样与 `prefers-reduced-motion` 扫描仍未自动化（§8）。
- `chat.css` 已清理 v0.1.0 残留（`.tool` 卡片、`.diff` review、队列 chips、stream 固定 68rem/16px 间距、
  连接 chip/右 panel 按钮等），样式所有权现在唯一：`tool-*.css` 管工具、`chat-msg.css` 管消息块、
  `chat-stream.css` 管阅读列与间距、`chat-composer.css` 管状态条、`chat-tray.css` 管 tray/chips、
  `chat-telemetry.css` 管状态行。旧代码仍留 `side-panel.tsx`（未被引用，可单独删除）。
