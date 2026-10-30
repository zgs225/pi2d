/**
 * Workspace picker ordering and search (chat sidebar, `.ws-menu`).
 *
 * The picker answers "which workspace was I in last?", so it lists rows by
 * **recent use**, in this precedence order:
 *
 * 1. a browser-local "last opened here" stamp (`pi2-workspace-recency`), written
 *    whenever a workspace becomes the active one in the console;
 * 2. the daemon's `lastActiveAt` (mtime of the workspace's newest session file),
 *    which carries across devices and survives a cleared browser profile;
 * 3. alphabetical, then by id — a deterministic order for never-touched rows.
 *
 * Ordering is intentionally *not* pinned-first: the picker is a recency control,
 * the `/workspaces` page is the curated list.
 */

import type { WorkspaceInfo } from "@/lib/protocol";

/** `localStorage` key holding `{ [workspaceId]: epoch ms }`. */
export const WORKSPACE_RECENCY_KEY = "pi2-workspace-recency";

/** Upper bound on persisted rows; a picker never needs more history than this. */
const RECENCY_LIMIT = 60;

export type WorkspaceRecency = Record<string, number>;

/** Display label: name → directory basename → id. */
export function workspaceLabel(workspace: WorkspaceInfo): string {
    const name = workspace.name?.trim();
    if (name) return name;
    const cwd = workspace.cwd?.replace(/\/+$/, "");
    if (cwd) {
        const segments = cwd.split("/");
        const base = segments[segments.length - 1];
        if (base) return base;
    }
    return workspace.workspaceId;
}

/** `localStorage` read; any failure (private mode, corrupt JSON) means "no history". */
export function readWorkspaceRecency(): WorkspaceRecency {
    try {
        const raw = localStorage.getItem(WORKSPACE_RECENCY_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const out: WorkspaceRecency = {};
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === "number" && Number.isFinite(value)) out[id] = value;
        }
        return out;
    } catch {
        return {};
    }
}

/** Stamp `workspaceId` as used now and persist; returns the updated map. */
export function markWorkspaceUsed(workspaceId: string, at: number = Date.now()): WorkspaceRecency {
    if (!workspaceId) return readWorkspaceRecency();
    const next: WorkspaceRecency = { ...readWorkspaceRecency(), [workspaceId]: at };
    const trimmed = Object.entries(next)
        .sort((a, b) => b[1] - a[1])
        .slice(0, RECENCY_LIMIT);
    const out = Object.fromEntries(trimmed);
    try {
        localStorage.setItem(WORKSPACE_RECENCY_KEY, JSON.stringify(out));
    } catch {
        // private mode / quota: ordering still works for this render
    }
    return out;
}

/** Recency score of one row: the later of local use and daemon activity. */
export function workspaceRecency(workspace: WorkspaceInfo, recency: WorkspaceRecency = {}): number {
    const local = recency[workspace.workspaceId] ?? 0;
    const remote = workspace.lastActiveAt ?? 0;
    return Math.max(local, remote);
}

/** Most-recently-used first, with a stable alphabetical fallback. */
export function compareByRecentUse(
    a: WorkspaceInfo,
    b: WorkspaceInfo,
    recency: WorkspaceRecency = {},
): number {
    const delta = workspaceRecency(b, recency) - workspaceRecency(a, recency);
    if (delta !== 0) return delta;
    const byName = workspaceLabel(a).localeCompare(workspaceLabel(b), undefined, { sensitivity: "base" });
    if (byName !== 0) return byName;
    return a.workspaceId.localeCompare(b.workspaceId);
}

/** Sort a copy; the caller's array is never mutated. */
export function sortByRecentUse(
    workspaces: readonly WorkspaceInfo[],
    recency: WorkspaceRecency = {},
): WorkspaceInfo[] {
    return workspaces.slice().sort((a, b) => compareByRecentUse(a, b, recency));
}

/** Split a raw query into lower-cased terms (empty when nothing was typed). */
export function searchTerms(query: string): string[] {
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 0);
}

/** Fields a workspace is searchable by, lower-cased and deduped. */
function haystack(workspace: WorkspaceInfo): string[] {
    const cwd = workspace.cwd ?? "";
    const base = workspaceLabel(workspace);
    const fields = [base, workspace.name ?? "", workspace.alias ?? "", cwd, workspace.workspaceId];
    const tail = cwd.replace(/\/+$/, "").split("/").pop();
    if (tail) fields.push(tail);
    return [...new Set(fields.map((field) => field.toLowerCase()).filter((field) => field.length > 0))];
}

/** Every term must hit some field (name, alias, cwd, basename or id). */
export function workspaceMatches(workspace: WorkspaceInfo, terms: readonly string[]): boolean {
    if (!terms.length) return true;
    const fields = haystack(workspace);
    return terms.every((term) => fields.some((field) => field.includes(term)));
}

/** Filter a (already sorted) list; ordering is preserved. */
export function searchWorkspaces(
    workspaces: readonly WorkspaceInfo[],
    query: string,
): WorkspaceInfo[] {
    const terms = searchTerms(query);
    if (!terms.length) return workspaces.slice();
    return workspaces.filter((workspace) => workspaceMatches(workspace, terms));
}
