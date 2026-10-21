import type { Block, ThinkingLevel } from "@protocol/types";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock label used in message metadata (`HH:MM`). */
export function formatClock(ts: number): string {
    if (!Number.isFinite(ts) || ts <= 0) return "—";
    const locale = typeof document !== "undefined" && document.documentElement.lang ? document.documentElement.lang : "en-US";
    let formatter = clockFormatters.get(locale);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
        clockFormatters.set(locale, formatter);
    }
    return formatter.format(new Date(ts));
}

/** Compact duration (`350ms`, `1.2s`, `2m 05s`) matching `App.fmt.dur`. */
export function formatDuration(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 1_000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) {
        const seconds = ms / 1_000;
        return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
    }
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1_000);
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function truncate(value: string, max = 120): string {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length <= max) return clean;
    return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function argsOf(block: Block): Record<string, unknown> {
    if (block.type !== "tool" || !block.args || typeof block.args !== "object") return {};
    return block.args as Record<string, unknown>;
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = args[key];
        if (typeof value === "string" && value.trim()) return value;
    }
    return undefined;
}

/** One-line tool summary (path/command/pattern) for the collapsed card. */
export function toolSummary(block: Extract<Block, { type: "tool" }>): string {
    const args = argsOf(block);
    const named =
        firstString(args, ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "task"]) ??
        firstString(args, ["description", "prompt"]);
    if (named) return truncate(named);
    const output = block.output?.text;
    if (output) return truncate(output);
    return "";
}

export function toolArgsText(block: Extract<Block, { type: "tool" }>): string {
    if (!block.args || typeof block.args !== "object") return "";
    try {
        return JSON.stringify(block.args, null, 2);
    } catch {
        return String(block.args);
    }
}

export function toolOutputText(block: Extract<Block, { type: "tool" }>): string {
    const output = block.output;
    if (!output) return "";
    if (typeof output.text === "string" && output.text.trim()) return output.text;
    if (output.details !== undefined) {
        try {
            return JSON.stringify(output.details, null, 2);
        } catch {
            return String(output.details);
        }
    }
    return "";
}

export interface ToolDiffSource {
    path: string;
    before: string;
    after: string;
}

/** Best-effort before/after extraction for edit-style tool arguments. */
export function toolDiffSource(block: Extract<Block, { type: "tool" }>): ToolDiffSource | null {
    const args = argsOf(block);
    const details = block.output?.details;
    const path =
        firstString(args, ["path", "file_path", "filePath", "file", "filename"]) ??
        (details && typeof details === "object"
            ? firstString(details as Record<string, unknown>, ["path", "file_path", "file"])
            : undefined);
    if (!path) return null;
    const before = firstString(args, ["oldText", "old_string", "oldString", "before", "original"]);
    const after = firstString(args, ["newText", "new_string", "newString", "after", "content", "replacement"]);
    if (before === undefined && after === undefined) return null;
    return { path, before: before ?? "", after: after ?? "" };
}

export function blocksText(blocks: Block[]): string {
    return blocks
        .map((block) => {
            if (block.type === "text" || block.type === "error") return block.text;
            if (block.type === "thinking") return block.text;
            return "";
        })
        .filter(Boolean)
        .join("\n\n");
}
