import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { toast } from "@/components/ui/toast";
import { deriveServerIdentity, resolveServerStatus, type InfoExtras } from "@/features/status/server";
import { useHealthQuery, useInfoQuery, useWorkspacesQuery } from "@/features/status/queries";
import { ActivityColumn } from "@/features/workspaces/activity-column";
import { openWorkspace, workspaceSessionCount } from "@/features/workspaces/commands";
import { NewWorkspaceDialog, type NewWorkspaceInput } from "@/features/workspaces/new-workspace-dialog";
import { WorkspaceStatusLine } from "@/features/workspaces/status-line";
import { countSecondary, partitionWorkspaces, readShowAll, writeShowAll } from "@/features/workspaces/visibility";
import { WorkspaceCard, WorkspacesSkeleton } from "@/features/workspaces/workspace-card";
import { ApiError, errorI18nKey } from "@/lib/api";
import type { WorkspaceInfo } from "@/lib/protocol";
import { useConnectionStore } from "@/stores/connection";

import "@/styles/pages/workspaces.css";

function compareWorkspaces(a: WorkspaceInfo, b: WorkspaceInfo): number {
    const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinned !== 0) return pinned;
    return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
}

function basename(path: string): string {
    const segments = path.replace(/\/+$/, "").split("/");
    return segments[segments.length - 1] || path;
}

/**
 * Workspaces page — pi2-web-ui-design v0.1.1 "Quiet Workbench" (§5.1):
 * page head (the only primary is "new workspace") → single-line server status
 * strip → card grid (2 columns ≥1100px) + 320px recent-activity column.
 *
 * The page owns layout and queries only; rows, the status line and the activity
 * column live in `features/workspaces/`.
 */
export function WorkspacesPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [dialogOpen, setDialogOpen] = useState(false);

    const paired = useConnectionStore((state) => state.paired);
    const endpoint = useConnectionStore((state) => state.endpoint);
    const wsState = useConnectionStore((state) => state.wsState);
    const storedServer = useConnectionStore((state) => state.server);

    const workspaces = useWorkspacesQuery();
    const info = useInfoQuery();
    const health = useHealthQuery(paired);

    // Persisted "show N hidden" toggle (localStorage, default off): secondary
    // rows (hidden/ghost/temp/…) stay out of the list until asked for.
    const [showAll, setShowAll] = useState<boolean>(() => readShowAll());

    function toggleShowAll() {
        setShowAll((previous) => {
            const next = !previous;
            writeShowAll(next);
            return next;
        });
    }

    const all = useMemo(() => (workspaces.data ?? []).slice().sort(compareWorkspaces), [workspaces.data]);
    const secondaryCount = useMemo(() => countSecondary(all), [all]);
    const { primary, secondary } = useMemo(() => partitionWorkspaces(all, showAll), [all, showAll]);
    const items = showAll ? [...primary, ...secondary].sort(compareWorkspaces) : primary;
    const sessionCount = useMemo(
        () => all.reduce((total, workspace) => total + workspaceSessionCount(workspace), 0),
        [all],
    );
    const runningCount = useMemo(() => all.filter((workspace) => (workspace.liveCount || 0) > 0).length, [all]);

    const healthOk = health.data?.ok ?? (health.data ? health.data.items.every((item) => item.ok) : undefined);
    const server = deriveServerIdentity({
        info: info.data as InfoExtras | undefined,
        endpoint,
        wsState,
        fetchedAt: info.dataUpdatedAt || null,
        nameFallback: storedServer?.name,
        status: resolveServerStatus({
            paired,
            info: info.data,
            infoError: info.isError,
            healthError: health.isError,
            healthOk,
        }),
    });

    async function createWorkspace(input: NewWorkspaceInput) {
        const workspaceId = await openWorkspace(input);
        await finishOpen(workspaceId, input.name?.trim() || basename(input.cwd));
    }

    /** Shared tail of a successful open: refresh the grid, toast, enter chat. */
    async function finishOpen(workspaceId: string, label: string) {
        await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        toast.success(t("workspaces.opened", { name: label }));
        navigate({ href: `/chat?workspace=${encodeURIComponent(workspaceId)}` });
    }

    const errorText =
        workspaces.error instanceof ApiError ? t(errorI18nKey(workspaces.error.code)) : t("workspaces.loadErrorText");

    const hasCards = workspaces.isSuccess && items.length > 0;
    // Empty/loading/error states own the primary, so a screen never shows two.
    const showHiddenToggle = items.length > 0 && secondaryCount > 0;

    let main: ReactNode;
    if (workspaces.isPending) {
        main = (
            <div className="ws-grid">
                <WorkspacesSkeleton />
                <WorkspacesSkeleton />
                <WorkspacesSkeleton />
            </div>
        );
    } else if (workspaces.isError) {
        main = (
            <section className="ws-empty">
                <Empty
                    icon={<Icon name="alert" size={22} />}
                    title={t("workspaces.loadErrorTitle")}
                    description={`${t("workspaces.loadErrorText")} (${errorText})`}
                    action={
                        <Button variant="ghost" onClick={() => void workspaces.refetch()}>
                            <Icon name="refresh" />
                            {t("common.retry")}
                        </Button>
                    }
                />
            </section>
        );
    } else if (all.length === 0) {
        main = (
            <section className="ws-empty">
                <Empty
                    icon={<Icon name="folder" size={22} />}
                    title={t("workspaces.emptyTitle")}
                    description={t("workspaces.emptyText")}
                    action={
                        <Button variant="primary" onClick={() => setDialogOpen(true)}>
                            <Icon name="plus" />
                            {t("workspaces.new")}
                        </Button>
                    }
                />
            </section>
        );
    } else if (primary.length === 0 && !showAll) {
        main = (
            <section className="ws-empty">
                <Empty
                    icon={<Icon name="eye" size={22} />}
                    title={t("workspaces.allHidden")}
                    description={t("workspaces.allHiddenText", { n: secondaryCount })}
                    action={
                        <Button
                            variant="ghost"
                            aria-pressed={false}
                            aria-label={t("workspaces.showHiddenAria")}
                            data-testid="workspaces-show-all"
                            onClick={toggleShowAll}
                        >
                            <Icon name="eye" />
                            {t("workspaces.showHidden", { n: secondaryCount })}
                        </Button>
                    }
                />
            </section>
        );
    } else {
        main = (
            <>
                <div className="ws-grid">
                    {items.map((workspace) => (
                        <WorkspaceCard key={workspace.workspaceId} workspace={workspace} />
                    ))}
                </div>
                {showHiddenToggle ? (
                    <div className="ws-hidden-bar">
                        <button
                            type="button"
                            className="ws-hidden-toggle"
                            aria-pressed={showAll}
                            aria-label={t(showAll ? "workspaces.hideHidden" : "workspaces.showHiddenAria")}
                            data-testid="workspaces-show-all"
                            onClick={toggleShowAll}
                        >
                            <Icon name="eye" />
                            <span>{t(showAll ? "workspaces.hideHidden" : "workspaces.showHidden", { n: secondaryCount })}</span>
                            <Icon name="chevron-right" className={showAll ? "ws-hidden-toggle__chevron is-open" : "ws-hidden-toggle__chevron"} />
                        </button>
                        {showAll ? null : <span className="ws-hidden-bar__hint faint">{t("workspaces.hiddenHint")}</span>}
                    </div>
                ) : null}
            </>
        );
    }

    return (
        <div className="ws-page">
            <PageHeader
                title={t("workspaces.title")}
                subtitle={t("workspaces.subtitle")}
                docTitle={t("nav.workspaces")}
                actions={
                    hasCards ? (
                        <Button variant="primary" onClick={() => setDialogOpen(true)}>
                            <Icon name="plus" />
                            {t("workspaces.new")}
                        </Button>
                    ) : null
                }
            />

            <WorkspaceStatusLine
                server={server}
                workspaceCount={items.length}
                sessionCount={sessionCount}
                runningCount={runningCount}
            />

            <div className="ws-layout">
                <div className="ws-main">{main}</div>
                <ActivityColumn workspaces={items} />
            </div>

            <NewWorkspaceDialog
                open={dialogOpen}
                onOpenChange={setDialogOpen}
                onCreate={createWorkspace}
                onRetryOpen={(workspaceId) => {
                    // The workspace already exists; the name is settled server-side.
                    const row = all.find((item) => item.workspaceId === workspaceId);
                    return finishOpen(workspaceId, row?.name?.trim() || (row ? basename(row.cwd) : workspaceId));
                }}
            />
        </div>
    );
}
