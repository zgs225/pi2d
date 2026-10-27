/**
 * Fixture data for the web-console visual harness (`scripts/ui-mock-server.mjs`
 * + `scripts/ui-shots.mjs`).
 *
 * Shapes are taken from `web/src/lib/api.ts` and `src/protocol/types.ts` — the
 * wire contract, not a UI model. Two families deliberately coexist:
 *
 *   - REST history entries are **raw pi entries** (`message` / `toolResult` /
 *     `custom`), which `web/src/lib/entry-projection.ts` projects. That is the
 *     real `GET /api/v1/sessions/:sid/entries` payload.
 *   - `state.entries` (only used by the legacy session) carries **Block-shaped**
 *     entries, including the pre-0.2 tool DTO (`input` / `result` / `text` /
 *     `diff`) that `tools/adapt.ts` has to keep working.
 *
 * Nothing here talks to a daemon, a plugin or the network.
 */

/** Local CLI token the mock accepts for `POST /api/v1/console/session`. */
export const MOCK_CLI_TOKEN = "mock-cli-token-0000000000000000000000";
/** Device token the mock mints for the local browser (base64url-ish, ≥20 chars). */
export const MOCK_DEVICE_TOKEN = "mock-device-token-0000000000000000000000";
/** Second device token (a phone that paired earlier). */
export const MOCK_PHONE_TOKEN = "mock-phone-token-11111111111111111111111";

export const MOCK_DAEMON_ID = "d-mock-0f3a9c";

const MINUTE = 60_000;

/**
 * 21×21 module grid for the mock pairing code (`rows` are `"0"`/`"1"` strings,
 * no quiet zone). This is **not** a real QR encoding — the daemon's encoder
 * lives in `src/core/qr.ts`; the harness only needs a plausible grid with the
 * three finder patterns so the status page renders a real matrix.
 */
function mockQrRows(text, size = 21) {
    const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => "0"));
    const finder = (ox, oy) => {
        for (let y = 0; y < 7; y += 1) {
            for (let x = 0; x < 7; x += 1) {
                const ring = x === 0 || y === 0 || x === 6 || y === 6;
                const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
                grid[oy + y][ox + x] = ring || core ? "1" : "0";
            }
        }
    };
    finder(0, 0);
    finder(size - 7, 0);
    finder(0, size - 7);

    let state = 2166136261;
    for (const char of text) state = (state * 31 + char.charCodeAt(0)) >>> 0;
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const inFinder = (x < 8 && y < 8) || (x > size - 9 && y < 8) || (x < 8 && y > size - 9);
            if (inFinder) continue;
            state = (state * 1103515245 + 12345) >>> 0;
            grid[y][x] = state % 100 < 48 ? "1" : "0";
        }
    }
    return grid.map((row) => row.join(""));
}

/** Fixed "now" for the running instance; callers may override. */
export function buildFixtures(now = Date.now()) {
    const iso = (ts) => new Date(ts).toISOString();
    const t0 = now - 42 * MINUTE;

    /* ---------------------------------------------------------------- */
    /* raw pi entries: helpers                                           */
    /* ---------------------------------------------------------------- */

    const userEntry = (id, ts, text) => ({
        type: "message",
        id,
        timestamp: iso(ts),
        message: { role: "user", timestamp: ts, content: [{ type: "text", text }] },
    });

    const assistantEntry = (id, ts, content, extra = {}) => ({
        type: "message",
        id,
        timestamp: iso(ts),
        message: { role: "assistant", timestamp: ts, content, ...extra },
    });

    const toolCall = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });

    const toolResult = (id, ts, { toolCallId, toolName, text, isError = false, details }) => ({
        type: "message",
        id,
        timestamp: iso(ts),
        message: {
            role: "toolResult",
            toolCallId,
            toolName,
            timestamp: ts,
            content: [{ type: "text", text }],
            isError,
            ...(details !== undefined ? { details } : {}),
        },
    });

    const todoCheckpoint = (id, ts, todos) => ({
        type: "custom",
        id,
        timestamp: iso(ts),
        customType: "pi2-todo",
        data: {
            todos,
            completed: todos.filter((todo) => todo.status === "completed").length,
            total: todos.length,
        },
    });

    /* ---------------------------------------------------------------- */
    /* todo / task / batch / subagent state                              */
    /* ---------------------------------------------------------------- */

    const MAIN_TODOS = [
        { content: "Port v0.1.1 tokens (light/dark)", status: "completed", activeForm: "Porting tokens" },
        { content: "Replace .tabbar with the 56px nav rail", status: "in_progress", activeForm: "Replacing .tabbar" },
        { content: "Tool family renderer for 22 tools", status: "in_progress", activeForm: "Rendering tool families" },
        { content: "Visual harness: mock API + screenshots", status: "pending", activeForm: "Building the visual harness" },
    ];

    const MAIN_TASKS = [
        {
            id: "task-1",
            command: "pnpm --dir web build",
            status: "running",
            startTime: now - 38_000,
            durationMs: 38_000,
            exitCode: null,
            outputFile: "/tmp/pi2-mock/tasks/task-1.log",
        },
        {
            id: "task-2",
            command: "bash scripts/smoke.sh",
            status: "completed",
            startTime: now - 9 * MINUTE,
            durationMs: 41_200,
            exitCode: 0,
            outputFile: "/tmp/pi2-mock/tasks/task-2.log",
        },
        {
            id: "task-3",
            command: "pnpm --dir web exec vitest run tests/tools.kind.test.tsx",
            status: "failed",
            startTime: now - 21 * MINUTE,
            durationMs: 7_640,
            exitCode: 1,
        },
    ];

    const MAIN_BATCHES = [
        {
            batchId: "batch-1",
            status: "running",
            items: [
                { ref: "sa-shell", name: "WS-A shell", status: "running" },
                { ref: "sa-workspaces", name: "WS-B pages", status: "ok" },
                { ref: "sa-tools", name: "WS-C tools", status: "failed", error: "typecheck: 2 errors" },
                { ref: "sa-stream", name: "WS-E stream", status: "queued" },
            ],
            summary: { total: 4, done: 2, ok: 1, failed: 1, cancelled: 0, running: 1 },
        },
        {
            batchId: "batch-0",
            status: "partial",
            items: [
                { ref: "sa-audit", name: "contract audit", status: "ok" },
                { ref: "sa-digest", name: "digest pass", status: "cancelled" },
            ],
            summary: { total: 2, done: 2, ok: 1, failed: 0, cancelled: 1, running: 0 },
        },
    ];

    const MAIN_SUBAGENTS = [
        {
            id: "sa-shell",
            name: "WS-A shell",
            status: "active",
            model: "claude-sonnet-4.5",
            thinking: "high",
            task: "Rewrite tokens + nav rail, drop .tabbar",
            createdAt: t0 + 2 * MINUTE,
            lastActiveAt: now - 12_000,
            live: true,
            visible: true,
            parentId: "s-main",
            children: [
                {
                    id: "sa-tokens",
                    name: "tokens.css",
                    status: "completed",
                    model: "claude-sonnet-4.5",
                    task: "Swap the three-stage token set",
                    createdAt: t0 + 3 * MINUTE,
                    lastActiveAt: now - 14 * MINUTE,
                    visible: true,
                },
                {
                    id: "sa-palette",
                    name: "⌘K palette",
                    status: "failed",
                    model: "claude-sonnet-4.5",
                    task: "Esc must restore focus to the trigger",
                    createdAt: t0 + 5 * MINUTE,
                    lastActiveAt: now - 8 * MINUTE,
                    visible: true,
                },
            ],
        },
        {
            id: "sa-tools",
            name: "WS-C tools",
            status: "dormant",
            model: "gpt-5.1-codex",
            thinking: "medium",
            task: "22 tool names → 4 display states",
            createdAt: t0 + 9 * MINUTE,
            lastActiveAt: now - 6 * MINUTE,
            live: false,
            visible: false,
            parentId: "s-main",
        },
        {
            id: "sa-stream",
            name: "WS-E stream",
            status: "interrupted",
            task: "queued messages render once",
            createdAt: t0 + 12 * MINUTE,
            lastActiveAt: now - 3 * MINUTE,
            visible: true,
        },
    ];

    /**
     * Pending `confirm` attention. It hangs off `s-attention` (never the session
     * the screenshot matrix opens) because the console's attention modal is
     * blocking by design: putting it on `s-main` would hide the chat page behind
     * a dialog that only an answer or a timeout can close.
     */
    const MAIN_ATTENTION = [
        {
            requestId: "att-1",
            method: "confirm",
            title: "Allow `write` to docs/ui-parity.md?",
            message: "The agent wants to create the harness documentation inside the repo.",
            options: [
                { id: "allow_once", label: "Allow once" },
                { id: "allow_session", label: "Allow for this session" },
                { id: "deny", label: "Deny" },
            ],
            createdAt: now - 40_000,
            receivedAt: now - 39_500,
            timeoutSec: 120,
        },
    ];

    const MAIN_QUEUE = [
        { id: "q-1", text: "Also assert the /connect page has no server chip.", steer: false },
        { id: "q-2", text: "Re-run the matrix once WS-A lands.", steer: true },
    ];

    /* ---------------------------------------------------------------- */
    /* history: the main session                                         */
    /* ---------------------------------------------------------------- */

    const mainEntries = [
        userEntry("e-01", t0, "Port the v0.1.1 shell. Do not touch the wire protocol, and keep the old DTO working."),
        assistantEntry("e-02", t0 + 20_000, [
            {
                type: "thinking",
                thinking:
                    "Three invariants decide this: the protocol stays put, tools degrade on old fields, and the nav rail replaces .tabbar below 600px.",
            },
            {
                type: "text",
                text: "Plan: tokens first, then the shell, then the tool families. I re-read `docs/protocol.md` §3.3 before touching anything.",
            },
            toolCall("call-bash-1", "bash", {
                command: "pnpm --dir web typecheck",
                description: "baseline typecheck",
                timeout: 120_000,
            }),
        ]),
        toolResult("e-03", t0 + 26_000, {
            toolCallId: "call-bash-1",
            toolName: "bash",
            text: "> tsc --noEmit\n\n(no output)\nexit 0",
            details: { exitCode: 0, durationMs: 5_420 },
        }),
        assistantEntry("e-04", t0 + 30_000, [
            {
                type: "text",
                text: "Baseline is green. Now the token swap — the shorthand names stay, only the values move.",
            },
            toolCall("call-edit-1", "edit", {
                path: "web/src/styles/tokens.css",
                oldText: "  --tabbar-h: 3.75rem;\n  --topbar-h: 3.25rem;",
                newText: "  --topbar-h: 3.25rem;\n  --rail-w: 3.5rem;",
            }),
        ]),
        toolResult("e-05", t0 + 31_500, {
            toolCallId: "call-edit-1",
            toolName: "edit",
            text: "Applied 1 edit to web/src/styles/tokens.css",
            details: { path: "web/src/styles/tokens.css", additions: 1, deletions: 1 },
        }),
        assistantEntry("e-06", t0 + 40_000, [
            {
                type: "text",
                text: "Removing the tabbar variable breaks three rules; let me find every consumer.",
            },
            toolCall("call-grep-1", "grep", {
                pattern: "tabbar",
                path: "web/src",
                ignoreCase: true,
            }),
        ]),
        toolResult("e-07", t0 + 41_000, {
            toolCallId: "call-grep-1",
            toolName: "grep",
            text: [
                "web/src/styles/app.css:106  /* tabbar <600 */",
                "web/src/styles/app.css:107  .tabbar {",
                "web/src/styles/app.css:131  .main { padding-bottom: calc(var(--tabbar-h) + var(--space-6)); }",
                "web/src/styles/pages/chat.css:1079  height: calc(100dvh - var(--topbar-h) - var(--tabbar-h));",
                "web/src/components/app-shell.tsx:251  <nav className=\"tabbar\">",
            ].join("\n"),
            details: { matches: 5, files: 3 },
        }),
        assistantEntry("e-08", t0 + 50_000, [
            {
                type: "text",
                text: "Checking whether the prototype published a nav-rail spec before I invent one.",
            },
            toolCall("call-search-1", "web_search", {
                query: "pi2 web console nav rail 56px icon-only design tokens",
                numResults: 5,
            }),
        ]),
        toolResult("e-09", t0 + 58_000, {
            toolCallId: "call-search-1",
            toolName: "web_search",
            text: [
                "1. pi2-web-ui-design v0.1.1 — CHG-04 nav rail",
                "   https://example.invalid/pi2-web-ui-design#chg-04",
                "2. Design tokens: three-stage light/dark",
                "   https://example.invalid/tokens",
            ].join("\n"),
            details: { results: 2, provider: "mock-search" },
        }),
        assistantEntry("e-10", t0 + 60_000, [
            toolCall("call-todo-1", "todo_write", {
                todos: MAIN_TODOS.map(({ content, status, activeForm }) => ({ content, status, activeForm })),
            }),
        ]),
        toolResult("e-11", t0 + 60_400, {
            toolCallId: "call-todo-1",
            toolName: "todo_write",
            text: "Todos updated: 1 completed, 2 in progress, 1 pending",
        }),
        todoCheckpoint("e-12", t0 + 60_500, MAIN_TODOS),
        assistantEntry("e-12b", t0 + 62_000, [
            {
                type: "text",
                text: "The shell and the tool families are independent, so I fan them out. Each child owns an exclusive file set.",
            },
            toolCall("call-dispatch-1", "dispatch_subagents", {
                tasks: [
                    { name: "WS-A shell", prompt: "tokens.css + app.css + app-shell.tsx", files: ["web/src/styles/**"] },
                    { name: "WS-C tools", prompt: "22 tool names → 4 display states", files: ["web/src/features/chat/tools/**"] },
                ],
                parallel: true,
            }),
        ]),
        toolResult("e-13", t0 + 63_000, {
            toolCallId: "call-dispatch-1",
            toolName: "dispatch_subagents",
            text: "dispatched 2 subagents (batch-1)",
            details: { batchId: "batch-1", refs: ["sa-shell", "sa-tools"] },
        }),
        assistantEntry("e-14", t0 + 70_000, [
            {
                type: "text",
                text: "The repo has an MCP bridge, so let me open the tracking issue from here.",
            },
            toolCall("call-mcp-1", "mcp__github__create_issue", {
                owner: "zgs225",
                repo: "pi2d",
                title: "visual harness: assert .tabbar is gone",
                body: "Seeded by scripts/ui-mock-server.mjs — an unknown tool the web client must render generically.",
            }),
        ]),
        toolResult("e-15", t0 + 73_000, {
            toolCallId: "call-mcp-1",
            toolName: "mcp__github__create_issue",
            text: '{"number":42,"state":"open","html_url":"https://example.invalid/zgs225/pi2d/issues/42"}',
            details: { server: "github", tool: "create_issue" },
        }),
        assistantEntry("e-16", t0 + 80_000, [
            { type: "text", text: "One command deliberately fails so the error styling is covered:" },
            toolCall("call-bash-2", "bash", {
                command: "pnpm --dir web exec vitest run tests/status-page.test.tsx",
                description: "run the failing status page test",
            }),
        ]),
        toolResult("e-17", t0 + 88_000, {
            toolCallId: "call-bash-2",
            toolName: "bash",
            text: [
                " FAIL  tests/status-page.test.tsx > StatusPage > renders the tasks card",
                "AssertionError: expected 0 to be greater than 0",
                "  at tests/status-page.test.tsx:64:31",
                "Tests  1 failed | 172 passed (173)",
            ].join("\n"),
            isError: true,
            details: { exitCode: 1, durationMs: 8_120 },
        }),
        assistantEntry("e-18", t0 + 90_000, [
            {
                type: "text",
                text: "Known baseline failure (documented in PLAN §3.1). Meanwhile the docs update is being written:",
            },
            toolCall("call-write-1", "write", {
                path: "docs/ui-parity.md",
                content: "# UI parity harness\n\n…",
            }),
        ]),
        // No toolResult for `call-write-1`: the block stays `pending` (spinner).
        assistantEntry("e-19", now - 8_000, [
            {
                type: "text",
                text: "Writing the docs now. Queue is open — send steer notes if the matrix needs another breakpoint.",
            },
        ]),
    ];

    /* ---------------------------------------------------------------- */
    /* history: child session, legacy DTO session, plain session         */
    /* ---------------------------------------------------------------- */

    const childEntries = [
        userEntry("c-01", t0 + 64_000, "Only touch web/src/features/chat/tools/**. Never web/src/pages/**."),
        assistantEntry("c-02", t0 + 66_000, [
            { type: "thinking", thinking: "The mapping table is the contract: 22 names, 9 states, 4 displays." },
            {
                type: "text",
                text: "Reading the digest for the tool-kind table first — the tests pin the exact mapping.",
            },
            toolCall("call-bash-c1", "bash", { command: "sed -n '1,120p' /tmp/pi2d-port/digests/03-tools.md" }),
        ]),
        toolResult("c-03", t0 + 67_500, {
            toolCallId: "call-bash-c1",
            toolName: "bash",
            text: "## 03 — tool families\n\nbash/exec → shell; edit/write/apply_patch → edit; …",
        }),
        assistantEntry("c-04", now - 15_000, [
            { type: "text", text: "Mapping extracted; writing `tools/kind.ts` next." },
        ]),
    ];

    const legacyEntries = [
        userEntry("l-01", t0 + 100_000, "Replay an old daemon's entry stream: the tool DTO still has input/result/text/diff."),
        {
            type: "message",
            id: "l-02",
            timestamp: iso(t0 + 101_000),
            message: {
                role: "assistant",
                timestamp: t0 + 101_000,
                content: [{ type: "text", text: "Legacy shapes below — the adapter must normalise them, not crash." }],
            },
        },
    ];

    /** Block-shaped `state.entries` for the legacy session (old tool DTO + notice). */
    const legacyStateEntries = [
        {
            id: "l-blocks-1",
            role: "assistant",
            ts: t0 + 102_000,
            done: true,
            blocks: [
                {
                    type: "tool",
                    toolCallId: "legacy-call-1",
                    name: "bash",
                    // Pre-0.2 DTO: `input` instead of `args`.
                    input: { command: "ls -la web/dist/assets | head -3" },
                    // …`result` instead of `output`, `text` instead of `output.text`.
                    result: { text: "index-D95FiwHJ.css\nindex-CltlYEg7.js", exitCode: 0 },
                    text: "index-D95FiwHJ.css\nindex-CltlYEg7.js",
                    state: "done",
                },
                {
                    type: "tool",
                    toolCallId: "legacy-call-2",
                    name: "edit",
                    input: { path: "web/src/styles/app.css", old_string: ".tabbar { display: flex; }", new_string: "" },
                    result: { text: "Applied 1 edit" },
                    // Pre-0.2 DTO carried a prerendered unified diff.
                    diff: "--- a/web/src/styles/app.css\n+++ b/web/src/styles/app.css\n@@ -151,1 +151,0 @@\n-@media (max-width: 599px) { .tabbar { display: flex; } }\n",
                    state: "done",
                },
            ],
        },
        {
            id: "l-notice-1",
            role: "notice",
            ts: t0 + 104_000,
            done: true,
            blocks: [{ type: "text", text: "Sub-agent WS-C finished: 22 tools mapped, 1 legacy path kept." }],
        },
    ];

    const plainEntries = [
        userEntry("p-01", now - 5 * 3_600_000, "Old session, nothing running: the empty-idle state must still render."),
        assistantEntry("p-02", now - 5 * 3_600_000 + 30_000, [
            { type: "text", text: "Done. This session is idle with no queue, no attention and no tasks." },
        ]),
    ];

    /* ---------------------------------------------------------------- */
    /* sessions                                                          */
    /* ---------------------------------------------------------------- */

    const baseSession = (overrides) => ({
        sessionId: "",
        workspaceId: "ws-main",
        cwd: "/home/pi2/Workspace/Neovim/pi2d",
        name: null,
        status: "idle",
        flags: { attention: false, done: true, error: false },
        model: { provider: "anthropic", id: "claude-sonnet-4.5" },
        thinking: "high",
        usage: { input: 184_320, output: 26_880, cacheRead: 92_400, cacheWrite: 8_192, cost: 1.8421 },
        contextUsage: { tokens: 148_512, window: 200_000, percent: 74 },
        queue: [],
        todos: [],
        tasks: [],
        batches: [],
        subagents: [],
        attention: [],
        entries: [],
        ...overrides,
    });

    const sessions = [
        baseSession({
            sessionId: "s-main",
            name: "Port v0.1.1 shell + tool families",
            status: "busy",
            // No pending attention here: this is the session the screenshot matrix
            // opens, and the attention modal is blocking (it cannot be dismissed),
            // so a pending request would hide the page under a dialog. Attention
            // lives on `s-attention` below, where the tree still shows the dot.
            flags: { attention: false, done: false, error: false },
            queue: MAIN_QUEUE,
            todos: MAIN_TODOS,
            tasks: MAIN_TASKS,
            batches: MAIN_BATCHES,
            subagents: MAIN_SUBAGENTS,
            lastActiveAt: now - 8_000,
        }),
        baseSession({
            sessionId: "s-child",
            name: "WS-C tool families",
            status: "idle",
            parentId: "s-main",
            visible: true,
            task: "22 tool names → kind mapping + 4 display states",
            todos: [
                { content: "kind.ts mapping table", status: "completed" },
                { content: "state.ts: 9 → 4", status: "in_progress", activeForm: "Collapsing tool states" },
            ],
            contextUsage: { tokens: 41_200, window: 200_000, percent: 21 },
            usage: { input: 52_100, output: 9_640, cacheRead: 12_000, cacheWrite: 2_048, cost: 0.421 },
            lastActiveAt: now - 15_000,
        }),
        baseSession({
            sessionId: "s-attention",
            name: "Diff review: web/src/styles/tokens.css",
            status: "idle",
            flags: { attention: true, done: false, error: false },
            attention: [
                ...MAIN_ATTENTION,
                {
                    requestId: "att-diff-1",
                    method: "diff",
                    title: "Review the token rewrite",
                    message: "3 files changed by sub-agent WS-A.",
                    payload: {
                        files: [
                            {
                                path: "web/src/styles/tokens.css",
                                before: ":root {\n  --tabbar-h: 3.75rem;\n  --topbar-h: 3.25rem;\n}\n",
                                after: ":root {\n  --topbar-h: 3.25rem;\n  --rail-w: 3.5rem;\n}\n",
                            },
                            {
                                path: "web/src/styles/app.css",
                                before: "@media (max-width: 599px) { .tabbar { display: flex; } }\n",
                                after: "@media (max-width: 599px) { .rail { display: none; } }\n",
                            },
                        ],
                    },
                    createdAt: now - 3 * MINUTE,
                    receivedAt: now - 3 * MINUTE + 250,
                },
            ],
            usage: { input: 8_400, output: 1_200, cacheRead: 0, cacheWrite: 0, cost: 0.052 },
            contextUsage: { tokens: 9_600, window: 200_000, percent: 5 },
            lastActiveAt: now - 3 * MINUTE,
        }),
        baseSession({
            sessionId: "s-hidden",
            name: "scratch: token experiment",
            status: "exited",
            visible: false,
            flags: { attention: false, done: true, error: true },
            model: { provider: "openai", id: "gpt-5.1-codex" },
            thinking: "medium",
            usage: { input: 3_200, output: 800, cacheRead: 0, cacheWrite: 0, cost: 0.021 },
            contextUsage: { tokens: 4_000, window: 128_000, percent: 3 },
            lastActiveAt: now - 34 * MINUTE,
        }),
        baseSession({
            sessionId: "s-legacy",
            name: "legacy DTO replay",
            status: "idle",
            visible: true,
            entries: legacyStateEntries,
            usage: { input: 2_040, output: 640, cacheRead: 0, cacheWrite: 0, cost: 0.011 },
            contextUsage: { tokens: 2_680, window: 128_000, percent: 2 },
            lastActiveAt: now - 52 * MINUTE,
        }),
        baseSession({
            sessionId: "s-idle",
            name: "nightly smoke run",
            status: "idle",
            usage: { input: 1_100, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.006 },
            contextUsage: { tokens: 1_400, window: 128_000, percent: 1 },
            lastActiveAt: now - 5 * 3_600_000,
        }),
    ];

    const entryPages = {
        "s-main": mainEntries,
        "s-child": childEntries,
        "s-attention": legacyEntries,
        "s-hidden": [],
        "s-legacy": legacyEntries,
        "s-idle": plainEntries,
    };

    /* ---------------------------------------------------------------- */
    /* workspaces                                                         */
    /* ---------------------------------------------------------------- */

    const readyInstance = (workspaceId, overrides = {}) => ({
        workspaceId,
        instanceId: `inst-${workspaceId}`,
        status: "ready",
        nvimPid: 41_022,
        pluginVersion: "1.8.0",
        hasUI: true,
        attachedClients: 2,
        listenAddr: "/run/user/1000/pi2/i/ab12.sock",
        startedAt: now - 47 * MINUTE,
        ...overrides,
    });

    const workspaces = [
        {
            workspaceId: "ws-main",
            cwd: "/home/pi2/Workspace/Neovim/pi2d",
            name: "pi2d",
            alias: "web console",
            pinned: true,
            hidden: false,
            trusted: true,
            exists: true,
            sessionCount: 6,
            liveCount: 4,
            lastActiveAt: now - 8_000,
            instance: readyInstance("ws-main"),
            visibility: "default",
        },
        {
            workspaceId: "ws-nvim",
            cwd: "/home/pi2/Workspace/Neovim/pi2.nvim",
            name: "pi2.nvim",
            pinned: false,
            hidden: false,
            trusted: true,
            exists: true,
            sessionCount: 3,
            liveCount: 1,
            lastActiveAt: now - 26 * MINUTE,
            instance: readyInstance("ws-nvim", {
                instanceId: "inst-ws-nvim",
                nvimPid: 41_310,
                hasUI: false,
                attachedClients: 1,
                startedAt: now - 2 * 3_600_000,
            }),
            visibility: "default",
        },
        {
            workspaceId: "ws-docs",
            cwd: "/home/pi2/Workspace/Misc/pi2-web-ui-design",
            name: "pi2-web-ui-design",
            alias: null,
            pinned: false,
            hidden: false,
            trusted: false,
            exists: true,
            sessionCount: 1,
            liveCount: 0,
            lastActiveAt: now - 3 * 3_600_000,
            instance: null,
            visibility: "default",
        },
        {
            workspaceId: "ws-hidden",
            cwd: "/home/pi2/Workspace/Scratch/token-experiment",
            name: "token-experiment",
            alias: null,
            pinned: false,
            hidden: true,
            trusted: true,
            exists: true,
            sessionCount: 2,
            liveCount: 0,
            lastActiveAt: now - 34 * MINUTE,
            instance: null,
            visibility: "secondary",
            visibilityReason: "hidden",
        },
        {
            workspaceId: "ws-tmp",
            cwd: "/tmp/pi2-visual-ws.MDdJQT",
            name: "pi2-visual-ws.MDdJQT",
            alias: null,
            pinned: false,
            hidden: false,
            trusted: true,
            exists: true,
            sessionCount: 1,
            liveCount: 1,
            lastActiveAt: now - 12 * MINUTE,
            instance: readyInstance("ws-tmp", {
                instanceId: "inst-ws-tmp",
                nvimPid: 41_877,
                hasUI: false,
                attachedClients: 0,
                status: "degraded",
                reason: "plugin handshake timed out",
            }),
            visibility: "secondary",
            visibilityReason: "temp",
        },
        {
            workspaceId: "ws-ghost",
            cwd: "/home/pi2/Workspace/Moved/away",
            name: "away",
            alias: null,
            pinned: false,
            hidden: false,
            trusted: true,
            exists: false,
            sessionCount: 4,
            liveCount: 0,
            lastActiveAt: now - 22 * 3_600_000,
            instance: null,
            visibility: "secondary",
            visibilityReason: "ghost",
        },
    ];

    /* ---------------------------------------------------------------- */
    /* daemon surfaces                                                   */
    /* ---------------------------------------------------------------- */

    const info = {
        v: 1,
        daemonId: MOCK_DAEMON_ID,
        machineId: MOCK_DAEMON_ID,
        platform: "linux",
        name: "pi2-mock",
        hostname: "k3sagent01",
        os: "Linux 6.1.0-27-amd64",
        version: "0.2.0-mock",
        pluginVersion: "1.8.0",
        host: "127.0.0.1",
        port: 0,
        uptimeMs: 3 * 3_600_000 + 17 * MINUTE,
        status: "online",
        capabilities: ["ws", "sse", "devices", "attention"],
        limits: { maxFrameBytes: 8_388_608, maxBodyBytes: 1_048_576, maxSessions: 256 },
    };

    const health = {
        ok: false,
        checkedAt: now,
        items: [
            { name: "instances", ok: true, detail: "3 connected" },
            { name: "workspaces", ok: false, detail: "5 of 6 present (1 missing)" },
            { name: "auth", ok: true, detail: "3 devices + local token" },
            { name: "static", ok: true, detail: "web/dist" },
        ],
    };

    const devices = [
        {
            id: "dev-local",
            deviceId: "dev-local",
            name: "local browser",
            kind: "laptop",
            lastSeenAt: now - 15_000,
            lastActiveAt: now - 15_000,
            createdAt: now - 26 * 3_600_000,
            revokedAt: null,
        },
        {
            id: "dev-phone",
            deviceId: "dev-phone",
            name: "Pixel 8 · pi2",
            kind: "phone",
            lastSeenAt: now - 47 * MINUTE,
            lastActiveAt: now - 47 * MINUTE,
            createdAt: now - 9 * 86_400_000,
            revokedAt: null,
        },
        {
            id: "dev-tablet",
            deviceId: "dev-tablet",
            name: "iPad Air",
            kind: "tablet",
            lastSeenAt: now - 6 * 86_400_000,
            lastActiveAt: now - 6 * 86_400_000,
            createdAt: now - 40 * 86_400_000,
            revokedAt: now - 5 * 86_400_000,
        },
    ];

    const modelProviders = [
        {
            provider: "anthropic",
            models: [
                { id: "claude-sonnet-4.5", contextWindow: 200_000, reasoning: true },
                { id: "claude-opus-4.1", contextWindow: 200_000, reasoning: true },
                { id: "claude-haiku-4.5", contextWindow: 200_000, reasoning: false },
            ],
        },
        {
            provider: "openai",
            models: [
                { id: "gpt-5.1-codex", contextWindow: 128_000, reasoning: true },
                { id: "gpt-5-mini", contextWindow: 128_000, reasoning: false },
            ],
        },
        {
            provider: "cliproxyapi",
            models: [{ id: "gemini-3-pro", contextWindow: 1_000_000, reasoning: true }],
        },
    ];

    const resources = {
        instances: [
            {
                workspaceId: "ws-main",
                instanceId: "inst-ws-main",
                nvimPid: 41_022,
                rssBytes: 268_435_456,
                sessions: 4,
                hasUI: true,
            },
            {
                workspaceId: "ws-nvim",
                instanceId: "inst-ws-nvim",
                nvimPid: 41_310,
                rssBytes: 96_468_992,
                sessions: 1,
                hasUI: false,
            },
            {
                workspaceId: "ws-tmp",
                instanceId: "inst-ws-tmp",
                nvimPid: 41_877,
                rssBytes: 54_525_952,
                sessions: 1,
                hasUI: false,
            },
        ],
        totalRssBytes: 419_430_400,
        physicalMemoryBytes: 34_359_738_368,
        warn: false,
        reason: "",
    };

    const diagnostics = {
        v: 1,
        daemonId: MOCK_DAEMON_ID,
        uptimeMs: info.uptimeMs,
        connections: [{ clientId: "c-mock", kind: "web", workspaceId: "ws-main" }],
        eventsSent: 12_842,
        eventRate: 3.4,
        slowQueries: 0,
        devices: devices.length,
        workspaces: workspaces.length,
        instances: resources.instances,
    };

    const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));

    // `POST /api/v1/pair` mint payload: the daemon picks the URL and encodes it
    // server-side, so the client never re-derives either (docs/protocol.md §3.2).
    const pairCode = {
        accepted: true,
        code: "QK7M-2XPD",
        url: "http://192.168.2.10:4321/pair/QK7M2XPD",
        expiresAt: now + 10 * MINUTE,
        nonce: "n-9f2c1a",
        qr: { version: 1, ecc: "M", mask: 3, size: 21, rows: mockQrRows("http://192.168.2.10:4321/pair/QK7M2XPD") },
        bases: [
            { kind: "loopback", name: "lo", address: "127.0.0.1:4321", url: "http://127.0.0.1:4321" },
            { kind: "lan", name: "eth0", address: "192.168.2.10:4321", url: "http://192.168.2.10:4321" },
        ],
    };

    return {
        info: { ...info, port: undefined },
        health,
        workspaces,
        sessions,
        sessionById,
        entriesBySession: entryPages,
        devices,
        modelProviders,
        resources,
        diagnostics,
        /** `POST /api/v1/pair` mint response (code + QR matrix + reachable bases). */
        pairCode,
        /** `attention` flattened per workspace for `GET /api/v1/attention`. */
        attentionByWorkspace: (workspaceId) =>
            sessions
                .filter((session) => session.workspaceId === workspaceId)
                .flatMap((session) => session.attention ?? []),
    };
}
