/**
 * Pure formatting helpers — `durShort` / `fileTarget` / `domainOf` / `tpNum`
 * (prototype `core.js:126-193`), plus the number and text utilities the tool
 * families share. No React, no DOM writes (except the clipboard helper).
 */
import i18n, { plural } from "@/lib/i18n";

import { humanName } from "./kind";
import type { ToolView } from "./types";

/** Translate through the shared i18next instance (keys are flat + dotted). */
export function tr(key: string, params?: Record<string, unknown>): string {
    return String(i18n.t(key, params ?? {}));
}

/** Grouped counts, mirroring the prototype `App.fmt.num` (`860`, `12.3k`, `1.2M`). */
export function fmtNum(n: number): string {
    const value = Number.isFinite(n) ? n : 0;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
    return String(value);
}

/**
 * Plural-aware count: picks `key.one` / `key.other` through `Intl.PluralRules`
 * and falls back to the base key (prototype `I18N.plural`, `i18n.js:1394-1400`).
 */
export function tpNum(key: string, n: number): string {
    return plural(key, n, { n: fmtNum(n) });
}

/** Compact duration: `<0.1s` / `340ms` → `0.3s` / `1.2s` / `12s` / `2m 5s`. */
export function durShort(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms)) return "";
    if (ms < 100) return "<0.1s";
    if (ms < 1_000) return `${(Math.max(0, ms) / 1_000).toFixed(1)}s`;
    if (ms < 60_000) {
        const seconds = ms / 1_000;
        return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))}s`;
    }
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1_000);
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function domainOf(url: unknown): string {
    const raw = String(url ?? "");
    try {
        return new URL(raw).hostname.replace(/^www\./, "");
    } catch {
        return raw.replace(/^https?:\/\//, "").split("/")[0] ?? raw;
    }
}

export function firstLine(value: unknown): string {
    if (value == null) return "";
    return String(value).split("\n")[0]?.trim() ?? "";
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The one "human intent" label of a row: path (`path:offset-limit`), pattern,
 * query, domain, command, … falling back to the legacy `summary` and finally the
 * humanized tool name (prototype `core.js:153-175`).
 */
export function fileTarget(tool: ToolView): string {
    const input = tool.input ?? {};
    const path = str(input.path);
    const range = Array.isArray(tool.meta?.range) ? tool.meta?.range : null;
    if (path && range && range.length >= 2) return `${path}:${range[0]}–${range[1]}`;

    const offset = num(input.offset);
    if (path && offset) {
        const limit = num(input.limit);
        const end = limit ? offset + limit - 1 : null;
        return `${path}:${offset}${end ? `–${end}` : "+"}`;
    }
    const pattern = str(input.pattern);
    if (pattern && path) return `“${pattern}” · ${path}`;
    if (pattern) return `“${pattern}”`;
    const query = str(input.query);
    if (query) return `“${query}”`;
    const claim = str(input.claim);
    if (claim) return `“${claim}”`;
    const url = str(input.url);
    if (url) return domainOf(url);
    if (path) return path;
    const command = str(input.command);
    if (command) return command.split("\n")[0] ?? command;
    const target = str(input.target);
    if (target) return target;
    const taskId = str(input.taskId);
    if (taskId) return taskId;
    const batchId = str(input.batchId);
    if (batchId) return batchId;
    // §6 legacy DTO: no structured input → fall back to the old summary text.
    if (tool.summary) return String(tool.summary);
    return humanName(tool.name);
}

/** Best-effort clipboard write; silently no-ops in non-secure contexts / SSR. */
export function copyText(text: string | null | undefined): void {
    if (!text) return;
    try {
        void navigator.clipboard?.writeText(String(text));
    } catch {
        /* clipboard unavailable (http, private mode) */
    }
}

export function splitLines(text: string): string[] {
    if (!text) return [];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
}
