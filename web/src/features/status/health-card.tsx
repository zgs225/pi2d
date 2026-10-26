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

/** Card 2 — per-check ✓ / ! list with an overall "all passed" / "N failed" badge. */
export function HealthCard({ health, checkedAt, loading, error, onRetry }: HealthCardProps) {
    const { t } = useTranslation();
    const items = health?.items ?? [];
    const failed = items.filter((item) => !item.ok).length;

    return (
        <StatusCard
            title={t("status.health")}
            icon="status"
            headExtra={
                items.length ? (
                    <div className="status-health-meta">
                        <Badge tone={failed ? "err" : "ok"}>
                            {failed === 0
                                ? t("status.healthOk", { defaultValue: "All checks passed" })
                                : failed === 1
                                  ? t("status.healthFail.one", { n: 1, defaultValue: "{n} check failed" })
                                  : t("status.healthFail.other", {
                                        n: failed,
                                        defaultValue: "{n} checks failed",
                                    })}
                        </Badge>
                        {checkedAt ? (
                            <span className="card__sub">
                                <RelativeTime ts={checkedAt} />
                            </span>
                        ) : null}
                    </div>
                ) : null
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
                                <Icon name={item.ok ? "check" : "alert"} size={14} />
                            </span>
                            <div className="grow health-main">
                                <div className="health-name truncate">{item.name}</div>
                                {item.detail ? <div className="health-detail faint truncate">{item.detail}</div> : null}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </StatusCard>
    );
}
