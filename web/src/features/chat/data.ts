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
} from "./session-state";
import { setSessionMeta } from "./history";
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

/** Sessions of one workspace, merged into the shared store (live state wins). */
export function useChatSessions(workspaceId: string | undefined, enabled: boolean): SessionState[] {
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
        const raw = query.data as { sessions?: Array<{ sessionId?: unknown; sessionFile?: unknown }> } | undefined;
        for (const row of raw?.sessions ?? []) {
            if (typeof row?.sessionId === "string") {
                setSessionMeta(row.sessionId, {
                    workspaceId,
                    sessionFile: typeof row.sessionFile === "string" ? row.sessionFile : undefined,
                });
            }
        }
        const current = useSessionsStore.getState();
        const existing = current.byWorkspace[workspaceId] ?? [];
        const next = normalizeSessionsPayload(query.data, workspaceId, existing);
        current.setSessions(workspaceId, next);
    }, [workspaceId, query.data]);

    return useSessionsStore((state) => (workspaceId ? (state.byWorkspace[workspaceId] ?? EMPTY_SESSIONS) : EMPTY_SESSIONS));
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
                    const state = normalizeSnapshotState(message.sessionId, workspaceId, message.payload);
                    if (!state.entries.length) {
                        const raw = snapshotEntries(message.payload);
                        if (raw.length) state.entries = projectEntries(raw);
                    }
                    const store = useSessionsStore.getState();
                    store.upsertSession(state);
                },
                onEvent: (message) => {
                    const payload = rec(message.payload);
                    const event = rec(payload?.event) ?? payload;
                    if (!event || typeof event.type !== "string") return;
                    const sessionId = message.sessionId;
                    const store = useSessionsStore.getState();
                    const current = store.getSession(sessionId) ?? emptySessionState({ sessionId, workspaceId });
                    const next = applySessionEvent(current, event as unknown as SessionEvent);
                    store.upsertSession(next);
                },
                onResyncRequired: (frame) => {
                    const sessionId = str(frame.sessionId);
                    if (!sessionId) return;
                    useChatStore.getState().bumpResync(sessionId);
                    // Drop the seq cache and ask for a fresh snapshot; the history
                    // hook refetches the REST page for the same session.
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

/** The selected session, falling back to the first session of the workspace. */
export function useActiveSession(
    sessionId: string | null | undefined,
    sessions: SessionState[],
): SessionState | undefined {
    return useMemo(() => {
        if (sessionId) {
            const match = sessions.find((session) => session.sessionId === sessionId);
            if (match) return match;
        }
        return sessions[0];
    }, [sessions, sessionId]);
}

export function mergeSessionSummaries(existing: SessionState | undefined, raw: unknown, workspaceId: string): SessionState {
    return normalizeSessionSummary(raw, workspaceId, existing);
}
