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

/** Apply one live session event to an immutable copy of the render state. */
export function applySessionEvent(state: SessionState, event: SessionEvent): SessionState {
    const next = cloneSessionState(state);
    const normalized: SessionEvent = { ...event, ts: typeof event.ts === "number" ? event.ts : Date.now() };

    if (normalized.type === "entry_appended") {
        applyEntryAppended(next, normalized.entry);
        return next;
    }

    applyEvent(reducerForState(next), normalized);
    return next;
}

/** Enrich a snapshot with its separately-carried entry tail. */
export function normalizeSnapshotState(sessionId: string, workspaceId: string, payload: unknown): SessionState {
    const record = rec(payload);
    const candidate = rec(record?.state) ?? record ?? {};
    const base = emptySessionState({
        sessionId,
        workspaceId: str(candidate.workspaceId) ?? workspaceId,
        cwd: str(candidate.cwd) ?? "",
    });
    const state: SessionState = {
        ...base,
        ...candidate,
        sessionId,
        workspaceId: str(candidate.workspaceId) ?? workspaceId,
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
    };
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

/** `:PiSessions` status matrix → base.css dot class. */
export function sessionDot(state: SessionState): DotStatus {
    if (attentionPending(state)) return "attention";
    if (state.status === "busy" || state.status === "starting") return "busy";
    if (state.status === "compacting") return "compacting";
    if (state.status === "interrupted") return "attention";
    if (state.status === "exited") return "exited";
    if (state.flags.error) return "err";
    if (state.flags.done) return "ok";
    return "idle";
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
