import type { SessionState, Subagent } from "@protocol/types";

/**
 * The session tree the sidebar renders: workspace sessions nest under their
 * `parentId` (sub-sessions are separate rows of the same REST list), and a
 * manifest subagent only renders as a synthetic row when it has no row of its
 * own (the child session row always wins).
 *
 * Pure and React-free, so the shape is unit-testable without a DOM.
 */

export interface SessionTreeNode {
    kind: "session";
    session: SessionState;
    depth: number;
    children: TreeNode[];
    /** Number of children actually rendered, so a `(N)` badge matches the UI. */
    childCount: number;
    /** True when the row is hidden by the plugin's visibility policy. */
    hidden: boolean;
    /** Keep this row open even when the user folded it (selected/filtered descendant). */
    forcedOpen: boolean;
}

export interface SubagentTreeNode {
    kind: "subagent";
    /** The session that owns the manifest entry. */
    session: SessionState;
    subagent: Subagent;
    depth: number;
    children: TreeNode[];
    /** Number of children actually rendered, so a `(N)` badge matches the UI. */
    childCount: number;
    /** True when the row is hidden by the plugin's visibility policy. */
    hidden: boolean;
    /** Keep this row open even when the user folded it (search match below). */
    forcedOpen: boolean;
}

export type TreeNode = SessionTreeNode | SubagentTreeNode;

export interface SessionTreeOptions {
    /** Case-insensitive name needle; empty (or absent) means "no filter". */
    filter?: string;
    /** Render rows the plugin marked `visible: false`. */
    showHidden?: boolean;
    /** The routed session; always rendered, even when it is hidden/filtered out. */
    selectedId?: string | null;
}

/** Stable key for a node (manifest ids are not unique across sessions). */
export function treeNodeKey(node: TreeNode): string {
    return node.kind === "session" ? `s:${node.session.sessionId}` : `a:${node.session.sessionId}:${node.subagent.id}`;
}

/** Id a node addresses (`data-session-id` / `data-subagent-id`). */
export function treeNodeId(node: TreeNode): string {
    return node.kind === "session" ? node.session.sessionId : node.subagent.id;
}

/** Does this subtree contain `id` (used to expand the path to the routed row)? */
function containsNode(node: TreeNode, id: string): boolean {
    if (treeNodeId(node) === id) return true;
    return node.children.some((child) => containsNode(child, id));
}

function sessionLabel(session: SessionState): string {
    return session.name?.trim() || session.sessionId;
}

function subagentLabel(subagent: Subagent): string {
    return subagent.name?.trim() || subagent.id;
}

/**
 * The parent a row is grouped under, or `null` when it is a root.
 *
 * A `parentId` that is not in the list is promoted to a root (a filtered-out
 * parent must never lose its children), and a cycle is cut by rendering every
 * member of the cycle as a root.
 */
function effectiveParent(session: SessionState, index: Map<string, SessionState>): string | null {
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
 * Build the render tree for one workspace.
 *
 * Input order is preserved (never sorted): root sessions and siblings keep the
 * order the list delivered; a session's synthetic subagent rows follow its real
 * child sessions, in manifest order.
 */
export function buildSessionTree(sessions: SessionState[], options: SessionTreeOptions = {}): TreeNode[] {
    const showHidden = options.showHidden === true;
    const selectedId = options.selectedId ?? null;
    const needle = (options.filter ?? "").trim().toLowerCase();

    const index = new Map<string, SessionState>();
    for (const session of sessions) {
        // Duplicate ids (a list/payload race) must not render twice or key twice.
        if (!index.has(session.sessionId)) index.set(session.sessionId, session);
    }

    // Children grouped by their effective parent, in list order.
    const childSessions = new Map<string | null, SessionState[]>();
    for (const session of sessions) {
        if (index.get(session.sessionId) !== session) continue;
        const parentId = effectiveParent(session, index);
        const siblings = childSessions.get(parentId);
        if (siblings) siblings.push(session);
        else childSessions.set(parentId, [session]);
    }

    /**
     * Selection, search and ancestry; visibility is only one of the inputs.
     *
     * Selection overrides the visibility policy (a deep-linked hidden row always
     * renders) but NOT an explicit search: the filter is the user's intent and a
     * non-matching row stays out.
     */
    function keepRow(id: string, label: string, selfVisible: boolean, children: TreeNode[]): boolean {
        if (needle !== "") {
            // Search is an explicit intent: a matching hidden row IS shown.
            if (label.toLowerCase().includes(needle)) return true;
            return children.length > 0;
        }
        if (selectedId !== null && id === selectedId) return true;
        if (showHidden || selfVisible) return true;
        // Hidden, but kept because a rendered descendant needs its ancestor.
        return children.length > 0;
    }

    function buildSessionNode(session: SessionState, depth: number, path: Set<string>): SessionTreeNode | null {
        if (path.has(session.sessionId)) return null;
        const nextPath = new Set(path).add(session.sessionId);
        const children: TreeNode[] = [];
        for (const child of childSessions.get(session.sessionId) ?? []) {
            const node = buildSessionNode(child, depth + 1, nextPath);
            if (node) children.push(node);
        }
        for (const subagent of session.subagents ?? []) {
            const node = buildSubagentNode(session, subagent, depth + 1, nextPath);
            if (node) children.push(node);
        }
        const selfVisible = session.visible !== false;
        if (!keepRow(session.sessionId, sessionLabel(session), selfVisible, children)) return null;
        return {
            kind: "session",
            session,
            depth,
            children,
            childCount: children.length,
            hidden: !selfVisible,
            // A folded parent must still reveal the routed row or a search hit
            // inside it; otherwise the selection would silently disappear.
            forcedOpen:
                children.length > 0 &&
                (needle !== "" || (selectedId !== null && children.some((child) => containsNode(child, selectedId)))),
        };
    }

    function buildSubagentNode(
        session: SessionState,
        subagent: Subagent,
        depth: number,
        path: Set<string>,
    ): SubagentTreeNode | null {
        // Dedupe: a manifest entry with a session row of its own is that row.
        if (index.has(subagent.id) || path.has(subagent.id)) return null;
        const nextPath = new Set(path).add(subagent.id);
        const children: TreeNode[] = [];
        for (const child of subagent.children ?? []) {
            const node = buildSubagentNode(session, child, depth + 1, nextPath);
            if (node) children.push(node);
        }
        const selfVisible = subagent.visible !== false;
        if (!keepRow(subagent.id, subagentLabel(subagent), selfVisible, children)) return null;
        return {
            kind: "subagent",
            session,
            subagent,
            depth,
            children,
            childCount: children.length,
            hidden: !selfVisible,
            forcedOpen: children.length > 0 && needle !== "",
        };
    }

    const roots: TreeNode[] = [];
    const emptyPath = new Set<string>();
    for (const session of childSessions.get(null) ?? []) {
        const node = buildSessionNode(session, 0, emptyPath);
        if (node) roots.push(node);
    }
    return roots;
}
