import { useQuery } from "@tanstack/react-query";

import { api, apiRequest, type HealthResponse, type InfoResponse, type ModelInfo, type ResourcesResponse } from "@/lib/api";
import type { WorkspaceInfo } from "@/lib/protocol";

/** GET /api/v1/devices uses `id` on the wire; older builds exposed `deviceId`. */
export interface DeviceEntry {
    id?: string;
    deviceId?: string;
    name: string;
    kind: string;
    scopes: string[];
    lastActiveAt: number | null;
    revokedAt?: number | null;
}

export interface DevicesResponse {
    devices: DeviceEntry[];
}

export interface ModelsResponse {
    providers: ModelInfo[];
}

export async function fetchDevices(signal?: AbortSignal): Promise<DevicesResponse> {
    return apiRequest<DevicesResponse>("/api/v1/devices", { signal });
}

export async function fetchModels(workspaceId: string, signal?: AbortSignal): Promise<ModelsResponse> {
    return apiRequest<ModelsResponse>(`/api/v1/models?workspaceId=${encodeURIComponent(workspaceId)}`, { signal });
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

export function useWorkspacesQuery() {
    return useQuery<WorkspaceInfo[]>({
        queryKey: ["workspaces"],
        queryFn: ({ signal }) => api.workspaces(signal),
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

export function useModelsQuery(workspaceId: string | null | undefined) {
    return useQuery<ModelsResponse>({
        queryKey: ["models", workspaceId ?? ""],
        queryFn: ({ signal }) => fetchModels(workspaceId ?? "", signal),
        enabled: Boolean(workspaceId),
        staleTime: 60_000,
    });
}
