/**
 * Tool name → kind, and the family glyph table.
 *
 * Single mapping table, ported verbatim from the prototype `core.js:13-36`
 * (design/CHAT-TOOL-RENDER.md §5). Anything unknown — including MCP
 * `mcp__server__tool` names — falls back to `generic`.
 */
import { Code, FileDiff, FileText, FolderSearch, GitBranch, Globe, Image, ListTodo, Search, SquareTerminal, Terminal } from "lucide-react";

import type { FamilyId, ToolIconComponent } from "./types";

export const KIND_OF: Record<string, FamilyId> = {
    bash: "shell",
    exec: "shell",
    shell: "shell",
    read: "read",
    edit: "write",
    write: "write",
    patch: "write",
    apply_patch: "write",
    edit_file: "write",
    multi_edit: "write",
    grep: "search",
    search: "search",
    find: "find",
    glob: "find",
    ls: "find",
    list_dir: "find",
    web_search: "web",
    web_fetch: "web",
    fetch_content: "web",
    source_check: "web",
    get_search_content: "web",
    web: "web",
    todo_write: "plan",
    update_plan: "plan",
    plan: "plan",
    dispatch_subagents: "subagent",
    list_subagents: "subagent",
    read_subagent: "subagent",
    poll_subagents: "subagent",
    wait_subagents: "subagent",
    list_batches: "subagent",
    stop_subagents: "subagent",
    vision: "vision",
    image: "vision",
    screenshot: "vision",
    task: "task",
    tasks: "task",
};

/** Family glyph (prototype `KIND_ICON`, `core.js:29-36`). */
export const KIND_ICON: Record<FamilyId, ToolIconComponent> = {
    shell: SquareTerminal,
    read: FileText,
    write: FileDiff,
    search: Search,
    find: FolderSearch,
    web: Globe,
    plan: ListTodo,
    subagent: GitBranch,
    task: Terminal,
    vision: Image,
    generic: Code,
};

/** Every registered kind, in prototype order (useful for `Record<FamilyId, …>` exhaustiveness). */
export const FAMILY_IDS: FamilyId[] = [
    "shell",
    "task",
    "read",
    "write",
    "search",
    "find",
    "web",
    "vision",
    "plan",
    "subagent",
    "generic",
];

/** `name` is trimmed + lowercased before lookup; unknown → `generic` (never throws). */
export function kindOf(name: unknown): FamilyId {
    const key = String(name ?? "").trim().toLowerCase();
    return KIND_OF[key] ?? "generic";
}

/** `mcp__slack__post` → `slack · post`; single segment → that segment; otherwise verbatim. */
export function humanName(name: unknown): string {
    const raw = String(name ?? "tool");
    if (raw.startsWith("mcp__")) {
        const parts = raw.slice(5).split("__").filter(Boolean);
        if (parts.length >= 2) return parts.join(" · ");
        if (parts.length === 1) return parts[0] ?? raw;
    }
    return raw;
}
