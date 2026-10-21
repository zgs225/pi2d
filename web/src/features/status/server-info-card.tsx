import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/shared/relative-time";
import { StatusDot } from "@/components/ui/status-dot";
import { KV, KVList } from "@/components/ui/kv";
import type { ResourcesResponse } from "@/lib/api";
import type { ServerIdentity } from "@/features/status/server";
import { formatBytes, formatUptime } from "@/features/status/server";

import { ErrorBlock, LoadingBlock, StatusCard } from "./card-parts";

export interface ServerInfoCardProps {
    server: ServerIdentity;
    /** `/resources` summary: instance count and the daemon's own RSS total. */
    resources: ResourcesResponse | undefined;
    loading: boolean;
    error: string | null;
    onRetry: () => void;
}

/**
 * Card 1 — the daemon's own identity from `/info` (`daemonId`, `machineId`,
 * `platform`, `hostname`, `os`, `version`, `uptimeMs`) plus the `/resources`
 * instance and RSS figures. Rows whose field the daemon does not send (kernel,
 * plugin version) are omitted rather than rendered as `—`.
 */
export function ServerInfoCard({ server, resources, loading, error, onRetry }: ServerInfoCardProps) {
    const { t } = useTranslation();
    const instanceCount = resources ? resources.instances.length : null;
    const rssBytes = resources && Number.isFinite(resources.totalRssBytes) ? resources.totalRssBytes : null;
    const wsLabel = t(server.wsConnected ? "status.connected" : "status.disconnected");

    return (
        <StatusCard title={t("status.serverInfo")} icon="server">
            {error ? (
                <ErrorBlock message={error} onRetry={onRetry} />
            ) : loading ? (
                <LoadingBlock rows={8} />
            ) : (
                <KVList>
                    {server.name && server.name !== server.hostname ? (
                        <KV label={t("connect.name")}>{server.name}</KV>
                    ) : null}
                    <KV label="hostname" mono>
                        {server.hostname}
                    </KV>
                    <KV label={t("status.os")}>{server.os}</KV>
                    <KV label="platform" mono>
                        {server.platform}
                    </KV>
                    <KV label={t("status.piVersion")}>{server.piVersion}</KV>
                    <KV label={t("status.uptime")}>{formatUptime(server.uptimeSec)}</KV>
                    <KV label="daemonId" mono>
                        {server.daemonId}
                    </KV>
                    <KV label="machineId" mono>
                        {server.machineId}
                    </KV>
                    <KV label={t("status.bindAddress")} mono>
                        {server.bindAddress}
                    </KV>
                    <KV label={t("status.port")} mono>
                        {server.port ?? "—"}
                    </KV>
                    <KV label={t("status.instances")}>{instanceCount ?? "—"}</KV>
                    <KV label="RSS" mono>
                        {formatBytes(rssBytes)}
                    </KV>
                    <KV label={t("status.wsStatus")} valueClassName="status-ws">
                        <StatusDot
                            status={server.wsConnected ? "ok" : "err"}
                            title={wsLabel}
                        />
                        <span data-testid="ws-status">{wsLabel}</span>
                        <span className="muted">{server.wsProto}</span>
                    </KV>
                    <KV label={t("status.lastHeartbeat")}>
                        <RelativeTime ts={server.lastHeartbeatAt} />
                    </KV>
                </KVList>
            )}
        </StatusCard>
    );
}
