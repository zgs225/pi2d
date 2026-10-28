import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { apiRequest } from "@/lib/api";
import type { RecentSessionInfo, SessionState, WorkspaceInfo } from "@/lib/protocol";
import { normalizeSessionSummary } from "@/features/chat/session-state";
import { useWorkspaceSessionsQueries } from "@/features/status/queries";

/** The design lists the newest five sessions across every workspace. */
export const ACTIVITY_LIMIT = 5;

/** Enough headroom for the client-side merge with live session rows. */
const FEED_LIMIT = 20;

export interface RecentSessionRow {
    sessionId: string;
    workspaceId: string;
    workspaceName: string;
    /** Recency: live `lastActiveAt`/`createdAt`, else the file's mtime/start. */
    ts: number;
    /** Full state when a live instance answered for the workspace; null for disk-only rows. */
    state: SessionState | null;
}

function rec(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `GET /api/v1/sessions/recent` → `{sessions: RecentSessionInfo[]}`.
 * Tolerates a bare array and drops malformed rows instead of failing the column.
 */
export function normalizeRecentSessions(payload: unknown): RecentSessionInfo[] {
    const record = rec(payload);
    const list = Array.isArray(payload) ? payload : Array.isArray(record?.sessions) ? record.sessions : [];
    const rows: RecentSessionInfo[] = [];
    for (const entry of list) {
        const row = rec(entry);
        const sessionId = str(row?.sessionId);
        const workspaceId = str(row?.workspaceId);
        if (!row || !sessionId || !workspaceId) continue;
        rows.push({
            sessionId,
            workspaceId,
            workspaceName: str(row.workspaceName) ?? workspaceId,
            cwd: str(row.cwd) ?? "",
            sessionFile: str(row.sessionFile) ?? "",
            timestamp: num(row.timestamp) ?? 0,
            modified: num(row.modified) ?? 0,
        });
    }
    return rows;
}

/**
 * Merge the daemon's disk feed with session states from live instances.
 *
 * Disk rows are the base (they exist after a daemon restart, before any
 * workspace is spawned). A live row with the same id replaces the metadata:
 * it carries the authoritative name/first message/status. Sub-sessions are
 * dropped — the design's activity column is a list of workspace roots.
 */
export function mergeRecentSessions(
    disk: readonly RecentSessionInfo[],
    live: readonly SessionState[],
    workspaces: readonly WorkspaceInfo[],
    limit = ACTIVITY_LIMIT,
): RecentSessionRow[] {
    const allowed = new Set(workspaces.map((workspace) => workspace.workspaceId));
    const nameById = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace.name]));
    const byId = new Map<string, { disk?: RecentSessionInfo; live?: SessionState }>();

    for (const row of disk) {
        if (!allowed.has(row.workspaceId)) continue;
        byId.set(row.sessionId, { disk: row });
    }
    for (const state of live) {
        if (!state.sessionId || !allowed.has(state.workspaceId)) continue;
        const entry = byId.get(state.sessionId) ?? {};
        entry.live = state;
        byId.set(state.sessionId, entry);
    }

    const rows: RecentSessionRow[] = [];
    for (const [sessionId, entry] of byId) {
        if (entry.live?.parentId) continue;
        const workspaceId = entry.live?.workspaceId ?? entry.disk?.workspaceId ?? "";
        const ts = Math.max(
            entry.live?.lastActiveAt ?? 0,
            entry.live?.createdAt ?? 0,
            entry.disk?.modified ?? 0,
            entry.disk?.timestamp ?? 0,
        );
        rows.push({
            sessionId,
            workspaceId,
            workspaceName: nameById.get(workspaceId) ?? entry.disk?.workspaceName ?? "",
            ts,
            state: entry.live ?? null,
        });
    }
    rows.sort((a, b) => b.ts - a.ts || a.sessionId.localeCompare(b.sessionId));
    return rows.slice(0, limit);
}

/**
 * Recent activity for the workspaces page.
 *
 * Two sources, both read-only:
 *  - the daemon's disk feed (no instance spawn, survives a restart), and
 *  - `/workspaces/:id/sessions` for workspaces with a live instance, which adds
 *    names/first messages/status without spawning anything (the status page
 *    uses the same query keys).
 */
export function useRecentSessions(workspaces: readonly WorkspaceInfo[], enabled = true): RecentSessionRow[] {
    const liveIds = useMemo(
        () => workspaces.filter((workspace) => workspace.instance != null).map((workspace) => workspace.workspaceId),
        [workspaces],
    );

    const feed = useQuery({
        queryKey: ["recent-sessions"],
        queryFn: async ({ signal }) =>
            normalizeRecentSessions(
                await apiRequest<unknown>(`/api/v1/sessions/recent?limit=${FEED_LIMIT}`, { signal }),
            ),
        enabled,
        staleTime: 10_000,
        refetchInterval: 15_000,
        retry: false,
    });

    const sessionQueries = useWorkspaceSessionsQueries(liveIds, enabled);
    // `useWorkspaceSessionsQueries` returns the daemon's list rows as-is (the
    // status page only reads `tasks`); the activity column needs the reducer's
    // defaults for flags/attention, so normalize before rendering a dot.
    const live = useMemo(
        () =>
            sessionQueries.flatMap((query, index) => {
                const workspaceId = liveIds[index] ?? "";
                return (Array.isArray(query.data) ? query.data : []).map((row) =>
                    normalizeSessionSummary(row, workspaceId),
                );
            }),
        [sessionQueries, liveIds],
    );

    return useMemo(
        () => mergeRecentSessions(feed.data ?? [], live, workspaces),
        [feed.data, live, workspaces],
    );
}
