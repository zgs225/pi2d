import type { Entry } from "@protocol/types";
import { useCallback, useEffect } from "react";

import { apiRequest, ApiError } from "@/lib/api";
import { mergeEntries, normalizeEntriesPage, projectEntries } from "@/lib/entry-projection";
import { EMPTY_HISTORY, useChatStore, type HistoryState } from "./store";

export const HISTORY_PAGE_SIZE = 50;

export interface FetchedPage {
    entries: ReturnType<typeof projectEntries>;
    cursor: { before?: string; hasMore: boolean };
}

/**
 * Session metadata needed to page a session that is not live in an instance
 * (disk-only rows): the daemon routes by workspace and the plugin reads the file.
 * Populated from the sessions list, keyed by session id.
 */
const sessionMeta = new Map<string, { workspaceId?: string; sessionFile?: string }>();

export function setSessionMeta(
    sessionId: string,
    meta: { workspaceId?: string; sessionFile?: string },
): void {
    sessionMeta.set(sessionId, { ...sessionMeta.get(sessionId), ...meta });
}

/** `GET /api/v1/sessions/:sid/entries?before=&limit=&workspaceId=&sessionFile=` → raw pi entries + cursor. */
export async function fetchEntriesPage(
    sessionId: string,
    before?: string,
    limit = HISTORY_PAGE_SIZE,
    signal?: AbortSignal,
): Promise<FetchedPage> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set("before", before);
    const meta = sessionMeta.get(sessionId);
    if (meta?.workspaceId) query.set("workspaceId", meta.workspaceId);
    if (meta?.sessionFile) query.set("sessionFile", meta.sessionFile);
    const raw = await apiRequest<unknown>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/entries?${query.toString()}`,
        { signal },
    );
    const page = normalizeEntriesPage(raw);
    return { entries: projectEntries(page.entries), cursor: page.cursor };
}

/** Monotonic guard so a stale page (session switch / resync) cannot win. */
let requestCounter = 0;
const latestRequest = new Map<string, number>();

function nextRequest(sessionId: string): number {
    const seq = ++requestCounter;
    latestRequest.set(sessionId, seq);
    return seq;
}

function isCurrent(sessionId: string, seq: number): boolean {
    return latestRequest.get(sessionId) === seq;
}

export interface SessionHistory {
    entries: Entry[];
    history: HistoryState;
    hasMore: boolean;
    loadingOlder: boolean;
    loadingInitial: boolean;
    error: string | null;
    loadOlder: () => void;
    retry: () => void;
}

/**
 * Historical pages merged with the live snapshot entries (live wins by id).
 * Paging is backwards (`before` cursor) and dedupes by entry id.
 */
export function useSessionHistory(
    sessionId: string | null | undefined,
    liveEntries: Entry[],
    enabled = true,
): SessionHistory {
    const history = useChatStore((state) =>
        sessionId ? (state.history[sessionId] ?? EMPTY_HISTORY) : EMPTY_HISTORY,
    );

    const token = history.resyncToken;
    useEffect(() => {
        if (!sessionId || !enabled) return;
        const current = useChatStore.getState().history[sessionId] ?? EMPTY_HISTORY;
        if (current.loaded || current.loadingInitial) return;

        const seq = nextRequest(sessionId);
        useChatStore.getState().beginInitial(sessionId);
        void fetchEntriesPage(sessionId)
            .then((page) => {
                if (!isCurrent(sessionId, seq)) return;
                useChatStore.getState().receiveInitial(sessionId, page.entries, page.cursor);
            })
            .catch((error: unknown) => {
                if (!isCurrent(sessionId, seq)) return;
                const message = error instanceof ApiError ? error.code : error instanceof Error ? error.message : String(error);
                useChatStore.getState().historyError(sessionId, message);
            });
        // `token` is the resync generation; `sessionId`/`enabled` gate loading.
    }, [sessionId, enabled, token]);

    const loadOlder = useCallback(() => {
        if (!sessionId) return;
        const current = useChatStore.getState().history[sessionId] ?? EMPTY_HISTORY;
        if (current.loadingOlder || current.loadingInitial) return;
        const before = current.cursor?.before;
        if (!current.cursor?.hasMore || !before) return;

        const seq = nextRequest(sessionId);
        useChatStore.getState().beginOlder(sessionId);
        void fetchEntriesPage(sessionId, before)
            .then((page) => {
                if (!isCurrent(sessionId, seq)) return;
                useChatStore.getState().receiveOlder(sessionId, page.entries, page.cursor);
            })
            .catch((error: unknown) => {
                if (!isCurrent(sessionId, seq)) return;
                const message = error instanceof ApiError ? error.code : error instanceof Error ? error.message : String(error);
                useChatStore.getState().historyError(sessionId, message);
            });
    }, [sessionId]);

    const retry = useCallback(() => {
        if (!sessionId) return;
        const current = useChatStore.getState().history[sessionId] ?? EMPTY_HISTORY;
        if (current.loaded) loadOlder();
        else useChatStore.getState().bumpResync(sessionId);
    }, [loadOlder, sessionId]);

    return {
        entries: mergeEntries(history.entries, liveEntries),
        history,
        hasMore: history.cursor?.hasMore === true && Boolean(history.cursor?.before),
        loadingOlder: history.loadingOlder,
        loadingInitial: history.loadingInitial,
        error: history.error,
        loadOlder,
        retry,
    };
}
