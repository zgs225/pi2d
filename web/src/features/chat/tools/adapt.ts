/**
 * DTO adapter: daemon `Block` → normalized `ToolView`.
 *
 * pi2d ships `{toolCallId, name, args, output, state, durationMs}`
 * (`src/protocol/types.ts`), while the tool-render contract speaks
 * `{input, text, result, diff, matches, …}`. This is the single translation layer;
 * everything downstream (`ToolRow`, families) only sees `ToolView`.
 */
import type { Block, ToolOutput } from "@protocol/types";

import { fileDiff } from "../diff";
import { splitLines } from "./format";
import { kindOf } from "./kind";
import { stateOf } from "./state";
import type { DiffFile, DiffHunk, DiffLine, DiffPayload, ToolMeta, ToolResult, ToolState, ToolView } from "./types";

export type ToolBlock = Extract<Block, { type: "tool" }>;

export interface AdaptOptions {
    /** Agent that issued the call (subagent runs) → `chat.meta.agent` fact. */
    agent?: string;
    /** Message timestamp — used as `startedAt` while the call is running. */
    ts?: number;
    /** Explicit elapsed start, overriding `ts`. */
    startedAt?: number;
}

/** pi2d's 4 wire states → the canonical state vocabulary. */
const WIRE_STATE: Record<string, ToolState> = {
    pending: "queued",
    running: "running",
    done: "done",
    error: "failed",
};

const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename"];
const BEFORE_KEYS = ["oldText", "old_string", "oldString", "before", "original"];
const AFTER_KEYS = ["newText", "new_string", "newString", "after", "content", "replacement"];

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "string" && value !== "") return value;
    }
    return undefined;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
}

/** Repo diff line (`"@@ -12,3 +12,4 @@"` + `+/-/ ` prefixed text) → numbered payload line. */
function toPayloadHunk(hunk: { header?: string; lines?: string[] }): DiffHunk {
    const header = String(hunk.header ?? "");
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
    let oldLine = Number(match?.[1] ?? 1);
    let newLine = Number(match?.[2] ?? 1);
    const lines: DiffLine[] = (hunk.lines ?? []).map((raw) => {
        const sign = raw.slice(0, 1);
        const text = raw.slice(1);
        if (sign === "+") {
            const line: DiffLine = { t: "add", old: null, new: newLine, text };
            newLine += 1;
            return line;
        }
        if (sign === "-") {
            const line: DiffLine = { t: "del", old: oldLine, new: null, text };
            oldLine += 1;
            return line;
        }
        const line: DiffLine = { t: "ctx", old: oldLine, new: newLine, text };
        oldLine += 1;
        newLine += 1;
        return line;
    });
    return {
        header,
        oldStart: Number(match?.[1] ?? 1),
        newStart: Number(match?.[2] ?? 1),
        lines,
    };
}

/**
 * Best-effort diff for edit-style calls. pi2d never sends a structured diff, so we
 * rebuild one from the before/after snippets when the arguments carry them; calls
 * without them keep `diff` undefined and the family renders `.diff__empty`.
 */
export function diffFromArgs(args: Record<string, unknown> | undefined): DiffPayload | undefined {
    if (!args) return undefined;

    const direct = args.diff ?? args.patch;
    if (isRecord(direct) && Array.isArray(direct.files)) {
        const files = (direct.files as unknown[]).filter(isRecord).map<DiffFile>((file) => ({
            path: String(file.path ?? file.file ?? ""),
            status: typeof file.status === "string" ? file.status : "modified",
            added: firstNumber(file, ["added", "add"]),
            removed: firstNumber(file, ["removed", "del"]),
            hunks: Array.isArray(file.hunks)
                ? (file.hunks as unknown[]).filter(isRecord).map((hunk) => toPayloadHunk(hunk as { header?: string; lines?: string[] }))
                : [],
        }));
        return files.length ? { files } : undefined;
    }

    const path = firstString(args, PATH_KEYS);
    if (!path) return undefined;
    const before = firstString(args, BEFORE_KEYS);
    const after = firstString(args, AFTER_KEYS);
    if (before === undefined && after === undefined) return undefined;

    const diff = fileDiff(path, before ?? "", after ?? "");
    return {
        files: [
            {
                path,
                status: before === undefined ? "added" : "modified",
                added: diff.add,
                removed: diff.del,
                hunks: diff.hunks.map((hunk) => toPayloadHunk(hunk)),
            },
        ],
    };
}

function textFromOutput(output: ToolOutput | undefined): { lines?: string[]; error?: string; details?: unknown } {
    const text = typeof output?.text === "string" ? output.text : "";
    const details = output?.details;
    const legacy = typeof details === "string" ? details : "";

    const source = text || legacy;
    const lines = source ? splitLines(source) : undefined;
    const error = output?.isError && source.trim() ? source : undefined;
    return { lines, error, details };
}

/** `(block, messageId) => ToolView` — the exit contract other workstreams use. */
export function fromPi2Block(block: ToolBlock, messageId: string, options: AdaptOptions = {}): ToolView {
    const state = WIRE_STATE[String(block.state ?? "")] ?? stateOf({ state: block.state });
    const args = isRecord(block.args) ? block.args : undefined;
    const { lines, error, details } = textFromOutput(block.output);

    const result: ToolResult = {};
    if (error) result.error = error;
    if (details !== undefined && !isRecord(details)) result.details = details;

    const meta: ToolMeta = {};
    if (isRecord(details)) {
        // Structured `details` (e.g. `{exitCode, truncated, added}`) is a legacy
        // result carrier; surface the facts families know how to render.
        result.details = details;
        const exitCode = firstNumber(details, ["exitCode", "code"]);
        if (exitCode != null) {
            result.exitCode = exitCode;
            meta.exitCode = exitCode;
        }
        if (details.truncated === true) result.truncated = true;
        const added = firstNumber(details, ["added"]);
        const removed = firstNumber(details, ["removed"]);
        if (added != null) meta.added = added;
        if (removed != null) meta.removed = removed;
    }
    if (isRecord(args?.meta)) Object.assign(meta, args.meta);

    const startedAt = options.startedAt ?? options.ts;
    const view: ToolView = {
        id: block.toolCallId || messageId,
        messageId,
        name: block.name,
        kind: kindOf(block.name),
        state,
        durationMs: block.durationMs,
        input: args,
        result: Object.keys(result).length ? result : undefined,
        meta: Object.keys(meta).length ? meta : undefined,
        diff: diffFromArgs(args),
    };
    if (state === "running" && startedAt) view.startedAt = startedAt;
    if (options.agent) view.agent = options.agent;
    if (typeof block.args === "string" && lines) {
        // Legacy `args` that is not an object still renders in the generic body.
        view.raw = lines.length === 1 ? (lines[0] ?? "") : lines;
    } else if (block.args !== undefined && !args) {
        view.raw = block.args;
    }
    if (lines?.length) view.text = { lines };
    return view;
}
