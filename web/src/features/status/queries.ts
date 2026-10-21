import { useQueries, useQuery } from "@tanstack/react-query";

import {
    api,
    apiRequest,
    type HealthResponse,
    type InfoResponse,
    type ModelInfo,
    type ResourcesResponse,
} from "@/lib/api";
import type { SessionState, TaskItem, WorkspaceInfo } from "@/lib/protocol";

/**
 * `GET /api/v1/devices` answers a **bare array** (`auth.listDevices()`); older
 * builds wrapped it as `{devices:[…]}`. `id` is the daemon's device id, while
 * `deviceId` is what pairing responses call it.
 */
export interface DeviceEntry {
    id?: string;
    deviceId?: string;
    name: string;
    kind: string;
    scopes: string[];
    /** `lastSeenAt` is the daemon field; `lastActiveAt` came from older builds. */
    lastActiveAt?: number | null;
    lastSeenAt?: number | null;
    createdAt?: number | null;
    revokedAt?: number | null;
}

export interface DevicesResponse {
    devices: DeviceEntry[];
}

export interface ModelsResponse {
    providers: ModelInfo[];
}

/** Accept the daemon's bare device array and the legacy `{devices:[…]}` envelope. */
export function normalizeDevices(payload: unknown): DeviceEntry[] {
    if (Array.isArray(payload)) return payload as DeviceEntry[];
    const record = payload as { devices?: unknown } | null | undefined;
    return Array.isArray(record?.devices) ? (record.devices as DeviceEntry[]) : [];
}

export async function fetchDevices(signal?: AbortSignal): Promise<DevicesResponse> {
    return { devices: normalizeDevices(await apiRequest<unknown>("/api/v1/devices", { signal })) };
}

export async function fetchModels(workspaceId: string, signal?: AbortSignal): Promise<ModelsResponse> {
    return apiRequest<ModelsResponse>(`/api/v1/models?workspaceId=${encodeURIComponent(workspaceId)}`, { signal });
}

/**
 * `/api/v1/pair` is public for redemption (`{code,…}`) and *authenticated* for
 * minting: an authenticated `POST` with no `code` returns
 * `{accepted,code,url,expiresAt,nonce}` (docs/protocol.md §3.2).
 */
export interface PairCodeResponse {
    accepted?: boolean;
    code?: string;
    url?: string;
    expiresAt?: number;
    nonce?: string;
}

/** Pairing codes are short-lived; 10 minutes matches `auth.pairCreate`'s default. */
export const PAIR_CODE_TTL_SEC = 600;

export async function createPairCode(signal?: AbortSignal): Promise<PairCodeResponse> {
    return apiRequest<PairCodeResponse>("/api/v1/pair", {
        method: "POST",
        body: { ttlSec: PAIR_CODE_TTL_SEC },
        signal,
    });
}

/** A background task plus the session it belongs to (the card shows both). */
export interface StatusTask extends TaskItem {
    sessionId: string;
}

/** `/sessions` relays a `workspace.query` ack: `{sessions}`, `{result:{sessions}}` or a bare array. */
export function normalizeSessions(payload: unknown, workspaceId: string): SessionState[] {
    if (Array.isArray(payload)) return (payload as SessionState[]).map((row) => ({ ...row, workspaceId }));
    const record = payload as { sessions?: unknown; result?: { sessions?: unknown } } | null | undefined;
    const rows = record?.sessions ?? record?.result?.sessions;
    if (!Array.isArray(rows)) return [];
    return (rows as SessionState[]).map((row) => ({ ...row, workspaceId: row.workspaceId || workspaceId }));
}

/** Every `sessions[].task` of a `/sessions` payload, tagged with its session id. */
export function sessionTasks(sessions: SessionState[]): StatusTask[] {
    return sessions.flatMap((session) =>
        (Array.isArray(session.tasks) ? session.tasks : []).map((task) => ({
            ...task,
            sessionId: session.sessionId || "",
        })),
    );
}

/** Merge task lists, keeping the first entry per task id (live state wins). */
export function mergeTasks(...lists: StatusTask[][]): StatusTask[] {
    const byId = new Map<string, StatusTask>();
    for (const list of lists) {
        for (const task of list) {
            const key = task.id || `${task.sessionId}:${task.command}`;
            if (!byId.has(key)) byId.set(key, task);
        }
    }
    return [...byId.values()];
}

export function useInfoQuery(enabled = true) {
    return useQuery<InfoResponse>({
        queryKey: ["info"],
        queryFn: ({ signal }) => api.info(signal),
        enabled,
        staleTime: 30_000,
    });
}

export function useHealthQuery() {
    return useQuery<HealthResponse>({
        queryKey: ["health"],
        queryFn: ({ signal }) => api.health(signal),
        staleTime: 10_000,
    });
}

export function useResourcesQuery() {
    return useQuery<ResourcesResponse>({
        queryKey: ["resources"],
        queryFn: ({ signal }) => api.resources(signal),
        // Resource pressure is the only live figure: poll every 3s while the tab is visible.
        refetchInterval: 3_000,
        refetchIntervalInBackground: false,
        staleTime: 2_000,
    });
}

/** `GET /api/v1/workspaces` answers an array; the envelope shape is only a fallback. */
export function normalizeWorkspaces(payload: unknown): WorkspaceInfo[] {
    if (Array.isArray(payload)) return payload as WorkspaceInfo[];
    const record = payload as { workspaces?: unknown } | null | undefined;
    return Array.isArray(record?.workspaces) ? (record.workspaces as WorkspaceInfo[]) : [];
}

export function useWorkspacesQuery() {
    return useQuery<WorkspaceInfo[]>({
        queryKey: ["workspaces"],
        queryFn: async ({ signal }) => normalizeWorkspaces(await apiRequest<unknown>("/api/v1/workspaces", { signal })),
        staleTime: 10_000,
    });
}

export function useDevicesQuery() {
    return useQuery<DevicesResponse>({
        queryKey: ["devices"],
        queryFn: ({ signal }) => fetchDevices(signal),
        staleTime: 10_000,
    });
}

/**
 * A fresh pairing code for the connection card. A code is single-use and short
 * lived, so each mount mints its own (`gcTime: 0` drops it when the card goes
 * away) and `refetch()` is the retry button.
 */
export function usePairCodeQuery(enabled = true) {
    return useQuery<PairCodeResponse>({
        queryKey: ["pair-code"],
        queryFn: ({ signal }) => createPairCode(signal),
        enabled,
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 0,
        retry: false,
    });
}

/**
 * Sessions (and therefore background tasks) of every registered workspace, so
 * the tasks card works after a hard reload instead of only from the chat store.
 */
export function useWorkspaceSessionsQueries(workspaceIds: string[], enabled = true) {
    return useQueries({
        queries: workspaceIds.map((workspaceId) => ({
            queryKey: ["status-sessions", workspaceId],
            queryFn: async ({ signal }: { signal: AbortSignal }) =>
                normalizeSessions(
                    await apiRequest<unknown>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`, {
                        signal,
                    }),
                    workspaceId,
                ),
            enabled,
            staleTime: 10_000,
            retry: false,
        })),
    });
}

export function useModelsQuery(workspaceId: string | null | undefined) {
    return useQuery<ModelsResponse>({
        queryKey: ["models", workspaceId ?? ""],
        queryFn: ({ signal }) => fetchModels(workspaceId ?? "", signal),
        enabled: Boolean(workspaceId),
        staleTime: 60_000,
    });
}
