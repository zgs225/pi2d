import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { ModelInfo } from "@/lib/api";
import { formatContextWindow } from "@/features/status/server";

import { ErrorBlock, LoadingBlock, StatusCard, StatusEmpty } from "./card-parts";

export interface ModelsCardProps {
    providers: ModelInfo[];
    loading: boolean;
    error: string | null;
    onRetry: () => void;
}

/** Card 4 — provider accordion with mono model ids, context windows, reasoning badges. */
export function ModelsCard({ providers, loading, error, onRetry }: ModelsCardProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState("");
    const [openProviders, setOpenProviders] = useState<Set<string>>(
        () => new Set(providers[0] ? [providers[0].provider] : []),
    );

    useEffect(() => {
        setOpenProviders(new Set(providers[0] ? [providers[0].provider] : []));
    }, [providers]);

    const needle = query.trim().toLowerCase();
    const groups = useMemo(
        () =>
            providers
                .map((group) => ({
                    ...group,
                    models: group.models.filter(
                        (model) =>
                            !needle ||
                            model.id.toLowerCase().includes(needle) ||
                            group.provider.toLowerCase().includes(needle),
                    ),
                }))
                .filter((group) => group.models.length > 0),
        [needle, providers],
    );

    function toggle(provider: string) {
        setOpenProviders((current) => {
            const next = new Set(current);
            if (next.has(provider)) next.delete(provider);
            else next.add(provider);
            return next;
        });
    }

    return (
        <StatusCard title={t("status.models")} icon="model">
            {error ? (
                <ErrorBlock message={error} onRetry={onRetry} />
            ) : loading ? (
                <LoadingBlock rows={5} />
            ) : (
                <>
                    <div className="model-search">
                        <Icon name="search" />
                        <Input
                            type="search"
                            placeholder={t("status.modelSearchPlaceholder")}
                            aria-label={t("status.modelSearchAria")}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </div>

                    {providers.length === 0 ? (
                        <StatusEmpty icon="model" title={t("status.noModelsTitle")} text={t("status.noModelsText")} />
                    ) : groups.length === 0 ? (
                        <StatusEmpty icon="search" title={t("status.noModelsTitle")} text={t("status.noModelsText")} />
                    ) : (
                        <div className="model-list">
                            {groups.map((group) => {
                                const expanded = Boolean(needle) || openProviders.has(group.provider);
                                return (
                                    <div className={expanded ? "model-group open" : "model-group"} key={group.provider}>
                                        <button
                                            type="button"
                                            className="panel__head model-group__head"
                                            aria-expanded={expanded}
                                            onClick={() => toggle(group.provider)}
                                        >
                                            <Icon name="chevron-right" />
                                            <span className="model-provider">{group.provider}</span>
                                            <span className="badge model-count">{group.models.length}</span>
                                            <span className="spacer" />
                                        </button>
                                        {expanded ? (
                                            <div className="model-group__body">
                                                {group.models.map((model) => (
                                                    <div className="model-row" key={model.id}>
                                                        <span className="model-id mono truncate grow">{model.id}</span>
                                                        <span className="model-ctx muted">
                                                            {formatContextWindow(model.contextWindow)}
                                                        </span>
                                                        {model.reasoning ? (
                                                            <Badge tone="info">{t("status.reasoning")}</Badge>
                                                        ) : null}
                                                        {group.provider === "cliproxyapi" ? (
                                                            <Badge>{t("status.scoped")}</Badge>
                                                        ) : null}
                                                    </div>
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}
        </StatusCard>
    );
}
