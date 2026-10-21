import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { RelativeTime } from "@/components/shared/relative-time";
import type { HealthResponse } from "@/lib/api";

import { ErrorBlock, LoadingBlock, StatusCard, StatusEmpty } from "./card-parts";

export interface HealthCardProps {
    health: HealthResponse | undefined;
    checkedAt: number | null;
    loading: boolean;
    error: string | null;
    onRetry: () => void;
}

/** Card 2 — per-check ✓/✗ list with an overall healthy/degraded badge. */
export function HealthCard({ health, checkedAt, loading, error, onRetry }: HealthCardProps) {
    const { t } = useTranslation();
    const items = health?.items ?? [];
    const allOk = items.length > 0 && items.every((item) => item.ok);

    return (
        <StatusCard
            title={t("status.health")}
            icon="status"
            headExtra={
                <div className="status-health-meta">
                    {items.length ? (
                        <Badge tone={allOk ? "ok" : "warn"}>{t(allOk ? "status.healthy" : "state.degraded")}</Badge>
                    ) : null}
                    {checkedAt ? <span className="card__sub"><RelativeTime ts={checkedAt} /></span> : null}
                </div>
            }
        >
            {error ? (
                <ErrorBlock message={error} onRetry={onRetry} />
            ) : loading ? (
                <LoadingBlock rows={4} />
            ) : items.length === 0 ? (
                <StatusEmpty icon="alert" title={t("status.noHealthTitle")} text={t("status.noHealthText")} />
            ) : (
                <div className="health-list">
                    {items.map((item) => (
                        <div className="health-row" key={item.name}>
                            <span
                                className={item.ok ? "health-ico health-ico--ok" : "health-ico health-ico--err"}
                                title={t(item.ok ? "status.pass" : "status.fail")}
                                aria-label={t(item.ok ? "status.pass" : "status.fail")}
                            >
                                <Icon name={item.ok ? "check" : "x"} size={15} />
                            </span>
                            <div className="grow">
                                <div className="health-name">{item.name}</div>
                                {item.detail ? <div className="health-detail muted">{item.detail}</div> : null}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </StatusCard>
    );
}
