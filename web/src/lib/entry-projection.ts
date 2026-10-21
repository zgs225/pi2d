import type { Block, Entry, TodoItem } from "@protocol/types";

/** Raw pi session entries are JSONL records without a stable TypeScript type on the wire. */
export type RawEntry = Record<string, unknown>;

export interface ProjectedTodo {
    items: TodoItem[];
    completed: number;
    total: number;
}

/** A projected history entry. `pi2-todo` checkpoints carry their block inline. */
export interface ProjectedEntry extends Entry {
    todo?: ProjectedTodo;
}

export interface EntriesCursor {
    before?: string;
    hasMore: boolean;
}

export interface EntriesPage {
    entries: RawEntry[];
    cursor: EntriesCursor;
}

function rec(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function arr(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function idOf(raw: unknown): string | undefined {
    return str(rec(raw)?.id);
}

function timestampOf(raw: Record<string, unknown>, message?: Record<string, unknown>): number {
    const fromMessage = num(message?.timestamp);
    if (fromMessage !== undefined) return fromMessage;
    const iso = str(raw.timestamp);
    if (iso) {
        const parsed = Date.parse(iso);
        if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
}

function textOfContent(content: unknown): string {
    if (typeof content === "string") return content;
    const parts: string[] = [];
    for (const raw of arr(content)) {
        const block = rec(raw);
        if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
    return parts.join("\n");
}

function imagesOf(content: unknown): Entry["images"] | undefined {
    const images: { mimeType: string; data: string }[] = [];
    for (const raw of arr(content)) {
        const block = rec(raw);
        if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
            images.push({ mimeType: block.mimeType, data: block.data });
        }
    }
    return images.length ? images : undefined;
}

function contentToBlocks(content: unknown): Block[] {
    if (typeof content === "string") return [{ type: "text", text: content }];
    const blocks: Block[] = [];
    for (const raw of arr(content)) {
        const block = rec(raw);
        if (!block) continue;
        switch (block.type) {
            case "text":
                blocks.push({ type: "text", text: str(block.text) ?? "" });
                break;
            case "thinking":
                blocks.push({
                    type: "thinking",
                    text: str(block.thinking) ?? str(block.text) ?? "",
                    ...(block.redacted === true ? { redacted: true } : {}),
                });
                break;
            case "toolCall":
                blocks.push({
                    type: "tool",
                    toolCallId: str(block.id) ?? `call_${blocks.length}`,
                    name: str(block.name) ?? "tool",
                    args: block.arguments,
                    state: "pending",
                });
                break;
            case "error":
                blocks.push({ type: "error", text: str(block.text) ?? str(block.error) ?? "error" });
                break;
            default:
                break;
        }
    }
    return blocks;
}

function applyToolResult(entries: ProjectedEntry[], message: Record<string, unknown>): boolean {
    const toolCallId = str(message.toolCallId);
    if (!toolCallId) return false;
    for (const entry of entries) {
        for (const block of entry.blocks) {
            if (block.type !== "tool" || block.toolCallId !== toolCallId) continue;
            block.output = {
                text: textOfContent(message.content),
                ...(message.details !== undefined ? { details: message.details } : {}),
                isError: message.isError === true,
            };
            block.state = message.isError === true ? "error" : "done";
            return true;
        }
    }
    return false;
}

function normalizeTodo(data: unknown): ProjectedTodo | undefined {
    const record = rec(data);
    if (!record) return undefined;
    const items: TodoItem[] = arr(record.todos).map((raw) => {
        const item = rec(raw) ?? {};
        return {
            content: str(item.content) ?? "",
            status: item.status === "completed" || item.status === "in_progress" ? item.status : "pending",
            ...(typeof item.activeForm === "string" ? { activeForm: item.activeForm } : {}),
        };
    });
    if (!items.length) return undefined;
    const completed = num(record.completed) ?? items.filter((item) => item.status === "completed").length;
    const total = num(record.total) ?? items.length;
    return { items, completed, total };
}

/**
 * Project raw pi session entries (message / toolResult / `pi2-todo` custom
 * checkpoints) into the render `Entry` shape. Non-conversation entries
 * (header, label, model_change, …) are ignored. Tool results are folded into
 * the assistant tool block they belong to, exactly like the live reducer keeps
 * execution state on the block.
 */
export function projectEntries(rawEntries: unknown[]): ProjectedEntry[] {
    const out: ProjectedEntry[] = [];
    let synthetic = 0;

    for (const value of rawEntries) {
        const raw = rec(value);
        if (!raw) continue;
        const type = str(raw.type);

        if (type === "message") {
            const message = rec(raw.message);
            if (!message) continue;
            const role = str(message.role);
            const ts = timestampOf(raw, message);
            const id = str(raw.id) ?? `raw-${synthetic++}`;

            if (role === "user") {
                const blocks = contentToBlocks(message.content);
                const images = imagesOf(message.content);
                out.push({ id, role: "user", ts, blocks, done: true, ...(images ? { images } : {}) });
                continue;
            }

            if (role === "assistant") {
                const blocks = contentToBlocks(message.content);
                const stopReason = str(message.stopReason);
                const errorMessage = str(message.errorMessage);
                if (stopReason === "error" || stopReason === "aborted" || errorMessage) {
                    blocks.push({
                        type: "error",
                        text: errorMessage ?? `assistant ${stopReason ?? "error"}`,
                    });
                }
                out.push({ id, role: "assistant", ts, blocks, done: true });
                continue;
            }

            if (role === "toolResult") {
                if (applyToolResult(out, message)) continue;
                const toolCallId = str(message.toolCallId) ?? `call_${synthetic++}`;
                out.push({
                    id,
                    role: "assistant",
                    ts,
                    done: true,
                    blocks: [
                        {
                            type: "tool",
                            toolCallId,
                            name: str(message.toolName) ?? "tool",
                            state: message.isError === true ? "error" : "done",
                            output: {
                                text: textOfContent(message.content),
                                ...(message.details !== undefined ? { details: message.details } : {}),
                                isError: message.isError === true,
                            },
                        },
                    ],
                });
                continue;
            }

            continue;
        }

        if (type === "custom" && str(raw.customType) === "pi2-todo") {
            const todo = normalizeTodo(raw.data);
            if (!todo) continue;
            out.push({
                id: str(raw.id) ?? `raw-${synthetic++}`,
                role: "system",
                ts: timestampOf(raw),
                blocks: [],
                done: true,
                todo,
            });
            continue;
        }

        if (type === "custom_message" && raw.display === true) {
            out.push({
                id: str(raw.id) ?? `raw-${synthetic++}`,
                role: "assistant",
                ts: timestampOf(raw),
                blocks: contentToBlocks(raw.content),
                done: true,
            });
        }
    }

    return out;
}

/** Live snapshot entries win over the same id from a historical page. */
export function mergeEntries(history: Entry[], live: Entry[]): Entry[] {
    if (!history.length) return live;
    if (!live.length) return history;
    const liveById = new Map(live.map((entry) => [entry.id, entry]));
    const merged: Entry[] = history.map((entry) => liveById.get(entry.id) ?? entry);
    const historical = new Set(history.map((entry) => entry.id));
    for (const entry of live) {
        if (!historical.has(entry.id)) merged.push(entry);
    }
    return merged;
}

/** Prepend an older page while never duplicating an id already rendered. */
export function prependUnique(existing: Entry[], older: Entry[]): Entry[] {
    const seen = new Set(existing.map((entry) => entry.id));
    const fresh = older.filter((entry) => !seen.has(entry.id));
    return fresh.length ? [...fresh, ...existing] : existing;
}

/** Normalize `{entries, cursor:{before,hasMore}}` (and older cursor spellings). */
export function normalizeEntriesPage(raw: unknown): EntriesPage {
    const record = rec(raw);
    const entries = (Array.isArray(raw) ? raw : arr(record?.entries ?? record?.items)).filter(
        (entry): entry is RawEntry => !!rec(entry),
    );
    const cursor = rec(record?.cursor);
    const next = rec(record?.nextCursor);
    const explicitHasMore = cursor?.hasMore ?? record?.hasMore;
    return {
        entries,
        cursor: {
            before: str(cursor?.before) ?? str(record?.before) ?? str(next?.before) ?? idOf(entries[0]),
            hasMore: explicitHasMore === true,
        },
    };
}

/** Extract the tail entries a snapshot may carry alongside the state. */
export function snapshotEntries(payload: unknown): RawEntry[] {
    const record = rec(payload);
    return arr(record?.entries).filter((entry): entry is RawEntry => !!rec(entry));
}

/** Normalize a todo list from a `pi2:todo` event or session state. */
export function normalizeTodos(value: unknown): TodoItem[] {
    return arr(value).map((raw) => {
        const item = rec(raw) ?? {};
        return {
            content: str(item.content) ?? "",
            status: item.status === "completed" || item.status === "in_progress" ? item.status : "pending",
            ...(typeof item.activeForm === "string" ? { activeForm: item.activeForm } : {}),
        };
    });
}
