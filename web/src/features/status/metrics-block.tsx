import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { RelativeTime } from "@/components/shared/relative-time";
import type { ResourcesResponse } from "@/lib/api";
import { formatUptime, type ServerIdentity } from "@/features/status/server";

import { ErrorBlock } from "./card-parts";

/** `.meter` — a 3px hairline under each tile value. */
function Meter({ value, label }: { value: number | null; label: string }) {
    const pct = value == null ? 0 : Math.max(0, Math.min(100, Math.round(value)));
    const tone = pct > 90 ? "is-err" : pct > 80 ? "is-warn" : "";
    return (
        <div
            className="meter"
            role="progressbar"
            aria-label={`${label} ${pct}%`}
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
        >
            {/* The only inline value is geometry: the width of the 3px fill. */}
            <i className={tone} style={{ width: `${pct}%` }} />
        </div>
    );
}

function percent(part: number | null): number | null {
    return part == null || !Number.isFinite(part) ? null : Math.max(0, Math.min(100, part));
}

function readable(pct: number | null): string {
    return pct == null ? "—" : `${Math.round(pct)}%`;
}

export interface MetricsBlockProps {
    server: ServerIdentity;
    resources: ResourcesResponse | undefined;
    workspaceCount: number;
    sessionCount: number;
    instanceCount: number;
    liveSessionCount: number;
    error: string | null;
    onRetry: () => void;
}

/**
 * Metrics block: CPU / memory / disk / uptime tiles, then a single quiet line
 * of counts (workspaces · sessions · instances · live sessions). The soft-limit
 * banner of `/resources` rides along instead of a second progress list.
 */
export function MetricsBlock({
    server,
    resources,
    workspaceCount,
    sessionCount,
    instanceCount,
    liveSessionCount,
    error,
    onRetry,
}: MetricsBlockProps) {
    const { t } = useTranslation();
    const cpu = percent(server.cpu);
    // `/info` may not carry a memory percentage; `/resources` gives RSS and the
    // physical total, so derive the ratio instead of showing "—".
    const mem =
        server.mem != null
            ? percent(server.mem)
            : resources && resources.physicalMemoryBytes > 0
              ? percent((resources.totalRssBytes / resources.physicalMemoryBytes) * 100)
              : null;
    const disk = percent(server.disk);
    const live = t("status.live", { defaultValue: "Live" });

    const counts: Array<[string, string]> = [
        [t("status.workspaces"), String(workspaceCount)],
        [t("status.sessions"), String(sessionCount)],
        [t("status.instances"), String(instanceCount)],
        [t("status.liveSessions"), String(liveSessionCount)],
    ];

    return (
        <div className="status-block">
            <div className="section-label">{t("status.resources")}</div>

            <div className="status-tiles">
                <div className="tile status-tile" data-res="cpu">
                    <div className="tile__label">CPU</div>
                    <div className="tile__value">{readable(cpu)}</div>
                    <div className="tile__bar">
                        <Meter value={cpu} label="CPU" />
                    </div>
                    <div className="tile__meta">{live}</div>
                </div>

                <div className="tile status-tile" data-res="mem">
                    <div className="tile__label">{t("status.memory")}</div>
                    <div className="tile__value">{readable(mem)}</div>
                    <div className="tile__bar">
                        <Meter value={mem} label={t("status.memory")} />
                    </div>
                    <div className="tile__meta">{live}</div>
                </div>

                <div className="tile status-tile" data-res="disk">
                    <div className="tile__label">{t("status.disk")}</div>
                    <div className="tile__value">{readable(disk)}</div>
                    <div className="tile__bar">
                        <Meter value={disk} label={t("status.disk")} />
                    </div>
                    <div className="tile__meta">{live}</div>
                </div>

                <div className="tile status-tile" data-res="uptime">
                    <div className="tile__label">{t("status.uptime")}</div>
                    <div className="tile__value">{formatUptime(server.uptimeSec)}</div>
                    <div className="tile__meta">
                        <span>{t("status.lastHeartbeat")}</span>
                        <RelativeTime ts={server.lastHeartbeatAt} live={false} />
                    </div>
                </div>
            </div>

            <div className="status-line status-counts">
                {counts.map(([label, value], index) => (
                    <span className="status-count" key={label}>
                        {index ? (
                            <span className="sep" aria-hidden="true">
                                ·
                            </span>
                        ) : null}
                        <span className="status-count__label">{label}</span>
                        <b className="tabular">{value}</b>
                    </span>
                ))}
            </div>

            {error ? <ErrorBlock message={error} onRetry={onRetry} /> : null}

            {resources?.warn ? (
                <div className="status-warn" role="status">
                    <Icon name="alert" />
                    <div>
                        <span>{t("status.resourceWarn")}</span>
                        {resources.reason ? <span className="muted"> {resources.reason}</span> : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
