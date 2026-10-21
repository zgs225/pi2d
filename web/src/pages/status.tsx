import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { PageHeader } from "@/components/shared/page-header";
import { toast } from "@/components/ui/toast";
import {
    clearPairMeta,
    readPairMeta,
    scopesForIdentity,
} from "@/features/connect/pairing";
import { ConnectionCard } from "@/features/status/connection-card";
import { deviceKey, DevicesCard } from "@/features/status/devices-card";
import { HealthCard } from "@/features/status/health-card";
import { ModelsCard } from "@/features/status/models-card";
import {
    useDevicesQuery,
    useHealthQuery,
    useInfoQuery,
    useModelsQuery,
    useResourcesQuery,
    useWorkspacesQuery,
    type DeviceEntry,
    type DevicesResponse,
} from "@/features/status/queries";
import { ResourcesCard } from "@/features/status/resources-card";
import { deriveServerIdentity, type InfoExtras } from "@/features/status/server";
import { ServerInfoCard } from "@/features/status/server-info-card";
import { TasksCard, type StatusTask } from "@/features/status/tasks-card";
import { ApiError, api, errorI18nKey } from "@/lib/api";
import { useConnectionStore } from "@/stores/connection";
import { useSessionsStore } from "@/stores/sessions";

import "@/styles/pages/status.css";

function translatedError(
    error: unknown,
    fallbackKey: string,
    t: (key: string) => string,
): string {
    if (error instanceof ApiError) return t(errorI18nKey(error.code));
    if (!error) return "";
    return t(fallbackKey);
}

export function StatusPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const endpoint = useConnectionStore((state) => state.endpoint);
    const wsState = useConnectionStore((state) => state.wsState);
    const storedServer = useConnectionStore((state) => state.server);
    const storedDeviceName = useConnectionStore((state) => state.deviceName);
    const connectedAt = useConnectionStore((state) => state.connectedAt);
    const disconnect = useConnectionStore((state) => state.disconnect);

    const info = useInfoQuery();
    const health = useHealthQuery();
    const resources = useResourcesQuery();
    const workspacesQuery = useWorkspacesQuery();
    const devices = useDevicesQuery();

    const workspaces = workspacesQuery.data ?? [];
    const visibleWorkspaces = workspaces.filter((workspace) => !workspace.hidden);
    const workspaceCount = visibleWorkspaces.length;
    const sessionCount = visibleWorkspaces.reduce((total, workspace) => total + (workspace.sessionCount || 0), 0);
    const modelsWorkspaceId = visibleWorkspaces[0]?.workspaceId ?? null;
    const models = useModelsQuery(modelsWorkspaceId);

    const meta = useMemo(() => readPairMeta(), []);
    const scopes = scopesForIdentity(meta, info.data);

    const healthOk = health.data?.ok ?? (health.data ? health.data.items.every((item) => item.ok) : undefined);
    const server = deriveServerIdentity({
        info: info.data as InfoExtras | undefined,
        endpoint,
        wsState,
        fetchedAt: info.dataUpdatedAt || null,
        nameFallback: storedServer?.name || meta?.server?.name,
        status: info.isError ? "offline" : healthOk === false ? "degraded" : undefined,
    });

    const byWorkspace = useSessionsStore((state) => state.byWorkspace);
    const tasks = useMemo<StatusTask[]>(
        () =>
            Object.values(byWorkspace).flatMap((sessions) =>
                sessions.flatMap((session) =>
                    (session.tasks ?? []).map((task) => ({ ...task, sessionId: session.sessionId })),
                ),
            ),
        [byWorkspace],
    );

    async function revokeDevice(device: DeviceEntry) {
        const key = deviceKey(device);
        try {
            await api.command({ method: "device.revoke", params: { deviceId: key } });
            queryClient.setQueryData<DevicesResponse>(["devices"], (previous) =>
                previous
                    ? { ...previous, devices: previous.devices.filter((item) => deviceKey(item) !== key) }
                    : previous,
            );
            toast.success(t("status.revoked", { name: device.name }));
        } catch (error) {
            toast.error(translatedError(error, "errors.unknown", t));
        }
    }

    function handleDisconnect() {
        disconnect();
        clearPairMeta();
        toast.success(t("connect.disconnected"));
        navigate({ href: "/connect" });
    }

    const statusLabel = t(`state.${server.status}`);
    const subtitle = `${server.name} · ${server.hostname} · ${statusLabel}`;

    return (
        <div className="status-page">
            <PageHeader
                title={t("status.title")}
                subtitle={subtitle}
                docTitle={t("nav.status")}
                size="lg"
                actions={
                    <a className="btn btn--sm" href="/connect?next=%2Fstatus">
                        <Icon name="refresh" />
                        {t("connect.reconnect")}
                    </a>
                }
            />

            <div className="status-grid">
                <ServerInfoCard
                    server={server}
                    loading={info.isPending}
                    error={info.isError ? translatedError(info.error, "status.infoError", t) : null}
                    onRetry={() => void info.refetch()}
                />

                <HealthCard
                    health={health.data}
                    checkedAt={health.data?.checkedAt ?? (health.dataUpdatedAt || null)}
                    loading={health.isPending}
                    error={health.isError ? translatedError(health.error, "status.healthError", t) : null}
                    onRetry={() => void health.refetch()}
                />

                <ResourcesCard
                    resources={resources.data}
                    server={server}
                    loading={resources.isPending}
                    error={resources.isError ? translatedError(resources.error, "status.resourcesError", t) : null}
                    onRetry={() => void resources.refetch()}
                    workspaceCount={workspaceCount}
                    sessionCount={sessionCount}
                />

                <ModelsCard
                    providers={models.data?.providers ?? []}
                    loading={Boolean(modelsWorkspaceId) && models.isPending}
                    error={models.isError ? translatedError(models.error, "status.modelsError", t) : null}
                    onRetry={() => void models.refetch()}
                />

                <TasksCard tasks={tasks} />

                <DevicesCard
                    devices={devices.data?.devices ?? []}
                    loading={devices.isPending}
                    error={devices.isError ? translatedError(devices.error, "status.devicesError", t) : null}
                    onRetry={() => void devices.refetch()}
                    onRevoke={revokeDevice}
                />

                <ConnectionCard
                    server={server}
                    deviceName={storedDeviceName || meta?.deviceName || ""}
                    scopes={scopes}
                    connectedAt={connectedAt || meta?.pairedAt || null}
                    loading={info.isPending}
                    error={info.isError ? translatedError(info.error, "status.infoError", t) : null}
                    onRetry={() => void info.refetch()}
                    onDisconnect={handleDisconnect}
                />
            </div>
        </div>
    );
}
