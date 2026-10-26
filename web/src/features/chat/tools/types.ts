/**
 * Tool call rendering — shared types.
 *
 * Port of the prototype `web/js/tool-render/core.js` DTO (design/CHAT-TOOL-RENDER.md
 * §2/§3/§6) to React. `FamilyId` covers all 11 registered kinds; the four kinds that
 * WS-E owns (web/vision/plan/subagent) currently resolve to the `generic` spec.
 */
import type { ComponentType, ReactNode } from "react";

/** 11 registered kinds (prototype `core.js:13-36`). */
export type FamilyId =
    | "shell"
    | "task"
    | "read"
    | "write"
    | "search"
    | "find"
    | "web"
    | "vision"
    | "plan"
    | "subagent"
    | "generic";

/** Canonical states after alias normalization (prototype `core.js:68-104`). */
export type ToolState =
    | "queued"
    | "running"
    | "done"
    | "failed"
    | "timeout"
    | "interrupted"
    | "rejected"
    | "cancelled";

/** Icon component shape — matches `@/components/icons` and Lucide's props. */
export type ToolIconComponent = ComponentType<{
    size?: number | string;
    strokeWidth?: number;
    className?: string;
}>;

/** `tool.text` — the generic text block; legacy `details` lands here too. */
export interface ToolText {
    lines?: string[] | null;
    totalLines?: number | null;
    truncated?: TruncatedInfo | boolean | null;
}

export interface TruncatedInfo {
    headLines?: number | null;
    tailLines?: number | null;
    total?: number | null;
}

/** `tool.result` — at least `{ error? }`; shell/task add exit codes and streams. */
export interface ToolResult {
    error?: string | null;
    stderr?: string | null;
    stdout?: string | null;
    exitCode?: number | null;
    truncated?: boolean | null;
    added?: number | null;
    removed?: number | null;
    lines?: number | null;
    taskId?: string | null;
    /** Legacy: structured `output.details` (generic family renders it as JSON). */
    details?: unknown;
    [key: string]: unknown;
}

export interface ToolMeta {
    exitCode?: number | null;
    lines?: number | null;
    bytes?: number | null;
    matches?: number | null;
    files?: number | null;
    entries?: number | null;
    images?: number | null;
    added?: number | null;
    removed?: number | null;
    http?: number | string | null;
    newFile?: boolean | null;
    range?: number[] | null;
    taskId?: string | null;
    [key: string]: unknown;
}

export interface DiffLine {
    /** `add` / `del` / anything else = `ctx`. */
    t?: string | null;
    old?: number | null;
    new?: number | null;
    text?: string | null;
}

export interface DiffHunk {
    header?: string | null;
    oldStart?: number | null;
    newStart?: number | null;
    lines?: DiffLine[] | null;
}

export interface DiffFile {
    path?: string | null;
    status?: "added" | "deleted" | "modified" | string | null;
    added?: number | null;
    removed?: number | null;
    hunks?: DiffHunk[] | null;
}

export interface DiffPayload {
    files: DiffFile[];
}

export interface SearchMatch {
    path?: string | null;
    line?: number | null;
    col?: number | null;
    text?: string | null;
}

export interface FsEntry {
    name?: string | null;
    type?: "file" | "dir" | "directory" | string | null;
    size?: number | null;
}

export interface ToolSource {
    title?: string | null;
    url?: string | null;
    domain?: string | null;
}

export interface ToolTodoItem {
    content?: string | null;
    status?: string | null;
    activeForm?: string | null;
}

export interface BatchItemPayload {
    ref?: string | null;
    name?: string | null;
    status?: string | null;
    error?: string | null;
    model?: string | null;
    thinking?: string | null;
    durationMs?: number | null;
}

export interface BatchSummaryPayload {
    total?: number | null;
    done?: number | null;
    ok?: number | null;
    failed?: number | null;
    running?: number | null;
    cancelled?: number | null;
}

export interface BatchPayload {
    batchId?: string | null;
    id?: string | null;
    status?: string | null;
    summary?: BatchSummaryPayload | null;
    durationMs?: number | null;
    items?: BatchItemPayload[] | null;
}

export interface ToolImage {
    src: string;
    alt?: string | null;
}

/**
 * Normalized tool view — the single input of `ToolRow`.
 * Built by `fromPi2Block()` (daemon DTO) or by the host (already-normalized data).
 */
export interface ToolView {
    /** `toolCallId` — stable React key / `data-tool`. */
    id: string;
    /** Owning message id (prototype `.tool__body#tb-{msgId}`). */
    messageId?: string;
    name: string;
    kind?: FamilyId;
    /** Loose on purpose: `stateOf()` normalizes 20 aliases. */
    state?: string;
    startedAt?: number;
    durationMs?: number;
    agent?: string;
    inline?: boolean;
    input?: Record<string, unknown>;
    /** Non-object `args` (legacy DTO) preserved for the generic family. */
    raw?: unknown;
    text?: ToolText;
    result?: ToolResult;
    /** Legacy: plain-text summary used as a target fallback. */
    summary?: string;
    /** Legacy: plain text, degraded to `text.lines` by `normalizeTool()`. */
    details?: string;
    diff?: DiffPayload;
    matches?: SearchMatch[];
    files?: string[];
    entries?: FsEntry[];
    sources?: ToolSource[];
    todos?: ToolTodoItem[];
    batch?: BatchPayload;
    images?: ToolImage[];
    meta?: ToolMeta;
}

/** One `.tool__meta` fact: plain text, `+N −M` stat or a badge tag. */
export type Fact =
    | { kind: "text"; text: string }
    | { kind: "stat"; added: number; removed: number }
    | { kind: "tag"; label: string };

export interface ToolAction {
    icon: ToolIconComponent;
    labelKey: string;
    onAction: () => void;
    danger?: boolean;
}

export interface ToolCtx {
    onOpenSubagent?: (name: string) => void;
    onStopTask?: (taskId: string) => void;
    onRetry?: (tool: ToolView) => void;
}

export interface ToolBodyProps {
    tool: ToolView;
    ctx: ToolCtx;
}

export interface ToolSpec {
    id: FamilyId;
    /** Family glyph; falls back to `KIND_ICON[id]`. */
    icon?: ToolIconComponent;
    /** No caret, no `aria-expanded`, no `.tool__body` (`<div>` head). */
    inline?: boolean;
    /** i18n base key, e.g. `"shell"` → `chat.tv.shell.done`, or a per-tool mapper. */
    verb: string | ((tool: ToolView) => string);
    target?: (tool: ToolView) => string;
    meta?: (tool: ToolView) => Fact[];
    error?: (tool: ToolView) => string | null;
    actions?: (tool: ToolView, ctx: ToolCtx) => ToolAction[];
    /**
     * Lazy body render function. Called at most once per opened row and guarded by
     * `try/catch`, so it must not call hooks itself — put hooks in the element it
     * returns (`<ShellBody … />`).
     */
    Body?: (props: ToolBodyProps) => ReactNode;
}

export interface ToolRowProps {
    tool: ToolView;
    ctx?: ToolCtx;
    defaultOpen?: boolean;
}
