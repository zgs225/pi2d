import type { SessionState, Subagent } from "@protocol/types";

import { compareSiblings, effectiveParentOf, orderSessions } from "./session-order";
import { sessionTitle, subagentTitle } from "./session-title";

/**
 * The session tree the sidebar renders: workspace sessions nest under their
 * `parentId` (sub-sessions are separate rows of the same REST list), and a
 * manifest subagent only renders as a synthetic row when it has no row of its
 * own (the child session row always wins).
 *
 * Pure and React-free, so the shape is unit-testable without a DOM.
 *
 * Two independent filters feed the tree (v0.1.1 Chat IA v3):
 *
 * - `activeOnly` — the IA lens ("only live rows", persisted as `pi2-active-only`).
 * - `showHidden` — the plugin's `:PiSessions` visibility policy (`visible:false`).
 *
 * They are NOT the same boolean: one is a user preference, the other is data the
 * daemon already filtered for us.
 */

export interface SessionTreeNode {
    kind: "session";
    session: SessionState;
    depth: number;
    children: TreeNode[];
    /** Number of children actually rendered. */
    childCount: number;
    /** True when the row is hidden by the plugin's visibility policy. */
    hidden: boolean;
    /** Keep this row open even when the user folded it (selected/filtered descendant). */
    forcedOpen: boolean;
    /** Direct children dropped by `activeOnly` (rendered as `+N`). */
    hiddenCount: number;
}

export interface SubagentTreeNode {
    kind: "subagent";
    /** The session that owns the manifest entry. */
    session: SessionState;
    subagent: Subagent;
    depth: number;
    children: TreeNode[];
    /** Number of children actually rendered. */
    childCount: number;
    /** True when the row is hidden by the plugin's visibility policy. */
    hidden: boolean;
    /** Keep this row open even when the user folded it (search match below). */
    forcedOpen: boolean;
    /** Direct children dropped by `activeOnly` (rendered as `+N`). */
    hiddenCount: number;
}

export type TreeNode = SessionTreeNode | SubagentTreeNode;

export interface SessionTreeOptions {
    /** Case-insensitive needle over session name / model id; empty means "no filter". */
    filter?: string;
    /** Render rows the plugin marked `visible: false`. */
    showHidden?: boolean;
    /** The routed session; always rendered, even when it is hidden/filtered out. */
    selectedId?: string | null;
    /**
     * IA lens: drop rows whose process is gone (see `isSessionActive` /
     * `isSubagentActive`). Defaults to `false` so the model stays usable for
     * callers that do their own filtering.
     */
    activeOnly?: boolean;
    /** Subagent shown in the child view: it and its ancestors stay visible. */
    viewingSubagentId?: string | null;
}

export interface SessionTreeView {
    roots: TreeNode[];
    /** Root sessions dropped by `activeOnly` — the `.tree-hidden` "N hidden" count. */
    hiddenSessions: number;
    /** Rows (any depth) dropped by the plugin's `visible:false` policy. */
    hiddenByPolicy: number;
    /** Manifest path (root → viewing subagent) of the child view, empty when none. */
    viewingPath: string[];
}

/** Stable key for a node (manifest ids are not unique across sessions). */
export function treeNodeKey(node: TreeNode): string {
    return node.kind === "session" ? `s:${node.session.sessionId}` : `a:${node.session.sessionId}:${node.subagent.id}`;
}

/** Id a node addresses (`data-session-id` / `data-subagent-id`). */
export function treeNodeId(node: TreeNode): string {
    return node.kind === "session" ? node.session.sessionId : node.subagent.id;
}

/* ------------------------------------------------------------------ */
/* Active-row predicates (pure, unit-tested)                           */
/* ------------------------------------------------------------------ */

/**
 * A session is "active" while its process is alive. The design excludes the
 * three terminal states; `done`/`exited`/`dormant` rows only reappear through
 * "show all sessions".
 */
export function isSessionActive(session: Pick<SessionState, "status">): boolean {
    return !["done", "exited", "dormant"].includes(session.status);
}

/**
 * A subagent is "active" when the user may still act on it — a failed or
 * interrupted subagent stays reachable, a completed/dormant one does not.
 */
export function isSubagentActive(subagent: Pick<Subagent, "status">): boolean {
    return ["active", "interrupted", "failed"].includes(subagent.status);
}

/**
 * Is `id` on the path to the subagent being viewed (itself or an ancestor)?
 *
 * The child view must keep its own row reachable no matter how aggressive the
 * `activeOnly` lens is — a completed subagent you are reading stays in the tree.
 */
export function isOnCurrentSubPath(id: string, path: readonly string[]): boolean {
    return path.includes(id);
}

/** Manifest path (root → `id`) to a nested subagent; `[]` when it is not there. */
export function subagentPath(list: Subagent[] | undefined, id: string | null): Subagent[] {
    if (!id) return [];
    for (const subagent of list ?? []) {
        if (subagent.id === id) return [subagent];
        const nested = subagentPath(subagent.children, id);
        if (nested.length) return [subagent, ...nested];
    }
    return [];
}

/** Ids of the viewing subagent and its ancestors, for `isOnCurrentSubPath`. */
export function subagentPathIds(list: Subagent[] | undefined, id: string | null): string[] {
    return subagentPath(list, id).map((subagent) => subagent.id);
}

/* ------------------------------------------------------------------ */
/* Tree building                                                       */
/* ------------------------------------------------------------------ */

/** Does this subtree contain `id` (used to expand the path to the routed row)? */
function containsNode(node: TreeNode, id: string): boolean {
    if (treeNodeId(node) === id) return true;
    return node.children.some((child) => containsNode(child, id));
}

/**
 * English search phrases: the model is React-free, so it must not depend on
 * i18n. Searching matches the rendered label *and* the raw id, which keeps a
 * session findable even though an id is never displayed as its title.
 */
const SEARCH_PHRASES = { unnamed: "(unnamed)", subagentUnnamed: "sub-session" };

function sessionLabel(session: SessionState): string {
    return sessionTitle(session, SEARCH_PHRASES).text;
}

function subagentLabel(subagent: Subagent): string {
    return subagentTitle(subagent, SEARCH_PHRASES).text;
}

/** Search matches the session/subagent name or its model id (prototype behaviour). */
function matches(label: string, model: string | undefined, needle: string): boolean {
    if (needle === "") return true;
    return label.toLowerCase().includes(needle) || (model ?? "").toLowerCase().includes(needle);
}

/**
 * Build the render tree for one workspace.
 *
 * Input is put into canonical order first (roots by tab rank asc, siblings by
 * createdAt desc then id asc, per pi2.nvim `:PiSessions`), and only then grouped:
 * a session's real child sessions and synthetic manifest subagent rows are merged
 * into one sorted sibling list (real child sessions win over same-id subagents).
 */
export function buildSessionTreeView(
    sessions: SessionState[],
    options: SessionTreeOptions = {},
): SessionTreeView {
    const showHidden = options.showHidden === true;
    const activeOnly = options.activeOnly === true;
    const selectedId = options.selectedId ?? null;
    const needle = (options.filter ?? "").trim().toLowerCase();

    const ordered = orderSessions(sessions);
    const index = new Map<string, SessionState>();
    for (const session of ordered) {
        index.set(session.sessionId, session);
    }

    let hiddenByPolicy = 0;

    // Children grouped by their effective parent, in canonical order.
    const childSessions = new Map<string | null, SessionState[]>();
    for (const session of ordered) {
        const parentId = effectiveParentOf(session, index);
        const siblings = childSessions.get(parentId);
        if (siblings) siblings.push(session);
        else childSessions.set(parentId, [session]);
    }

    /** Viewing subagent + ancestors: always kept when `activeOnly` hides them. */
    const viewingPath = activeOnly
        ? subagentPathIds(selectedId ? index.get(selectedId)?.subagents : undefined, options.viewingSubagentId ?? null)
        : [];

    /**
     * Session keep decision. Precedence: search (explicit intent) > routed row >
     * active lens > plugin policy > "an kept descendant needs the ancestor".
     */
    function keepSession(session: SessionState, childCount: number): boolean {
        if (needle !== "") {
            return (
                matches(sessionLabel(session), session.model?.id, needle) ||
                session.sessionId.toLowerCase().includes(needle) ||
                childCount > 0
            );
        }
        if (selectedId !== null && session.sessionId === selectedId) return true;
        if (activeOnly && !isSessionActive(session)) return childCount > 0;
        if (session.visible === false) return showHidden || childCount > 0;
        return true;
    }

    function buildSessionNode(session: SessionState, depth: number, path: Set<string>): SessionTreeNode | null {
        if (path.has(session.sessionId)) return null;
        const nextPath = new Set(path).add(session.sessionId);
        const children: TreeNode[] = [];
        let hiddenCount = 0;

        type SiblingCandidate =
            | { kind: "session"; session: SessionState; id: string; createdAt?: number | null }
            | { kind: "subagent"; subagent: Subagent; id: string; createdAt?: number | null };

        const manifestById = new Map((session.subagents ?? []).map((s) => [s.id, s]));

        const candidates: SiblingCandidate[] = [
            ...(childSessions.get(session.sessionId) ?? []).map((child) => ({
                kind: "session" as const,
                session: child,
                id: child.sessionId,
                createdAt: manifestById.get(child.sessionId)?.createdAt ?? child.createdAt,
            })),
            ...(session.subagents ?? [])
                .filter((subagent) => !index.has(subagent.id))
                .map((subagent) => ({
                    kind: "subagent" as const,
                    subagent,
                    id: subagent.id,
                    createdAt: subagent.createdAt,
                })),
        ];
        candidates.sort(compareSiblings);

        for (const candidate of candidates) {
            if (candidate.kind === "session") {
                const node = buildSessionNode(candidate.session, depth + 1, nextPath);
                if (node) children.push(node);
                else if (activeOnly && needle === "" && candidate.session.visible !== false) hiddenCount += 1;
            } else {
                const node = buildSubagentNode(session, candidate.subagent, depth + 1, nextPath);
                if (node) children.push(node);
                else if (activeOnly && needle === "" && !isSubagentActive(candidate.subagent) && candidate.subagent.visible !== false) {
                    hiddenCount += 1;
                }
            }
        }
        if (!keepSession(session, children.length)) {
            if (needle === "" && session.visible === false) hiddenByPolicy += 1;
            return null;
        }
        return {
            kind: "session",
            session,
            depth,
            children,
            childCount: children.length,
            hidden: session.visible === false,
            // A folded parent must still reveal the routed row or a search hit
            // inside it; otherwise the selection would silently disappear.
            forcedOpen:
                children.length > 0 &&
                (needle !== "" ||
                    (selectedId !== null && children.some((child) => containsNode(child, selectedId))) ||
                    children.some((child) => viewingPath.includes(treeNodeId(child)))),
            hiddenCount,
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
        // The active lens never hides a row on the path to the child view.
        if (activeOnly && !isSubagentActive(subagent) && !isOnCurrentSubPath(subagent.id, viewingPath)) return null;
        const nextPath = new Set(path).add(subagent.id);
        const children: TreeNode[] = [];
        let hiddenCount = 0;
        const subChildren = [...(subagent.children ?? [])].sort(compareSiblings);
        for (const child of subChildren) {
            const node = buildSubagentNode(session, child, depth + 1, nextPath);
            if (node) children.push(node);
            else if (activeOnly && needle === "" && !isSubagentActive(child) && child.visible !== false) {
                hiddenCount += 1;
            }
        }
        if (subagent.visible === false) {
            // Policy-hidden row: kept by the show-hidden toggle, a search hit, the
            // routed row or a rendered descendant — never silently by default.
            const keep =
                showHidden ||
                selectedId === subagent.id ||
                children.length > 0 ||
                (needle !== "" &&
                    (matches(subagentLabel(subagent), subagent.model, needle) ||
                        subagent.id.toLowerCase().includes(needle)));
            if (!keep) {
                if (needle === "") hiddenByPolicy += 1;
                return null;
            }
        }
        // Search keeps only matching sessions; inside a kept session the
        // manifest rows are not filtered by the needle (prototype behaviour).
        return {
            kind: "subagent",
            session,
            subagent,
            depth,
            children,
            childCount: children.length,
            hidden: subagent.visible === false,
            forcedOpen: children.length > 0 && needle !== "",
            hiddenCount,
        };
    }

    const roots: TreeNode[] = [];
    let hiddenSessions = 0;
    const emptyPath = new Set<string>();
    for (const session of childSessions.get(null) ?? []) {
        const node = buildSessionNode(session, 0, emptyPath);
        if (node) roots.push(node);
        else if (activeOnly && needle === "" && session.visible !== false) hiddenSessions += 1;
    }
    return { roots, hiddenSessions, hiddenByPolicy, viewingPath };
}

/** Convenience wrapper for callers that only need the rows. */
export function buildSessionTree(sessions: SessionState[], options: SessionTreeOptions = {}): TreeNode[] {
    return buildSessionTreeView(sessions, options).roots;
}
