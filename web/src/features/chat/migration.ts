/**
 * Session-id migration (`tmp-N` → the backend id).
 *
 * `session.create` answers with a provisional id, so the URL right after
 * "New session" is `/chat/tmp-1`. When the pi process starts it assigns the real
 * id and the plugin announces it on the **old** id:
 *
 *   pi2:session { session: { sessionId: "<new>", previousSessionId: "tmp-1" } }
 *
 * Everything the browser keyed by the old id (session row, history page, the
 * optimistic `sending` chip, REST paging metadata and the URL) has to move to
 * the new id, and the socket has to resubscribe — otherwise the page loses the
 * in-flight prompt and streams into a session nobody renders.
 */

import { useSessionsStore } from "@/stores/sessions";

import { remapSessionMeta } from "./history";
import { useChatStore } from "./store";

export interface SessionMigration {
    from: string;
    to: string;
    workspaceId?: string;
    /** `/chat/<to>?workspace=<ws>` — the URL that should replace the old one. */
    path: string;
    /** Fired after the stores were re-keyed. */
    ts: number;
}

type MigrationListener = (migration: SessionMigration) => void;

const listeners = new Set<MigrationListener>();

/** Subscribe to session-id migrations (returns the unsubscribe function). */
export function onSessionMigration(listener: MigrationListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** `/chat/<sessionId>` plus the workspace query, encoded for the router. */
export function chatSessionPath(sessionId: string, workspaceId?: string): string {
    const encoded = encodeURIComponent(sessionId);
    return workspaceId ? `/chat/${encoded}?workspace=${encodeURIComponent(workspaceId)}` : `/chat/${encoded}`;
}

/**
 * Replace the address bar in place (no navigation, no history entry, keeps the
 * router's `history.state`). Returns `true` when the current route addressed
 * the old session id, i.e. when the caller also has to sync the router.
 */
export function replaceChatUrl(from: string, to: string, workspaceId?: string): boolean {
    if (typeof window === "undefined" || !window.history?.replaceState) return false;
    const { pathname, search } = window.location;
    if (pathname !== `/chat/${from}` && pathname !== `/chat/${encodeURIComponent(from)}`) return false;
    const target = chatSessionPath(to, workspaceId) + (workspaceId ? "" : search);
    if (pathname + search !== target) {
        // `history.state` is the router's location state; dropping it would break
        // the next navigation, so pass it through untouched.
        window.history.replaceState(window.history.state, "", target);
    }
    return true;
}

/**
 * Move every render-cache slice from `from` to `to` and notify the page so it
 * can fix the URL and resubscribe. Idempotent: a repeat for the same pair is a
 * no-op.
 */
export function migrateSessionId(from: string, to: string, workspaceId?: string): SessionMigration | null {
    if (!from || !to || from === to) return null;

    useSessionsStore.getState().renameSessionId(from, to);
    useChatStore.getState().migrateSession(from, to);
    remapSessionMeta(from, to);

    const migration: SessionMigration = {
        from,
        to,
        ...(workspaceId ? { workspaceId } : {}),
        path: chatSessionPath(to, workspaceId),
        ts: Date.now(),
    };
    for (const listener of listeners) listener(migration);
    return migration;
}
