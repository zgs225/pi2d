import type { ModelRef, SessionEvent, SessionState, WorkspaceInfo } from "@protocol/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { api, apiRequest, getDeviceToken } from "@/lib/api";
import { projectEntries, snapshotEntries } from "@/lib/entry-projection";
import { defaultWsUrl, PiWsClient, type WsConnectionState } from "@/lib/ws";
import { useConnectionStore } from "@/stores/connection";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspacesStore } from "@/stores/workspaces";
import {
    applySessionEvent,
    emptySessionState,
    normalizeSessionSummary,
    normalizeSessionsPayload,
    normalizeSnapshotState,
    tabSessionRows,
} from "./session-state";
import { firstRootSession } from "./session-order";
import { setSessionMeta } from "./history";
import { migrateSessionId } from "./migration";
import { useChatStore } from "./store";

export const EMPTY_SESSIONS: SessionState[] = [];

export interface ModelChoice {
    id: string;
    contextWindow?: number;
    reasoning?: boolean;
}

export interface ModelGroup {
    provider: string;
    models: ModelChoice[];
}

function rec(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Accepts the several shapes `workspace.query{kind:"models"}` has used. */
export function normalizeModels(raw: unknown): ModelGroup[] {
    const record = rec(raw);
    const list = Array.isArray(raw)
        ? raw
        : Array.isArray(record?.providers)
          ? record.providers
          : Array.isArray(record?.models)
            ? record.models
            : Array.isArray(record?.groups)
              ? record.groups
              : [];

    const groups = new Map<string, ModelChoice[]>();
    const add = (provider: string, model: unknown) => {
        const item = rec(model);
        const id = str(item?.id ?? item?.model ?? item?.modelId) ?? str(model);
        if (!id) return;
        const choices = groups.get(provider) ?? [];
        if (!choices.some((choice) => choice.id === id)) {
            choices.push({
                id,
                ...(num(item?.contextWindow) !== undefined ? { contextWindow: num(item?.contextWindow) } : {}),
                ...(item?.reasoning === true ? { reasoning: true } : {}),
            });
        }
        groups.set(provider, choices);
    };

    for (const entry of list) {
        const item = rec(entry);
        if (!item) {
            if (typeof entry === "string") add("pi", entry);
            continue;
        }
        const provider = str(item.provider ?? item.name ?? item.id) ?? "pi";
        const models = Array.isArray(item.models) ? item.models : [];
        if (models.length) {
            for (const model of models) add(provider, model);
        } else if (str(item.id ?? item.model ?? item.modelId)) {
            // Flat list: `{provider, id, contextWindow}`.
            add(str(item.provider) ?? "pi", item);
        }
    }

    return [...groups.entries()]
        .filter(([, models]) => models.length > 0)
        .map(([provider, models]) => ({
            provider,
            models: models.sort((a, b) => a.id.localeCompare(b.id)),
        }))
        .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Ensure the active session's model is selectable even when the list is stale. */
export function withCurrentModel(groups: ModelGroup[], model: ModelRef | null): ModelGroup[] {
    if (!model) return groups;
    if (groups.some((group) => group.provider === model.provider && group.models.some((item) => item.id === model.id))) {
        return groups;
    }
    const next = groups.map((group) => ({ ...group, models: [...group.models] }));
    const existing = next.find((group) => group.provider === model.provider);
    if (existing) existing.models.unshift({ id: model.id });
    else next.unshift({ provider: model.provider, models: [{ id: model.id }] });
    return next;
}

/** Workspaces for the chat sidebar; refreshes the shared store. */
export function useChatWorkspaces(enabled: boolean): { workspaces: WorkspaceInfo[]; loading: boolean; error: unknown } {
    const setWorkspaces = useWorkspacesStore((state) => state.setWorkspaces);
    const query = useQuery({
        queryKey: ["chat-workspaces"],
        queryFn: ({ signal }) => api.workspaces(signal),
        enabled,
        staleTime: 30_000,
        retry: 1,
    });

    useEffect(() => {
        if (query.data) setWorkspaces(query.data);
    }, [query.data, setWorkspaces]);

    const workspaces = useWorkspacesStore((state) => state.items);
    return { workspaces, loading: query.isLoading, error: query.error };
}

/**
 * One workspace's session list plus the query state the page must gate on.
 *
 * `loaded` is the "the list is authoritative" flag: an unknown deep link may
 * only be reported as missing once the first REST/WS answer has landed, so the
 * page does not flash a not-found state while the list is still in flight.
 */
export interface ChatSessions {
    /** Sessions of the workspace, merged into the shared store (live state wins). */
    sessions: SessionState[];
    /** False until the session list has answered once (REST or live store). */
    loaded: boolean;
    /** True while a (Re)fetch of the REST list is in flight. */
    fetching: boolean;
    /** Refetch the REST session list — the unknown-session Retry button. */
    refetch: () => void;
}

/**
 * Sessions of one workspace, merged into the shared store (live state wins).
 *
 * "Sessions" here means the nvim tab set — `tab`-backed rows plus the sessions
 * linked to them through `parentId` (see `tabSessionRows`). The plugin's list
 * also carries every JSONL on disk, which is history, not a tab.
 */
export function useChatSessions(workspaceId: string | undefined, enabled: boolean): ChatSessions {
    const query = useQuery({
        queryKey: ["chat-sessions", workspaceId],
        queryFn: ({ signal }) =>
            apiRequest<unknown>(`/api/v1/workspaces/${encodeURIComponent(workspaceId ?? "")}/sessions`, { signal }),
        enabled: enabled && Boolean(workspaceId),
        staleTime: 5_000,
        refetchInterval: 15_000,
        retry: 1,
    });

    useEffect(() => {
        if (!workspaceId || !query.data) return;
        // The payload is the union of the workspace's JSONL history and its live
        // sessions; the console renders the nvim tab set only, so a historical
        // row can never look like a tab (and never receives a prompt).
        const rows = tabSessionRows(query.data);
        for (const row of rows) {
            const sessionId = str(row.sessionId) ?? str(row.session_id) ?? str(row.id);
            if (!sessionId) continue;
            setSessionMeta(sessionId, { workspaceId, sessionFile: str(row.sessionFile) });
        }
        const current = useSessionsStore.getState();
        const existing = current.byWorkspace[workspaceId] ?? [];
        const next = normalizeSessionsPayload(rows, workspaceId, existing);
        current.setSessions(workspaceId, next);
    }, [workspaceId, query.data]);

    const sessions = useSessionsStore((state) =>
        workspaceId ? (state.byWorkspace[workspaceId] ?? EMPTY_SESSIONS) : EMPTY_SESSIONS,
    );

    return {
        sessions,
        // A cached row (WS snapshot, another page) already proves the list is
        // known even when this query has not settled yet.
        loaded: query.isFetched || sessions.length > 0,
        fetching: query.isFetching,
        refetch: () => {
            void query.refetch();
        },
    };
}

/** Model list for the composer and dispatch modal. */
export function useChatModels(workspaceId: string | undefined, enabled: boolean): ModelGroup[] {
    const query = useQuery({
        queryKey: ["chat-models", workspaceId],
        queryFn: ({ signal }) =>
            apiRequest<unknown>(`/api/v1/models?workspaceId=${encodeURIComponent(workspaceId ?? "")}`, { signal }),
        enabled: enabled && Boolean(workspaceId),
        staleTime: 60_000,
        retry: 1,
    });
    return useMemo(() => normalizeModels(query.data), [query.data]);
}

/**
 * `pi2:session` doubles as the id-migration announcement: it is emitted on the
 * **old** id while `event.session.sessionId` carries the new one
 * (`pi2.nvim-web` `Instance:_migrate_session`).
 */
export function sessionMigration(
    sessionId: string,
    event: Record<string, unknown>,
): { from: string; to: string } | undefined {
    if (event.type !== "pi2:session") return undefined;
    const session = rec(event.session);
    const to = str(session?.sessionId);
    if (!to || to === sessionId) return undefined;
    const previous = str(session?.previousSessionId) ?? str(event.previousSessionId);
    if (previous && previous !== sessionId) return undefined;
    return { from: sessionId, to };
}

/**
 * Subscribe to the workspace's sessions and reduce `snapshot` / `event` frames
 * into the shared sessions store. The canonical reducer is imported from
 * `@protocol/reducer`; nothing state-related is reimplemented here.
 */
export function useChatSocket(workspaceId: string | undefined, sessionIds: string[], enabled: boolean): void {
    const clientRef = useRef<PiWsClient | null>(null);
    const setWsState = useConnectionStore((state) => state.setWsState);
    const idsKey = sessionIds.join("|");

    useEffect(() => {
        if (!workspaceId || !enabled) return;
        const client = new PiWsClient({
            url: defaultWsUrl(),
            token: getDeviceToken(),
            handlers: {
                onState: (state: WsConnectionState) => {
                    setWsState(state);
                },
                onSnapshot: (message) => {
                    const store = useSessionsStore.getState();
                    const state = normalizeSnapshotState(
                        message.sessionId,
                        workspaceId,
                        message.payload,
                        // The snapshot never carries list metadata (`parentId` /
                        // `visible` / `task`); the cached row owns it, so pass it in.
                        store.getSession(message.sessionId),
                    );
                    if (!state.entries.length) {
                        const raw = snapshotEntries(message.payload);
                        if (raw.length) state.entries = projectEntries(raw);
                    }
                    store.upsertSession(state);
                },
                onEvent: (message) => {
                    const payload = rec(message.payload);
                    const event = rec(payload?.event) ?? payload;
                    if (!event || typeof event.type !== "string") return;
                    const migration = sessionMigration(message.sessionId, event);
                    const sessionId = migration?.to ?? message.sessionId;
                    if (migration) {
                        // Move the render cache to the real id, then move the
                        // subscription: the daemon and plugin track the old id.
                        migrateSessionId(migration.from, migration.to, workspaceId);
                        client.unsubscribe(migration.from);
                        client.subscribe(migration.to);
                    }
                    const store = useSessionsStore.getState();
                    const current = store.getSession(sessionId) ?? emptySessionState({ sessionId, workspaceId });
                    const next = applySessionEvent(current, event as unknown as SessionEvent);
                    store.upsertSession(next);
                },
                onResyncRequired: (frame) => {
                    const sessionId = str(frame.sessionId);
                    if (!sessionId) return;
                    // `PiWsClient` already dropped the cached `(epoch, seq)`; the
                    // history hook refetches the REST page for this generation.
                    useChatStore.getState().bumpResync(sessionId);
                    client.unsubscribe(sessionId);
                    client.subscribe(sessionId);
                },
                onError: () => {
                    // Reconnect/backoff state is surfaced through `onState`.
                },
            },
        });
        clientRef.current = client;
        client.connect();
        return () => {
            clientRef.current = null;
            client.close();
        };
    }, [workspaceId, enabled, setWsState]);

    useEffect(() => {
        const client = clientRef.current;
        if (!client) return;
        const ids = idsKey ? idsKey.split("|").filter(Boolean) : [];
        if (ids.length) client.subscribe(ids);
    }, [idsKey, workspaceId]);
}

export interface SessionLookup {
    /** The routed session; `undefined` for `/chat` with no sessions at all. */
    session: SessionState | undefined;
    /**
     * True only once the list has loaded and the route id is still absent. The
     * page renders its not-found state then, never another session's entries.
     */
    missing: boolean;
}

/**
 * Resolve the session the route addresses.
 *
 * A non-empty `sessionId` that the loaded list does not contain resolves to
 * `undefined` — falling back to `sessions[0]` would silently show a different
 * session for an unknown deep link. The first-session fallback stays for the
 * `/chat` index (no id), which means "the sidebar's top row: the root in canonical order"
 * (a sub-session row is never the index default).
 *
 * @param sessionId Route session id (`undefined` on `/chat`).
 * @param sessions Sessions of the active workspace.
 * @param loaded Whether `sessions` has answered at least once.
 */
export function useSessionLookup(
    sessionId: string | null | undefined,
    sessions: SessionState[],
    loaded: boolean,
): SessionLookup {
    return useMemo(() => {
        if (!sessionId) return { session: firstRootSession(sessions), missing: false };
        const match = sessions.find((session) => session.sessionId === sessionId);
        if (match) return { session: match, missing: false };
        return { session: undefined, missing: loaded };
    }, [sessions, sessionId, loaded]);
}

export function mergeSessionSummaries(existing: SessionState | undefined, raw: unknown, workspaceId: string): SessionState {
    return normalizeSessionSummary(raw, workspaceId, existing);
}
