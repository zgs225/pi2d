import { applyEvent, createReducer, type Reducer } from "@protocol/reducer";
import type { Entry, ModelRef, SessionEvent, SessionState, ThinkingLevel } from "@protocol/types";
import type { DotStatus } from "@/components/ui/status-dot";
import { normalizeTodos, projectEntries, type ProjectedEntry } from "@/lib/entry-projection";

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function rec(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function arr<T>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const STATUSES = new Set(["starting", "busy", "compacting", "idle", "exited", "interrupted"]);
const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface EmptySessionInput {
    sessionId: string;
    workspaceId?: string;
    cwd?: string;
    name?: string | null;
    status?: SessionState["status"];
    model?: ModelRef | null;
    thinking?: ThinkingLevel | null;
    parentId?: string | null;
    visible?: boolean;
    task?: string;
}

export function emptySessionState(input: EmptySessionInput): SessionState {
    return {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId ?? "",
        cwd: input.cwd ?? "",
        name: input.name ?? null,
        status: input.status ?? "idle",
        flags: { attention: false, done: false, error: false },
        model: input.model ?? null,
        thinking: input.thinking ?? null,
        usage: { ...EMPTY_USAGE },
        contextUsage: null,
        queue: [],
        todos: [],
        tasks: [],
        batches: [],
        subagents: [],
        attention: [],
        entries: [],
        // `parentId`/`visible` are list metadata with an `undefined` = "not
        // carried" meaning: a fresh/empty state must not clobber the cached
        // row's tree position when it is upserted over it.
        ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        ...(input.visible !== undefined ? { visible: input.visible } : {}),
        ...(input.task !== undefined ? { task: input.task } : {}),
    };
}

export function cloneSessionState(state: SessionState): SessionState {
    if (typeof structuredClone === "function") return structuredClone(state);
    return JSON.parse(JSON.stringify(state)) as SessionState;
}

export function normalizeModelRef(value: unknown): ModelRef | null {
    if (typeof value === "string") {
        const slash = value.indexOf("/");
        return slash > 0
            ? { provider: value.slice(0, slash), id: value.slice(slash + 1) }
            : { provider: "pi", id: value };
    }
    const record = rec(value);
    const provider = str(record?.provider);
    const id = str(record?.id ?? record?.model ?? record?.modelId);
    if (id) return { provider: provider ?? "pi", id };
    return null;
}

/** Rebuild the reducer bookkeeping a snapshot does not carry. */
export function reducerForState(state: SessionState): Reducer {
    const reducer = createReducer({
        sessionId: state.sessionId,
        workspaceId: state.workspaceId,
        cwd: state.cwd,
        name: state.name,
        status: state.status,
        model: state.model,
        thinking: state.thinking,
    });
    reducer.state = state;
    let nextEntry = 1;
    let assistantEntryId: string | null = null;
    let userEntryId: string | null = null;
    for (const entry of state.entries) {
        const match = /^m(\d+)$/.exec(entry.id);
        if (match?.[1]) nextEntry = Math.max(nextEntry, Number(match[1]) + 1);
        if (entry.role === "assistant") assistantEntryId = entry.id;
        if (entry.role === "user") userEntryId = entry.id;
        entry.blocks.forEach((block, index) => {
            if (block.type === "tool") reducer.ctx.toolBlocks.set(block.toolCallId, { entryId: entry.id, index });
        });
    }
    reducer.ctx.nextEntry = nextEntry;
    reducer.ctx.assistantEntryId = assistantEntryId;
    reducer.ctx.userEntryId = userEntryId;
    return reducer;
}

function entryText(entry: Entry): string {
    return entry.blocks
        .map((block) => (block.type === "text" || block.type === "error" ? block.text : block.type === "thinking" ? block.text : ""))
        .join("\n");
}

function isDuplicateEntry(entries: Entry[], candidate: Entry): boolean {
    const text = entryText(candidate);
    const recent = entries.slice(-8);
    return recent.some(
        (entry) =>
            entry.role === candidate.role &&
            Math.abs(entry.ts - candidate.ts) < 5_000 &&
            entryText(entry).trim() === text.trim(),
    );
}

function patchToolResult(state: SessionState, raw: Record<string, unknown>): boolean {
    const toolCallId = str(raw.toolCallId);
    if (!toolCallId) return false;
    for (const entry of state.entries) {
        for (const block of entry.blocks) {
            if (block.type !== "tool" || block.toolCallId !== toolCallId) continue;
            block.state = raw.isError === true ? "error" : "done";
            block.output = {
                text: contentText(raw.content),
                ...(raw.details !== undefined ? { details: raw.details } : {}),
                isError: raw.isError === true,
            };
            return true;
        }
    }
    return false;
}

function contentText(content: unknown): string {
    if (typeof content === "string") return content;
    const parts: string[] = [];
    for (const item of arr<Record<string, unknown>>(content)) {
        if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    }
    return parts.join("\n");
}

/**
 * Handle `entry_appended`. The canonical reducer relays pi's streaming
 * `message_*` events but does not project this authoritative history record, so
 * the browser applies it here (user messages arrive this way; we never insert a
 * local user message).
 */
function applyEntryAppended(state: SessionState, rawEntry: unknown): void {
    const raw = rec(rawEntry);
    if (!raw) return;
    const type = str(raw.type);

    if (type === "custom" && str(raw.customType) === "pi2-todo") {
        const todos = normalizeTodos(rec(raw.data)?.todos);
        if (todos.length) state.todos = todos;
    }

    if (type === "message") {
        const message = rec(raw.message);
        if (message?.role === "toolResult" && patchToolResult(state, message)) return;
        if (message?.role === "assistant") {
            // Streaming message_* events already own the assistant entry; the
            // raw append would re-introduce a second copy.
            return;
        }
    }

    const [projected] = projectEntries([raw]);
    if (!projected) return;
    if (isDuplicateEntry(state.entries, projected)) return;
    state.entries = [...state.entries, projected];
}

/**
 * The assistant entry streaming `message_update` events apply to: the reducer
 * tracks it as `ctx.assistantEntryId`, which `reducerForState` rebuilds as the
 * newest assistant entry of the current state.
 */
function streamingAssistantEntry(state: SessionState): Entry | undefined {
    for (let index = state.entries.length - 1; index >= 0; index -= 1) {
        const entry = state.entries[index];
        if (entry?.role === "assistant") return entry;
    }
    return undefined;
}

/**
 * A streaming update for an assistant message that is already finalized.
 *
 * The bridge coalesces `text_delta`/`thinking_delta` frames (protocol §2) and
 * assigns their `seq` when the frame is finally written, so a coalesced delta
 * can reach the browser *after* the `message_end` (or the snapshot) that owns
 * the final text. Applying it appends the tail of the message a second time
 * (`PONG` → `PONGONG`), and — because the resulting text no longer matches the
 * authoritative session entry — the history page then renders as a second,
 * duplicate assistant message. `message_end`/snapshots carry the full content,
 * so a delta for a `done` entry is always stale.
 */
function isStaleStreamUpdate(state: SessionState, event: SessionEvent): boolean {
    if (event.type !== "message_update") return false;
    return streamingAssistantEntry(state)?.done === true;
}

/** Apply one live session event to an immutable copy of the render state. */
export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
    if (isStaleStreamUpdate(state, event)) return state;
    const next = cloneSessionState(state);
    const normalized: SessionEvent = { ...event, ts: typeof event.ts === "number" ? event.ts : Date.now() };

    if (normalized.type === "entry_appended") {
        applyEntryAppended(next, normalized.entry);
        return next;
    }

    applyEvent(reducerForState(next), normalized);
    return next;
}

/** `parentId` as carried by a list row: string → value, explicit null → `null`. */
function summaryParentId(record: Record<string, unknown>, base: SessionState): string | null {
    if (!("parentId" in record) && !("parent_id" in record)) return base.parentId ?? null;
    return str(record.parentId) ?? str(record.parent_id) ?? null;
}

/** Enrich a snapshot with its separately-carried entry tail. */
export function normalizeSnapshotState(
    sessionId: string,
    workspaceId: string,
    payload: unknown,
    existing?: SessionState,
): SessionState {
    const record = rec(payload);
    const candidate = rec(record?.state) ?? record ?? {};
    const base = emptySessionState({
        sessionId,
        workspaceId: str(candidate.workspaceId) ?? workspaceId,
        cwd: str(candidate.cwd) ?? "",
    });
    // The list row owns the tree metadata; a snapshot without it (the normal
    // case — the reducer never emits these) must not turn a child into a root.
    const parentId = str(candidate.parentId ?? candidate.parent_id) ?? existing?.parentId ?? null;
    const visible = typeof candidate.visible === "boolean" ? candidate.visible : (existing?.visible ?? true);
    const task = str(candidate.task) ?? existing?.task;
    const state: SessionState = {
        ...base,
        ...candidate,
        sessionId,
        workspaceId: str(candidate.workspaceId) ?? workspaceId,
        parentId,
        visible,
        ...(task !== undefined ? { task } : {}),
        flags: {
            attention: candidate.flags ? rec(candidate.flags)?.attention === true : false,
            done: rec(candidate.flags)?.done === true,
            error: rec(candidate.flags)?.error === true,
        },
        usage: { ...EMPTY_USAGE, ...(rec(candidate.usage) ?? {}) } as SessionState["usage"],
        queue: arr(candidate.queue),
        todos: arr(candidate.todos),
        tasks: arr(candidate.tasks),
        batches: arr(candidate.batches),
        subagents: arr(candidate.subagents),
        attention: arr(candidate.attention),
        entries: arr(candidate.entries),
    };
    return state;
}

/** Canonicalize a workspace/session summary from `workspace.query{kind:"sessions"}`. */
export function normalizeSessionSummary(raw: unknown, workspaceId: string, existing?: SessionState): SessionState {
    const record = rec(raw) ?? {};
    const sessionId = str(record.sessionId ?? record.session_id ?? record.id) ?? existing?.sessionId ?? "";
    const base = existing ?? emptySessionState({ sessionId, workspaceId });

    const rawStatus = str(record.status);
    let status: SessionState["status"] | undefined = rawStatus as SessionState["status"] | undefined;
    const flags = { ...base.flags };
    if (rawStatus === "attention") {
        status = "idle";
        flags.attention = true;
    } else if (rawStatus === "done") {
        status = "idle";
        flags.done = true;
    } else if (rawStatus === "error") {
        status = "idle";
        flags.error = true;
    } else if (rawStatus === "dormant") {
        status = "exited";
    }
    if (!status || !STATUSES.has(status)) status = base.status;

    const rawFlags = rec(record.flags);
    const attentionCount = num(record.attentionCount);
    if (rawFlags) {
        flags.attention = rawFlags.attention === true;
        flags.done = rawFlags.done === true;
        flags.error = rawFlags.error === true;
    } else if (attentionCount && attentionCount > 0) {
        flags.attention = true;
    }

    const thinkingValue = str(record.thinking);
    const hasQueue = Array.isArray(record.queue);
    const task = str(record.task) ?? base.task;
    // Provisional display name: the list row's disk projection of the session's
    // first user message (pi2.nvim's `first_message` fallback). Absent means
    // "not carried", `null` means "there is none".
    const firstMessage = record.firstMessage === null ? null : str(record.firstMessage);
    return {
        ...base,
        sessionId,
        workspaceId: str(record.workspaceId) ?? workspaceId,
        cwd: str(record.cwd) ?? base.cwd,
        name: record.name === null ? null : (str(record.name) ?? base.name),
        status,
        flags,
        model: record.model !== undefined ? normalizeModelRef(record.model) : base.model,
        thinking: thinkingValue && THINKING.has(thinkingValue) ? (thinkingValue as ThinkingLevel) : base.thinking,
        usage: record.usage !== undefined ? ({ ...EMPTY_USAGE, ...(rec(record.usage) ?? {}) } as SessionState["usage"]) : base.usage,
        contextUsage:
            record.contextUsage !== undefined
                ? ((rec(record.contextUsage) as unknown as SessionState["contextUsage"]) ?? null)
                : base.contextUsage,
        queue: hasQueue ? arr(record.queue) : base.queue,
        todos: Array.isArray(record.todos) ? arr(record.todos) : base.todos,
        tasks: Array.isArray(record.tasks) ? arr(record.tasks) : base.tasks,
        batches: Array.isArray(record.batches) ? arr(record.batches) : base.batches,
        subagents: Array.isArray(record.subagents) ? arr(record.subagents) : base.subagents,
        attention: Array.isArray(record.attention) ? arr(record.attention) : base.attention,
        entries: Array.isArray(record.entries) ? arr<Entry>(record.entries) : base.entries,
        parentId: summaryParentId(record, base),
        visible: typeof record.visible === "boolean" ? record.visible : base.visible,
        ...(task !== undefined ? { task } : {}),
        ...(firstMessage !== undefined ? { firstMessage } : {}),
    };
}

/** `sessionId` of a raw list row (`sessionId` is the wire field; aliases are tolerated). */
function rawSessionId(row: Record<string, unknown>): string {
    return str(row.sessionId) ?? str(row.session_id) ?? str(row.id) ?? "";
}

/** `parentId` of a raw list row; `null` means a root. */
function rawParentId(row: Record<string, unknown>): string | null {
    return str(row.parentId) ?? str(row.parent_id) ?? null;
}

/** A row is a tab when the plugin's live projection carries `attached_tab`. */
function hasTab(row: Record<string, unknown>): boolean {
    return typeof row.tab === "number" && Number.isFinite(row.tab) && row.tab > 0;
}

/**
 * Restrict a `workspace.query{kind:"sessions"}` payload to the sessions nvim's
 * list renders.
 *
 * The plugin answers with the union of the workspace's session JSONL files on
 * disk (`History.list()`) and its live sessions, so a tab-less root row is
 * *history*, not a tab: it has no live owner and a command routed to it answers
 * `E_SESSION_NOT_FOUND`. nvim's `:PiSessions` is `Sessions.list()` — the
 * sessions attached to a tabpage — plus their children, and `tab` is the live
 * projection of `Session.attached_tab`.
 *
 * So keep the connected component (through `parentId`, in both directions) of
 * every row that carries a `tab`: the tabs themselves, the sub-sessions below
 * them, and the parent row when a tab is in a child view. Everything else is
 * disk history and stays out of the console (it is a `session.resume` target,
 * never a prompt target).
 */
export function tabSessionRows(raw: unknown): Record<string, unknown>[] {
    const record = rec(raw);
    const list = Array.isArray(raw) ? raw : arr(record?.sessions ?? record?.items);
    const rows: Record<string, unknown>[] = [];
    for (const entry of list) {
        const row = rec(entry);
        if (row) rows.push(row);
    }

    // Parent links both ways; a duplicate id (a list race) keeps its first row.
    const parentOf = new Map<string, string>();
    const childrenOf = new Map<string, string[]>();
    for (const row of rows) {
        const id = rawSessionId(row);
        if (id === "" || parentOf.has(id)) continue;
        const parentId = rawParentId(row);
        parentOf.set(id, parentId ?? "");
        if (parentId !== null && parentId !== "") {
            const siblings = childrenOf.get(parentId);
            if (siblings) siblings.push(id);
            else childrenOf.set(parentId, [id]);
        }
    }

    const keep = new Set<string>();
    const stack: string[] = [];
    for (const row of rows) {
        const id = rawSessionId(row);
        if (id !== "" && hasTab(row)) stack.push(id);
    }
    while (stack.length > 0) {
        const id = stack.pop();
        if (id === undefined || keep.has(id)) continue;
        keep.add(id);
        const parentId = parentOf.get(id);
        if (parentId) stack.push(parentId);
        for (const childId of childrenOf.get(id) ?? []) stack.push(childId);
    }

    return rows.filter((row) => keep.has(rawSessionId(row)));
}

/** Parse `{sessions:[...]}` (also bare arrays) into render states. */
export function normalizeSessionsPayload(
    raw: unknown,
    workspaceId: string,
    existing: SessionState[] = [],
): SessionState[] {
    const record = rec(raw);
    const list = Array.isArray(raw) ? raw : arr(record?.sessions ?? record?.items);
    const byId = new Map(existing.map((session) => [session.sessionId, session]));
    return list
        .map((entry) => normalizeSessionSummary(entry, workspaceId, byId.get(str(rec(entry)?.sessionId ?? rec(entry)?.id) ?? "")))
        .filter((session) => session.sessionId !== "");
}

function attentionPending(state: SessionState): boolean {
    return state.flags.attention || state.attention.length > 0;
}

/**
 * A dot render decision: the base status plus the two overlay modifiers.
 * `steady` pins the dot solid, `current` paints the "you are here" overlay.
 */
export interface DotView {
    status: DotStatus;
    steady?: boolean;
    current?: boolean;
}

/**
 * The current-tab marker: `:PiSessions` paints the dot of the session its tab is
 * showing in agent blue, steady while idle and blinking while busy, and never on
 * top of a notification colour (`dot_hl` outranks it — see
 * `refresh_current_markers`). The browser's analogue is the row the user has
 * open. A focused `compacting` session blinks at the busy rate, not half speed.
 */
function withCurrent(view: DotView, state: SessionState, viewed: boolean): DotView {
    if (!viewed) return view;
    if (state.flags.error || state.flags.done || attentionPending(state)) return view;
    if (state.status === "exited" || state.status === "interrupted") return view;
    return { current: true, status: state.status === "compacting" ? "busy" : view.status };
}

/**
 * `:PiSessions` parent row matrix (`dot_hl`, priority order): exited > error >
 * attention > done > busy > compacting > idle. `interrupted` is the wire's
 * "the process died badly" — it shares the exited red with `exited`, never the
 * attention amber (`sessionStatusKey` still labels it "interrupted").
 */
function parentDot(state: SessionState): DotView {
    if (state.status === "exited") return { status: "dead" };
    if (state.flags.error) return { status: "err" };
    if (attentionPending(state)) return { status: "attention" };
    if (state.flags.done) return { status: "ok" };
    if (state.status === "busy") return { status: "busy" };
    if (state.status === "compacting") return { status: "compacting" };
    if (state.status === "interrupted") return { status: "dead" };
    return { status: "idle" };
}

/** `:PiSessions` → dot for a parent (depth 0) session row. */
export function sessionDot(state: SessionState, opts: { viewed?: boolean } = {}): DotView {
    return withCurrent(parentDot(state), state, opts.viewed === true);
}

/**
 * `:PiSessions` sub-session matrix (`child_dot_hl`) — deliberately not the
 * parent's: an exited/dormant child is the hollow `◌` (never the exited red), a
 * failed child is steady red while you are looking at it and blinking red while
 * you are not, and `busy`/`compacting` share the busy amber at the busy rate.
 * A child never shows `ok` or `attention`: the plugin forces `done = false` and
 * `attention = 0` there, surfacing both in the parent chat instead.
 */
function childDot(state: SessionState, viewed: boolean): DotView {
    if (state.status === "exited") return { status: "exited" };
    if (state.status === "interrupted") return { status: "dead" };
    if (state.flags.error) return { status: "err", steady: viewed };
    if (state.status === "busy" || state.status === "compacting") return { status: "busy" };
    return { status: "idle" };
}

/** `:PiSessions` → dot for a sub-session (depth > 0) row. */
export function childSessionDot(state: SessionState, opts: { viewed?: boolean } = {}): DotView {
    const viewed = opts.viewed === true;
    return withCurrent(childDot(state, viewed), state, viewed);
}

/**
 * `:PiSessions` → dot for a manifest-only subagent row. A `completed` subagent is
 * the hollow dot, not a green one: the plugin shows a finished child as dormant
 * `◌` and keeps green for "a turn finished while you were elsewhere" on parents.
 */
export function subagentDot(
    subagent: SessionState["subagents"][number],
    opts: { viewed?: boolean } = {},
): DotView {
    switch (subagent.status) {
        case "active":
            return { status: "busy" };
        case "completed":
        case "dormant":
            return { status: "exited" };
        case "failed":
            return { status: "err", steady: opts.viewed === true };
        case "interrupted":
            return { status: "dead" };
        default:
            return { status: "idle" };
    }
}

/** i18n key under `state.*` for the current session status. */
export function sessionStatusKey(state: SessionState): string {
    if (attentionPending(state)) return "attention";
    if (state.status === "busy" || state.status === "starting") return "busy";
    if (state.status === "compacting") return "compacting";
    if (state.status === "interrupted") return "interrupted";
    if (state.status === "exited") return "exited";
    if (state.flags.error) return "error";
    if (state.flags.done) return "done";
    return "idle";
}

/** Flatten a subagent tree into render rows with their indent depth. */
export function flattenSubagents(
    list: SessionState["subagents"] | undefined,
    depth = 0,
): { subagent: NonNullable<SessionState["subagents"]>[number]; depth: number }[] {
    const out: { subagent: NonNullable<SessionState["subagents"]>[number]; depth: number }[] = [];
    for (const subagent of list ?? []) {
        out.push({ subagent, depth });
        out.push(...flattenSubagents(subagent.children, depth + 1));
    }
    return out;
}

export function findSubagent(
    list: SessionState["subagents"] | undefined,
    predicate: (subagent: NonNullable<SessionState["subagents"]>[number]) => boolean,
): NonNullable<SessionState["subagents"]>[number] | undefined {
    for (const subagent of list ?? []) {
        if (predicate(subagent)) return subagent;
        const found = findSubagent(subagent.children, predicate);
        if (found) return found;
    }
    return undefined;
}

export type { ProjectedEntry };
