import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Progress } from "@/components/ui/progress";
import { KV, KVList } from "@/components/ui/kv";
import type { ResourcesResponse } from "@/lib/api";
import type { ServerIdentity } from "@/features/status/server";
import { formatBytes } from "@/features/status/server";

import { ErrorBlock, LoadingBlock, StatusCard, StatusEmpty } from "./card-parts";

function toneFor(pct: number | null): "default" | "warn" | "err" {
    if (pct == null) return "default";
    if (pct > 90) return "err";
    if (pct > 80) return "warn";
    return "default";
}

function percent(part: number, total: number): number | null {
    if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((part / total) * 100)));
}

export interface ResourcesCardProps {
    resources: ResourcesResponse | undefined;
    server: ServerIdentity;
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    workspaceCount: number;
    sessionCount: number;
}

/** Card 3 — CPU/mem/disk rows, instance/session counts, soft-limit banner. */
export function ResourcesCard({
    resources,
    server,
    loading,
    error,
    onRetry,
    workspaceCount,
    sessionCount,
}: ResourcesCardProps) {
    const { t } = useTranslation();
    const memPct =
        resources != null ? percent(resources.totalRssBytes, resources.physicalMemoryBytes) : null;
    const cpuPct = server.cpu;
    const diskPct = server.disk;
    const instanceCount = resources?.instances.length ?? 0;
    const liveSessions = resources?.instances.reduce((total, item) => total + (item.sessions || 0), 0) ?? 0;

    function row(key: string, label: string, pct: number | null, detail?: string) {
        return (
            <div className="res-row" data-res={key}>
                <div className="res-top">
                    <span className="res-label">{label}</span>
                    <span className="spacer" />
                    <b className="res-val">{pct == null ? "—" : `${pct}%`}</b>
                </div>
                <Progress value={pct ?? 0} tone={toneFor(pct)} size="lg" label={label} />
                {detail ? <div className="res-sub muted">{detail}</div> : null}
            </div>
        );
    }

    return (
        <StatusCard title={t("status.resources")} icon="cpu">
            {error ? (
                <ErrorBlock message={error} onRetry={onRetry} />
            ) : loading ? (
                <LoadingBlock rows={5} />
            ) : !resources ? (
                <StatusEmpty icon="cpu" title={t("status.noResourcesTitle")} text={t("status.noResourcesText")} />
            ) : (
                <>
                    <div className="res-list">
                        {row("cpu", "CPU", cpuPct)}
                        {row(
                            "mem",
                            t("status.memory"),
                            memPct,
                            `${formatBytes(resources.totalRssBytes)} / ${formatBytes(resources.physicalMemoryBytes)}`,
                        )}
                        {row("disk", t("status.disk"), diskPct)}
                    </div>

                    {resources.warn ? (
                        <div className="status-warn" role="status">
                            <Icon name="alert" />
                            <div>
                                <span>{t("status.resourceWarn")}</span>
                                {resources.reason ? <span className="muted"> {resources.reason}</span> : null}
                            </div>
                        </div>
                    ) : null}

                    <KVList className="res-kv">
                        <KV label={t("status.workspaces")}>{workspaceCount}</KV>
                        <KV label={t("status.instances")}>{instanceCount}</KV>
                        <KV label={t("status.sessions")}>{sessionCount}</KV>
                        <KV label={t("status.liveSessions")}>{liveSessions}</KV>
                    </KVList>
                </>
            )}
        </StatusCard>
    );
}
