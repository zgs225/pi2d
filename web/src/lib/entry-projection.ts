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

/** Normalized plain text of an entry (the identity fallback below). */
function entryText(entry: Entry): string {
    const parts: string[] = [];
    for (const block of entry.blocks) {
        if (block.type === "text" || block.type === "error" || block.type === "thinking") parts.push(block.text);
    }
    return parts.join("\n").replace(/\s+/g, " ").trim();
}

/**
 * Exact identity: role, second-bucketed timestamp and normalized text.
 *
 * Kept for callers that want a cheap map key, but *not* used as the only
 * cross-source identity: the two sources derive `ts` from different clocks
 * (snapshot entries carry the plugin's event timestamp, projected pi entries
 * carry the message timestamp), so the same message can land in adjacent
 * buckets or seconds apart (see `matchIndex`).
 */
export function entrySignature(entry: Entry): string | null {
    const text = entryText(entry);
    if (!text) return null;
    return `${entry.role}|${Math.round(entry.ts / 1_000)}|${text}`;
}

/**
 * Timestamp distance as a ranking tie-break well below one tier step, so a
 * looser identity tier never outranks a tighter one.
 */
function skewScore(a: Entry, b: Entry): number {
    return Math.min(Math.abs(a.ts - b.ts), 60_000) / 120_000;
}

/**
 * Identity index over one side of a merge: exact id, exact `(role, ts, text)`
 * signature and `(role, text)`. Built once per merge so a re-render stays cheap.
 */
interface PoolIndex {
    items: Entry[];
    byId: Map<string, number[]>;
    bySignature: Map<string, number[]>;
    byText: Map<string, number[]>;
}

function indexPool(items: Entry[]): PoolIndex {
    const index: PoolIndex = { items, byId: new Map(), bySignature: new Map(), byText: new Map() };
    const add = (bucket: Map<string, number[]>, key: string, at: number) => {
        const list = bucket.get(key);
        if (list) list.push(at);
        else bucket.set(key, [at]);
    };
    items.forEach((entry, at) => {
        add(index.byId, entry.id, at);
        const signature = entrySignature(entry);
        if (signature !== null) add(index.bySignature, signature, at);
        const text = entryText(entry);
        if (text) add(index.byText, `${entry.role}|${text}`, at);
    });
    return index;
}

/**
 * Index of the entry in `index` that is the same message as `candidate`, or -1.
 *
 * The snapshot tail (synthetic `m<N>` ids, plugin event clock) and the REST
 * pages (pi's raw ids, message clock) describe the same transcript under
 * different ids *and* slightly different timestamps, so identity falls back to
 * `(role, normalized text)` with the closest timestamp winning. `isTaken` keeps
 * the pairing one-to-one, so two genuinely repeated messages never collapse
 * into one.
 */
function matchIndex(index: PoolIndex, candidate: Entry, isTaken: (at: number) => boolean): number {
    const signature = entrySignature(candidate);
    const text = entryText(candidate);

    // Collect every identity tier a pool entry reaches; the tightest one wins.
    const tiers = new Map<number, number>();
    const offer = (at: number, tier: number) => {
        const current = tiers.get(at);
        if (current === undefined || tier < current) tiers.set(at, tier);
    };
    for (const at of index.byId.get(candidate.id) ?? []) offer(at, 0);
    if (signature !== null) {
        for (const at of index.bySignature.get(signature) ?? []) offer(at, 1);
    }
    if (text) {
        for (const at of index.byText.get(`${candidate.role}|${text}`) ?? []) offer(at, 2);
    }

    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [at, tier] of tiers) {
        if (isTaken(at)) continue;
        const entry = index.items[at];
        if (!entry || entry.role !== candidate.role) continue;
        const score = tier + skewScore(entry, candidate);
        if (score < bestScore) {
            bestScore = score;
            best = at;
        }
    }
    return best;
}

/**
 * Live entries win over the same message from a historical page: by id first,
 * then by `(role, text)` when the ids differ (the snapshot carries synthetic
 * `m<N>` ids while the pages carry pi's raw entry ids). The historical position
 * is kept so the transcript never re-orders, and each message renders once.
 *
 * The two inputs are windows over the same transcript, not a page plus a tail:
 * the plugin's snapshot carries the whole (bounded) session, while the first
 * REST page is only the newest entries. A live entry without a counterpart is
 * therefore inserted where its neighbours put it — before the history entry of
 * the next match, or appended only when it follows every match. Appending all
 * unmatched entries instead would move messages older than the page to the end
 * of the stream, so the transcript would stop on an old message and the newest
 * ones (already spliced into the page) would sit far above.
 */
export function mergeEntries(history: Entry[], live: Entry[]): Entry[] {
    if (!history.length) return live;
    if (!live.length) return history;

    // Match from the live side so a live entry always claims its closest page
    // counterpart, even when the page holds several identical texts.
    const historyIndex = indexPool(history);
    const claimed = new Set<number>();
    const replaces = new Map<number, Entry>();
    /** Unmatched live entries keyed by the history index they precede (0..history.length). */
    const inserts = new Map<number, Entry[]>();
    let anchor = 0;
    for (const entry of live) {
        const match = matchIndex(historyIndex, entry, (at) => claimed.has(at));
        if (match < 0) {
            const bucket = inserts.get(anchor);
            if (bucket) bucket.push(entry);
            else inserts.set(anchor, [entry]);
            continue;
        }
        claimed.add(match);
        replaces.set(match, entry);
        anchor = Math.max(anchor, match + 1);
    }

    const merged: Entry[] = [];
    history.forEach((entry, index) => {
        const bucket = inserts.get(index);
        if (bucket) merged.push(...bucket);
        merged.push(replaces.get(index) ?? entry);
    });
    const trailing = inserts.get(history.length);
    if (trailing) merged.push(...trailing);
    return merged;
}

/**
 * Prepend an older page while never duplicating an entry already rendered —
 * by id, then by `(role, text)` — and keeping the page's own order.
 */
export function prependUnique(existing: Entry[], older: Entry[]): Entry[] {
    if (!older.length) return existing;
    // Each already-rendered entry absorbs at most one match from the page.
    const existingIndex = indexPool(existing);
    const claimed = new Set<number>();
    const fresh: Entry[] = [];
    for (const entry of older) {
        const match = matchIndex(existingIndex, entry, (at) => claimed.has(at));
        if (match >= 0) {
            claimed.add(match);
            continue;
        }
        fresh.push(entry);
    }
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
