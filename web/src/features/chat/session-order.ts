import type { SessionState } from "@protocol/types";

/**
 * Canonical ordering for workspace session trees in the pi2d web console.
 *
 * Rules taken from pi2.nvim:
 * - Root order: visual tabline position of live attached tabs (`lua/pi/sessions/manager.lua`).
 *   A lineage occupies the earliest tab slot of the root and all its descendants (`lua/pi/ui/sessions.lua`),
 *   so in a child view the parent row occupies that tab's slot.
 * - Sibling order: children of the same parent (merged real child session rows and
 *   synthetic manifest subagents) are sorted by `createdAt` DESC (missing last),
 *   tie-break `id` ASC (`lua/pi/subsessions/manifest.lua`). Real session rows win over
 *   same-id subagents, but inherit the manifest entry's `createdAt`.
 *
 * Console-side determinism & edge-case additions:
 * - Tie-break chain: `createdAt` DESC (missing last) → `lastActiveAt` DESC (missing last) →
 *   `sessionId` ASC (plain code-unit comparison). In Neovim each session has at most one
 *   attached tab and ranks are distinct, so it needs no tie-break; the console defines this
 *   chain to ensure total, deterministic ordering across WS arrivals.
 * - Tab-less roots: Neovim's `Sessions.list()` excludes detached/tab-less sessions entirely.
 *   The console keeps a tab-less root when it is the parent of a live child-view tab (or
 *   an orphaned/promoted row); assigning it rank `+Infinity` (placed last) is a console rule.
 * - Rank unit: rows prefer `tabRank` (1-based visual tabline position in `nvim_list_tabpages()`),
 *   falling back to `tab` (creation-ordered tab handle). Handle order diverges from visual order
 *   after `:tabmove` or mid-tabline insertions (`:PiNewTab` from tab 1).
 * - Comparisons are plain code-unit `<`/`>` (never `localeCompare`) and numeric for
 *   timestamps, guaranteeing total, deterministic ordering.
 */

export interface SiblingItem {
    createdAt?: number | null;
    id: string;
}

/**
 * Effective parent id: the parent must exist in `index`, must not point to
 * itself, and must not form a parent-pointer cycle. Any invalid parent promotes
 * the session to a root so a row is never lost.
 */
export function effectiveParentOf(session: SessionState, index: Map<string, SessionState>): string | null {
    const parentId = session.parentId ?? null;
    if (!parentId || parentId === session.sessionId || !index.has(parentId)) return null;
    const seen = new Set<string>([session.sessionId]);
    let cursor: string | null = parentId;
    while (cursor) {
        if (seen.has(cursor)) return null;
        seen.add(cursor);
        const next: string | null = index.get(cursor)?.parentId ?? null;
        if (!next || next === cursor) break;
        cursor = next;
    }
    return parentId;
}

/**
 * Sibling comparator: `createdAt` DESC (missing last), tie-break `id` ASC.
 * Comparisons are plain string `<`/`>` (never `localeCompare`).
 */
export function compareSiblings(a: SiblingItem, b: SiblingItem): number {
    const ca = typeof a.createdAt === "number" && Number.isFinite(a.createdAt) ? a.createdAt : null;
    const cb = typeof b.createdAt === "number" && Number.isFinite(b.createdAt) ? b.createdAt : null;
    if (ca !== null && cb !== null) {
        if (ca !== cb) return cb - ca;
    } else if (ca !== null) {
        return -1;
    } else if (cb !== null) {
        return 1;
    }
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
}

function positiveNum(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Tab position rank for a single row: prefer visual tabline rank (`tabRank`, 1-based
 * position in `nvim_list_tabpages()`), fall back to tab handle (`tab`, creation-ordered).
 * Visual rank reflects `:tabmove` and mid-tabline insertions; handle is legacy fallback.
 */
function rowTabRank(session: SessionState): number | undefined {
    return positiveNum(session.tabRank) ?? positiveNum(session.tab);
}

/**
 * Calculate the rank of a root session: the earliest tab position occupied across
 * its whole lineage (root itself and all descendants), or `Infinity` if tab-less.
 * pi2.nvim places a lineage at its earliest live tab slot (`lua/pi/ui/sessions.lua`).
 */
function rootRank(session: SessionState, childSessions: Map<string | null, SessionState[]>): number {
    const ownRank = rowTabRank(session);

    let minTab = Infinity;
    const visited = new Set<string>([session.sessionId]);
    const stack = [...(childSessions.get(session.sessionId) ?? [])];
    while (stack.length > 0) {
        const child = stack.pop()!;
        if (visited.has(child.sessionId)) continue;
        visited.add(child.sessionId);
        const childRank = rowTabRank(child);
        if (childRank !== undefined && childRank < minTab) {
            minTab = childRank;
        }
        for (const grandchild of childSessions.get(child.sessionId) ?? []) {
            stack.push(grandchild);
        }
    }
    return Math.min(ownRank ?? Infinity, minTab);
}

/**
 * Compare two root sessions:
 * 1. `rank` ASC
 * 2. `createdAt` DESC (missing last)
 * 3. `lastActiveAt` DESC (missing last)
 * 4. `sessionId` ASC (code-unit comparison)
 */
function compareRoots(
    a: SessionState,
    b: SessionState,
    rankA: number,
    rankB: number,
): number {
    if (rankA !== rankB) {
        return rankA - rankB;
    }
    const ca = typeof a.createdAt === "number" && Number.isFinite(a.createdAt) ? a.createdAt : null;
    const cb = typeof b.createdAt === "number" && Number.isFinite(b.createdAt) ? b.createdAt : null;
    if (ca !== null && cb !== null) {
        if (ca !== cb) return cb - ca;
    } else if (ca !== null) {
        return -1;
    } else if (cb !== null) {
        return 1;
    }

    const la = typeof a.lastActiveAt === "number" && Number.isFinite(a.lastActiveAt) ? a.lastActiveAt : null;
    const lb = typeof b.lastActiveAt === "number" && Number.isFinite(b.lastActiveAt) ? b.lastActiveAt : null;
    if (la !== null && lb !== null) {
        if (la !== lb) return lb - la;
    } else if (la !== null) {
        return -1;
    } else if (lb !== null) {
        return 1;
    }

    if (a.sessionId < b.sessionId) return -1;
    if (a.sessionId > b.sessionId) return 1;
    return 0;
}

/**
 * Flatten sessions into canonical document order:
 * Each root (Rule 1: rank ASC, createdAt DESC, lastActiveAt DESC, sessionId ASC)
 * followed by its subtree in Rule 3 sibling order (createdAt DESC, id ASC).
 *
 * Input is deduped by `sessionId` (first wins) and cycle-guarded.
 */
export function orderSessions(sessions: readonly SessionState[]): SessionState[] {
    const index = new Map<string, SessionState>();
    const deduped: SessionState[] = [];
    for (const session of sessions) {
        if (!session.sessionId || index.has(session.sessionId)) continue;
        index.set(session.sessionId, session);
        deduped.push(session);
    }
    if (deduped.length === 0) return [];

    const childSessions = new Map<string | null, SessionState[]>();
    for (const session of deduped) {
        const parentId = effectiveParentOf(session, index);
        const list = childSessions.get(parentId);
        if (list) list.push(session);
        else childSessions.set(parentId, [session]);
    }

    const roots = [...(childSessions.get(null) ?? [])];
    const ranks = new Map<string, number>();
    for (const root of roots) {
        ranks.set(root.sessionId, rootRank(root, childSessions));
    }
    roots.sort((a, b) => compareRoots(a, b, ranks.get(a.sessionId)!, ranks.get(b.sessionId)!));

    for (const [parentId, children] of childSessions.entries()) {
        if (parentId === null) continue;
        children.sort((a, b) =>
            compareSiblings(
                { createdAt: a.createdAt, id: a.sessionId },
                { createdAt: b.createdAt, id: b.sessionId },
            ),
        );
    }

    const result: SessionState[] = [];
    const visited = new Set<string>();

    function appendSubtree(session: SessionState) {
        if (visited.has(session.sessionId)) return;
        visited.add(session.sessionId);
        result.push(session);
        const children = childSessions.get(session.sessionId) ?? [];
        for (const child of children) {
            appendSubtree(child);
        }
    }

    for (const root of roots) {
        appendSubtree(root);
    }

    return result;
}

/**
 * Return the top root session of the sidebar (for the `/chat` index default).
 */
export function firstRootSession(sessions: readonly SessionState[]): SessionState | undefined {
    const ordered = orderSessions(sessions);
    if (ordered.length === 0) return undefined;
    const index = new Map(ordered.map((s) => [s.sessionId, s]));
    return ordered.find((s) => effectiveParentOf(s, index) === null) ?? ordered[0];
}
