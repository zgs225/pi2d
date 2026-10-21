/**
 * Canonical session-state reducer.
 *
 * This is the reference implementation of the projection that turns a pi event
 * stream (plus `pi2:` derived events) into `SessionState`. The plugin keeps the
 * authoritative copy in Lua (`lua/pi/web/state.lua`); the browser keeps a render
 * cache reduced by this file; both must agree on `fixtures/*` (see
 * `test/reducer.conformance.test.ts`).
 */

import type {
    AttentionItem,
    Batch,
    Block,
    ContextUsage,
    Entry,
    ModelRef,
    QueueItem,
    SessionEvent,
    SessionState,
    Subagent,
    TaskItem,
    ThinkingLevel,
    TodoItem,
    ToolOutput,
    UsageTotals,
} from "./types.js";

export interface ReducerContext {
    nextEntry: number;
    assistantEntryId: string | null;
    userEntryId: string | null;
    /** toolCallId -> location of the tool block */
    toolBlocks: Map<string, { entryId: string; index: number }>;
    /** streamed tool call argument buffers, keyed by toolCallId */
    toolArgs: Map<string, string>;
}

export interface Reducer {
    state: SessionState;
    ctx: ReducerContext;
}

export interface StateInit {
    sessionId: string;
    workspaceId?: string;
    cwd?: string;
    name?: string | null;
    status?: SessionState["status"];
    model?: ModelRef | null;
    thinking?: ThinkingLevel | null;
}

const EMPTY_USAGE: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

export function createReducer(init: StateInit): Reducer {
    return {
        state: {
            sessionId: init.sessionId,
            workspaceId: init.workspaceId ?? "",
            cwd: init.cwd ?? "",
            name: init.name ?? null,
            status: init.status ?? "starting",
            flags: { attention: false, done: false, error: false },
            model: init.model ?? null,
            thinking: init.thinking ?? null,
            usage: { ...EMPTY_USAGE },
            contextUsage: null,
            queue: [],
            todos: [],
            tasks: [],
            batches: [],
            subagents: [],
            attention: [],
            entries: [],
        },
        ctx: {
            nextEntry: 1,
            assistantEntryId: null,
            userEntryId: null,
            toolBlocks: new Map(),
            toolArgs: new Map(),
        },
    };
}

export function reduceAll(init: StateInit, events: SessionEvent[]): SessionState {
    const r = createReducer(init);
    for (const e of events) applyEvent(r, e);
    return r.state;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function num(v: unknown, fallback = 0): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string | undefined {
    return typeof v === "string" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function entryOf(r: Reducer, id: string | null): Entry | undefined {
    if (!id) return undefined;
    return r.state.entries.find((e) => e.id === id);
}

function newEntry(r: Reducer, role: Entry["role"], ts: number, blocks: Block[] = [], done = false): Entry {
    const entry: Entry = { id: `m${r.ctx.nextEntry++}`, role, ts, blocks, done };
    r.state.entries.push(entry);
    return entry;
}

/** Index of the block for a `contentIndex`, creating placeholders as needed. */
function blockAt(entry: Entry, index: number, template: () => Block): Block {
    while (entry.blocks.length <= index) entry.blocks.push({ type: "text", text: "" });
    const existing = entry.blocks[index];
    if (existing && existing.type === template().type) return existing;
    const block = template();
    entry.blocks[index] = block;
    return block;
}

function appendDelta(entry: Entry, index: number, type: "text" | "thinking", delta: string) {
    const block = blockAt(entry, index, () => ({ type, text: "" })) as { type: "text" | "thinking"; text: string };
    block.text += delta;
}

function contentToBlocks(content: unknown, ts: number): Block[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    const blocks: Block[] = [];
    for (const raw of arr(content)) {
        const b = rec(raw);
        if (!b) continue;
        switch (b.type) {
            case "text":
                blocks.push({ type: "text", text: str(b.text) ?? "" });
                break;
            case "thinking":
                blocks.push({ type: "thinking", text: str(b.thinking) ?? str(b.text) ?? "" });
                break;
            case "toolCall":
                blocks.push({
                    type: "tool",
                    toolCallId: str(b.id) ?? `call_${ts}_${blocks.length}`,
                    name: str(b.name) ?? "tool",
                    args: b.arguments,
                    state: "pending",
                });
                break;
            case "error":
                blocks.push({ type: "error", text: str(b.text) ?? str(b.error) ?? "error" });
                break;
            default:
                break;
        }
    }
    return blocks;
}

function imagesOf(content: unknown): { mimeType: string; data: string }[] | undefined {
    const out: { mimeType: string; data: string }[] = [];
    for (const raw of arr(content)) {
        const b = rec(raw);
        if (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
            out.push({ mimeType: b.mimeType, data: b.data });
        }
    }
    return out.length ? out : undefined;
}

function addUsage(state: SessionState, usage: unknown) {
    const u = rec(usage);
    if (!u) return;
    state.usage.input += num(u.input);
    state.usage.output += num(u.output);
    state.usage.cacheRead += num(u.cacheRead);
    state.usage.cacheWrite += num(u.cacheWrite);
    state.usage.cost += num(rec(u.cost)?.total);
}

/* ------------------------------------------------------------------ */
/* event handlers                                                      */
/* ------------------------------------------------------------------ */

export function applyEvent(r: Reducer, e: SessionEvent): void {
    const ts = num(e.ts);
    switch (e.type) {
        case "agent_start":
            r.state.status = "busy";
            r.state.flags.done = false;
            r.state.flags.error = false;
            return;

        case "agent_settled": {
            if (r.state.status !== "exited" && r.state.status !== "interrupted") r.state.status = "idle";
            r.state.flags.done = e.aborted !== true;
            r.state.flags.error = e.aborted === true ? true : r.state.flags.error;
            return;
        }

        case "compaction_start":
            r.state.status = "compacting";
            return;

        case "compaction_end":
            if (r.state.status === "compacting") r.state.status = "idle";
            return;

        case "session_info_changed":
            r.state.name = str(e.name) ?? null;
            return;

        case "thinking_level_changed":
            r.state.thinking = (str(e.level) as ThinkingLevel | undefined) ?? r.state.thinking;
            return;

        case "queue_update": {
            const queue: QueueItem[] = [];
            arr(e.steering).forEach((text, i) => {
                if (typeof text === "string") queue.push({ id: `q:steer:${i}`, text, steer: true });
            });
            arr(e.followUp).forEach((text, i) => {
                if (typeof text === "string") queue.push({ id: `q:follow:${i}`, text, steer: false });
            });
            r.state.queue = queue;
            return;
        }

        case "message_start": {
            const msg = rec(e.message);
            if (!msg) return;
            const role = str(msg.role);
            if (role === "user") {
                const entry = newEntry(r, "user", ts, contentToBlocks(msg.content, ts));
                entry.images = imagesOf(msg.content);
                r.ctx.userEntryId = entry.id;
            } else if (role === "assistant") {
                const entry = newEntry(r, "assistant", ts, []);
                r.ctx.assistantEntryId = entry.id;
            }
            return;
        }

        case "message_update": {
            const update = rec(e.assistantMessageEvent);
            if (!update) return;
            const entry = entryOf(r, r.ctx.assistantEntryId);
            if (!entry) return;
            const index = num(update.contentIndex);
            switch (update.type) {
                case "text_start":
                    blockAt(entry, index, () => ({ type: "text", text: "" }));
                    break;
                case "text_delta":
                    appendDelta(entry, index, "text", str(update.delta) ?? "");
                    break;
                case "text_end": {
                    const block = blockAt(entry, index, () => ({ type: "text", text: "" })) as {
                        type: "text";
                        text: string;
                    };
                    block.text = str(update.content) ?? block.text;
                    break;
                }
                case "thinking_start":
                    blockAt(entry, index, () => ({ type: "thinking", text: "" }));
                    break;
                case "thinking_delta":
                    appendDelta(entry, index, "thinking", str(update.delta) ?? "");
                    break;
                case "thinking_end": {
                    const block = blockAt(entry, index, () => ({ type: "thinking", text: "" })) as {
                        type: "thinking";
                        text: string;
                    };
                    block.text = str(update.content) ?? block.text;
                    break;
                }
                case "toolcall_start": {
                    const toolCallId = str(update.id) ?? `call_${ts}_${index}`;
                    const block: Block = {
                        type: "tool",
                        toolCallId,
                        name: str(update.toolName) ?? "tool",
                        state: "pending",
                    };
                    while (entry.blocks.length <= index) entry.blocks.push({ type: "text", text: "" });
                    entry.blocks[index] = block;
                    r.ctx.toolBlocks.set(toolCallId, { entryId: entry.id, index });
                    r.ctx.toolArgs.set(toolCallId, "");
                    break;
                }
                case "toolcall_delta": {
                    const toolCallId = findToolCallIdAt(r, entry.id, index);
                    if (toolCallId) {
                        r.ctx.toolArgs.set(toolCallId, (r.ctx.toolArgs.get(toolCallId) ?? "") + (str(update.delta) ?? ""));
                    }
                    break;
                }
                case "toolcall_end": {
                    const call = rec(update.toolCall);
                    const toolCallId = str(call?.id) ?? findToolCallIdAt(r, entry.id, index);
                    if (!toolCallId) break;
                    const block = ensureToolBlock(r, toolCallId, entry.id, index);
                    block.name = str(call?.name) ?? block.name;
                    if (call) block.args = call.arguments;
                    r.ctx.toolArgs.delete(toolCallId);
                    break;
                }
                case "error": {
                    const text = str(update.error) ?? str(update.reason) ?? "error";
                    entry.blocks.push({ type: "error", text });
                    break;
                }
                default:
                    break;
            }
            return;
        }

        case "tool_execution_start": {
            const toolCallId = str(e.toolCallId);
            if (!toolCallId) return;
            const block = ensureToolBlock(r, toolCallId, r.ctx.assistantEntryId);
            block.name = str(e.toolName) ?? block.name;
            block.args = e.args;
            block.state = "running";
            return;
        }

        case "tool_execution_update": {
            const toolCallId = str(e.toolCallId);
            if (!toolCallId) return;
            const block = ensureToolBlock(r, toolCallId, r.ctx.assistantEntryId);
            const output = toolOutputOf(e.partialResult);
            if (output) block.output = output;
            return;
        }

        case "tool_execution_end": {
            const toolCallId = str(e.toolCallId);
            if (!toolCallId) return;
            const block = ensureToolBlock(r, toolCallId, r.ctx.assistantEntryId);
            const output = toolOutputOf(e.result);
            if (output) block.output = output;
            block.state = e.isError === true ? "error" : "done";
            if (typeof e.durationMs === "number") block.durationMs = e.durationMs;
            return;
        }

        case "message_end": {
            const msg = rec(e.message);
            if (!msg) return;
            const role = str(msg.role);
            if (role === "user") {
                const entry = entryOf(r, r.ctx.userEntryId);
                if (entry) {
                    entry.blocks = contentToBlocks(msg.content, ts);
                    entry.images = imagesOf(msg.content);
                    entry.done = true;
                }
                return;
            }
            if (role !== "assistant") return;
            const entry = entryOf(r, r.ctx.assistantEntryId);
            if (!entry) return;
            entry.blocks = rebuildBlocks(r, contentToBlocks(msg.content, ts));
            entry.done = true;
            addUsage(r.state, msg.usage);
            return;
        }

        case "pi2:session": {
            const patch = rec(e.session);
            if (!patch) return;
            for (const key of ["status", "name", "model", "thinking", "usage", "contextUsage", "flags"] as const) {
                if (key in patch) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (r.state as any)[key] = patch[key];
                }
            }
            if (r.state.attention.length > 0) r.state.flags.attention = true;
            return;
        }

        case "pi2:todo":
            r.state.todos = arr(e.todos).map((raw) => {
                const t = rec(raw) ?? {};
                return {
                    content: str(t.content) ?? "",
                    status: (str(t.status) as TodoItem["status"]) ?? "pending",
                    ...(typeof t.activeForm === "string" ? { activeForm: t.activeForm } : {}),
                };
            });
            return;

        case "pi2:batch": {
            const batch: Batch = {
                batchId: str(e.batchId) ?? "batch",
                status: (str(e.status) as Batch["status"]) ?? "running",
                items: arr(e.items).map((raw) => {
                    const item = rec(raw) ?? {};
                    return {
                        ref: str(item.ref) ?? "",
                        ...(typeof item.name === "string" ? { name: item.name } : {}),
                        status: (str(item.status) as Batch["items"][number]["status"]) ?? "queued",
                        ...(typeof item.error === "string" ? { error: item.error } : {}),
                    };
                }),
                ...(rec(e.summary) ? { summary: rec(e.summary) as unknown as Batch["summary"] } : {}),
            };
            const idx = r.state.batches.findIndex((b) => b.batchId === batch.batchId);
            if (idx >= 0) r.state.batches[idx] = batch;
            else r.state.batches.push(batch);
            return;
        }

        case "pi2:task": {
            const t = rec(e.task);
            if (!t) return;
            const task: TaskItem = {
                id: str(t.id) ?? "task",
                command: str(t.command) ?? "",
                status: (str(t.status) as TaskItem["status"]) ?? "running",
                startTime: num(t.startTime, ts),
                ...(typeof t.durationMs === "number" ? { durationMs: t.durationMs } : {}),
                ...(t.exitCode === null || typeof t.exitCode === "number" ? { exitCode: t.exitCode as number | null } : {}),
                ...(typeof t.outputFile === "string" ? { outputFile: t.outputFile } : {}),
            };
            const idx = r.state.tasks.findIndex((x) => x.id === task.id);
            if (idx >= 0) r.state.tasks[idx] = task;
            else r.state.tasks.push(task);
            return;
        }

        case "pi2:subagents":
            r.state.subagents = arr(e.subagents) as Subagent[];
            return;

        case "pi2:attention_request": {
            const item: AttentionItem = {
                requestId: str(e.requestId) ?? `att_${ts}`,
                method: str(e.method) ?? "select",
                ...(typeof e.title === "string" ? { title: e.title } : {}),
                ...(typeof e.message === "string" ? { message: e.message } : {}),
                ...(Array.isArray(e.options) ? { options: e.options as AttentionItem["options"] } : {}),
                ...(e.payload !== undefined ? { payload: e.payload } : {}),
                ...(typeof e.timeoutSec === "number" ? { timeoutSec: e.timeoutSec } : {}),
                createdAt: num(e.createdAt, ts),
                receivedAt: ts,
            };
            r.state.attention = r.state.attention.filter((a) => a.requestId !== item.requestId).concat(item);
            r.state.flags.attention = true;
            return;
        }

        case "pi2:attention_resolved": {
            const id = str(e.requestId);
            r.state.attention = r.state.attention.filter((a) => a.requestId !== id);
            r.state.flags.attention = r.state.attention.length > 0;
            return;
        }

        case "pi2:process_exit": {
            const code = e.code;
            r.state.status = code === 0 || code === null || code === undefined ? "exited" : "interrupted";
            // An exit is not a completed turn: keep `done` untouched so the UI shows
            // the hollow "exited" dot instead of a green "done" mark.
            return;
        }

        case "pi2:error": {
            const text = str(e.message) ?? "error";
            const entry = entryOf(r, r.ctx.assistantEntryId) ?? newEntry(r, "notice", ts, []);
            entry.blocks.push({ type: "error", text });
            if (!r.ctx.assistantEntryId) entry.done = true;
            r.state.flags.error = true;
            return;
        }

        default:
            return;
    }
}

function findToolCallIdAt(r: Reducer, entryId: string, index: number): string | undefined {
    for (const [id, loc] of r.ctx.toolBlocks) {
        if (loc.entryId === entryId && loc.index === index) return id;
    }
    return undefined;
}

function ensureToolBlock(r: Reducer, toolCallId: string, entryId: string | null, index?: number): Extract<Block, { type: "tool" }> {
    const loc = r.ctx.toolBlocks.get(toolCallId);
    const entry = (loc ? entryOf(r, loc.entryId) : undefined) ?? entryOf(r, entryId);
    if (entry && loc) {
        const block = entry.blocks[loc.index];
        if (block && block.type === "tool") return block;
    }
    const target = entry ?? newEntry(r, "assistant", Date.now(), []);
    const at = index ?? target.blocks.length;
    const block: Extract<Block, { type: "tool" }> = {
        type: "tool",
        toolCallId,
        name: "tool",
        state: "pending",
    };
    while (target.blocks.length < at) target.blocks.push({ type: "text", text: "" });
    target.blocks[at] = block;
    r.ctx.toolBlocks.set(toolCallId, { entryId: target.id, index: at });
    return block;
}

function rebuildBlocks(r: Reducer, blocks: Block[]): Block[] {
    const out: Block[] = [];
    for (const block of blocks) {
        if (block.type !== "tool") {
            out.push(block);
            continue;
        }
        const loc = r.ctx.toolBlocks.get(block.toolCallId);
        const existing = loc ? entryOf(r, loc.entryId)?.blocks[loc.index] : undefined;
        if (existing && existing.type === "tool") {
            existing.name = block.name || existing.name;
            if (block.args !== undefined) existing.args = block.args;
            out.push(existing);
        } else {
            out.push(block);
        }
    }
    // re-index tool blocks for late execution events
    for (const [id, loc] of [...r.ctx.toolBlocks]) {
        const idx = out.findIndex((b) => b.type === "tool" && b.toolCallId === id);
        if (idx >= 0) r.ctx.toolBlocks.set(id, { entryId: loc.entryId, index: idx });
    }
    return out;
}

function toolOutputOf(value: unknown): ToolOutput | undefined {
    const v = rec(value);
    if (!v) return undefined;
    const texts: string[] = [];
    for (const raw of arr(v.content)) {
        const b = rec(raw);
        if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
    const out: ToolOutput = {};
    if (texts.length) out.text = texts.join("\n");
    if (v.details !== undefined) out.details = v.details;
    if (typeof v.isError === "boolean") out.isError = v.isError;
    return Object.keys(out).length ? out : undefined;
}

export const __internal = { contentToBlocks, rebuildBlocks, ensureToolBlock };
