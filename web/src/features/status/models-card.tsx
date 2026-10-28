import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { ModelInfo } from "@/lib/api";
import type { ModelsResponse } from "@/features/status/queries";
import { formatContextWindow } from "@/features/status/server";

import { ErrorBlock, LoadingBlock, StatusCard, StatusEmpty } from "./card-parts";

export interface ModelsCardProps {
    providers: ModelInfo[];
    loading: boolean;
    error: string | null;
    onRetry: () => void;
    pending?: boolean;
    pendingReason?: ModelsResponse["pendingReason"] | null;
}

/** Card 4 — provider accordion with mono model ids, context windows, reasoning badges. */
export function ModelsCard({ providers, loading, error, onRetry, pending, pendingReason }: ModelsCardProps) {
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

    // State machine:
    // 1. error → ErrorBlock
    // 2. loading with no data yet → LoadingBlock (initial fetch in progress)
    // 3. providers empty + no-instance or no-live-session → StatusEmpty
    //    (checked before the generic pending hint: those reasons are also pending)
    // 4. pending fetch with no providers yet → LoadingBlock + aria-live pending hint (NOT an error)
    // 5. providers empty otherwise → search bar + StatusEmpty (no-models copy)
    // 6. providers present → search input + provider accordion
    let body: ReactNode;

    if (error) {
        body = <ErrorBlock message={error} onRetry={onRetry} />;
    } else if (loading && providers.length === 0) {
        body = <LoadingBlock rows={5} />;
    } else if (
        providers.length === 0 &&
        (pendingReason === "no-instance" || pendingReason === "no-live-session")
    ) {
        body = (
            <StatusEmpty
                icon="model"
                title={t("status.modelsNoInstanceTitle", { defaultValue: "No live Neovim instance" })}
                text={t("status.modelsNoInstanceText", {
                    defaultValue: "Open a session in any workspace",
                })}
            />
        );
    } else if (pending && providers.length === 0) {
        body = (
            <section
                aria-live="polite"
                aria-label={t("status.modelsPendingTitle", { defaultValue: "Fetching models" })}
            >
                <LoadingBlock rows={5} />
                <p className="faint">
                    {t("status.modelsPendingText", {
                        defaultValue: "Fetching the catalogue from a running Neovim",
                    })}
                </p>
            </section>
        );
    } else if (providers.length === 0) {
        body = (
            <>
                <div className="model-search">
                    <Icon name="search" />
                    <Input
                        type="search"
                        className="model-search__input"
                        placeholder={t("status.modelSearchPlaceholder")}
                        aria-label={t("status.modelSearchAria")}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>
                <StatusEmpty icon="model" title={t("status.noModelsTitle")} text={t("status.noModelsText")} />
            </>
        );
    } else {
        body = (
            <>
                <div className="model-search">
                    <Icon name="search" />
                    <Input
                        type="search"
                        className="model-search__input"
                        placeholder={t("status.modelSearchPlaceholder")}
                        aria-label={t("status.modelSearchAria")}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </div>

                {groups.length === 0 ? (
                    <StatusEmpty icon="search" title={t("status.noModelsTitle")} text={t("status.noModelsText")} />
                ) : (
                    <div className="model-list">
                        {groups.map((group) => {
                            const expanded = Boolean(needle) || openProviders.has(group.provider);
                            return (
                                <div className={expanded ? "model-group open" : "model-group"} key={group.provider}>
                                    <button
                                        type="button"
                                        className="model-group__head"
                                        aria-expanded={expanded}
                                        onClick={() => toggle(group.provider)}
                                    >
                                        <Icon name="chevron-right" />
                                        <span className="model-provider truncate">{group.provider}</span>
                                        <span className="model-count faint tabular">{group.models.length}</span>
                                        <span className="spacer" />
                                    </button>
                                    {expanded ? (
                                        <div className="model-group__body">
                                            {group.models.map((model) => (
                                                <div className="model-row" key={model.id}>
                                                    <span className="model-id mono truncate grow">{model.id}</span>
                                                    <span className="model-ctx faint tabular">
                                                        {formatContextWindow(model.contextWindow)}
                                                    </span>
                                                    {model.reasoning ? (
                                                        <Badge className="badge--outline">
                                                            {t("status.reasoning")}
                                                        </Badge>
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
        );
    }

    return (
        <StatusCard title={t("status.models")} icon="model">
            {body}
        </StatusCard>
    );
}
