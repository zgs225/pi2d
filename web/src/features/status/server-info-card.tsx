import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/shared/relative-time";
import { StatusDot } from "@/components/ui/status-dot";
import { KV, KVList } from "@/components/ui/kv";
import type { ServerIdentity } from "@/features/status/server";
import { formatUptime } from "@/features/status/server";

import { ErrorBlock, LoadingBlock, StatusCard } from "./card-parts";

export interface ServerInfoCardProps {
    server: ServerIdentity;
    loading: boolean;
    error: string | null;
    onRetry: () => void;
}

/** Card 1 — daemon identity, versions, uptime, bind/port, WS heartbeat. */
export function ServerInfoCard({ server, loading, error, onRetry }: ServerInfoCardProps) {
    const { t } = useTranslation();
    return (
        <StatusCard title={t("status.serverInfo")} icon="server">
            {error ? (
                <ErrorBlock message={error} onRetry={onRetry} />
            ) : loading ? (
                <LoadingBlock rows={8} />
            ) : (
                <KVList>
                    <KV label={t("connect.name")}>{server.name}</KV>
                    <KV label="hostname" mono>
                        {server.hostname}
                    </KV>
                    <KV label={t("status.os")}>{server.os}</KV>
                    <KV label={t("status.piVersion")}>{server.piVersion}</KV>
                    <KV label={t("status.pluginVersion")}>{server.pluginVersion}</KV>
                    <KV label={t("status.kernel")} mono>
                        {server.kernel}
                    </KV>
                    <KV label={t("status.uptime")}>{formatUptime(server.uptimeSec)}</KV>
                    <KV label={t("status.bindAddress")} mono>
                        {server.bindAddress}
                    </KV>
                    <KV label={t("status.port")} mono>
                        {server.port ?? "—"}
                    </KV>
                    <KV label={t("status.wsStatus")} valueClassName="status-ws">
                        <StatusDot
                            status={server.wsConnected ? "ok" : "err"}
                            title={t(server.wsConnected ? "status.connected" : "status.disconnected")}
                        />
                        <span>{t(server.wsConnected ? "status.connected" : "status.disconnected")}</span>
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
