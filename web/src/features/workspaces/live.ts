import type { QueryClient } from "@tanstack/react-query";

import type { WorkspaceInfo } from "@/lib/protocol";
import type { WsFrame } from "@/lib/ws";
import { useWorkspacesStore } from "@/stores/workspaces";

/**
 * Validate and narrow a pushed `workspace_update` WS frame.
 * Never throws on hostile input (null, malformed envelopes, wrong types).
 */
export function parseWorkspaceUpdate(frame: WsFrame): WorkspaceInfo | null {
    if (!frame || typeof frame !== "object") return null;
    try {
        const payload = frame.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
        const record = payload as Record<string, unknown>;
        if (typeof record.workspaceId !== "string" || record.workspaceId.trim() === "") {
            return null;
        }
        if (typeof record.cwd !== "string") {
            return null;
        }
        return payload as unknown as WorkspaceInfo;
    } catch {
        return null;
    }
}

function mergeRows(list: WorkspaceInfo[], info: WorkspaceInfo): WorkspaceInfo[] {
    const index = list.findIndex((w) => w.workspaceId === info.workspaceId);
    if (index === -1) return [...list, info];
    const next = list.slice();
    next[index] = info;
    return next;
}

/**
 * Apply a live workspace update:
 * - replaces or appends in the ['workspaces'] cache
 * - replaces or appends in ['chat-workspaces'] cache only if already cached
 * - upserts in the zustand useWorkspacesStore
 * - invalidates ['health'] so the status page reflects instance state
 */
export function applyWorkspaceUpdate(queryClient: QueryClient, info: WorkspaceInfo): void {
    queryClient.setQueryData<WorkspaceInfo[]>(["workspaces"], (old) =>
        Array.isArray(old) ? mergeRows(old, info) : [info],
    );

    queryClient.setQueryData<WorkspaceInfo[]>(["chat-workspaces"], (old) =>
        Array.isArray(old) ? mergeRows(old, info) : old,
    );

    useWorkspacesStore.getState().upsert(info);

    void queryClient.invalidateQueries({ queryKey: ["health"] });
}
