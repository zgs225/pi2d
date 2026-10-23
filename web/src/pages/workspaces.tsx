import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { toast } from "@/components/ui/toast";
import { deriveServerIdentity, type InfoExtras } from "@/features/status/server";
import { useInfoQuery, useWorkspacesQuery } from "@/features/status/queries";
import { openWorkspace } from "@/features/workspaces/commands";
import { NewWorkspaceDialog, type NewWorkspaceInput } from "@/features/workspaces/new-workspace-dialog";
import {
    countSecondary,
    partitionWorkspaces,
    readShowAll,
    writeShowAll,
} from "@/features/workspaces/visibility";
import {
    ServerContextBar,
    WorkspaceRow,
    WorkspacesSkeleton,
} from "@/features/workspaces/workspace-row";
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

export function WorkspacesPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [dialogOpen, setDialogOpen] = useState(false);

    const endpoint = useConnectionStore((state) => state.endpoint);
    const wsState = useConnectionStore((state) => state.wsState);
    const storedServer = useConnectionStore((state) => state.server);

    const workspaces = useWorkspacesQuery();
    const info = useInfoQuery();

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
        () => primary.reduce((total, workspace) => total + Math.max(workspace.liveCount || 0, workspace.sessionCount || 0), 0),
        [primary],
    );

    const server = deriveServerIdentity({
        info: info.data as InfoExtras | undefined,
        endpoint,
        wsState,
        fetchedAt: info.dataUpdatedAt || null,
        nameFallback: storedServer?.name,
        status: info.isError ? "offline" : undefined,
    });

    async function createWorkspace(input: NewWorkspaceInput) {
        const workspaceId = await openWorkspace(input);
        await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
        toast.success(t("workspaces.opened", { name: input.name?.trim() || basename(input.cwd) }));
        navigate({ href: `/chat?workspace=${encodeURIComponent(workspaceId)}` });
    }

    const errorText =
        workspaces.error instanceof ApiError
            ? t(errorI18nKey(workspaces.error.code))
            : t("workspaces.loadErrorText");

    return (
        <div className="ws-page">
            <PageHeader
                title={t("workspaces.title")}
                subtitle={t("workspaces.subtitle")}
                docTitle={t("nav.workspaces")}
                actions={
                    <>
                        {secondaryCount > 0 ? (
                            <Button
                                variant={showAll ? "default" : "ghost"}
                                aria-pressed={showAll}
                                aria-label={t("workspaces.showHiddenAria")}
                                data-testid="workspaces-show-all"
                                onClick={toggleShowAll}
                            >
                                <Icon name="eye" />
                                {t(showAll ? "workspaces.hideHidden" : "workspaces.showHidden", { n: secondaryCount })}
                            </Button>
                        ) : null}
                        <Button variant="primary" onClick={() => setDialogOpen(true)}>
                            <Icon name="plus" />
                            {t("workspaces.new")}
                        </Button>
                    </>
                }
            />

            <ServerContextBar server={server} workspaceCount={items.length} sessionCount={sessionCount} />

            {workspaces.isPending ? (
                <Panel className="ws-panel">
                    <div className="panel__body ws-panel__body">
                        <WorkspacesSkeleton />
                        <WorkspacesSkeleton />
                        <WorkspacesSkeleton />
                    </div>
                </Panel>
            ) : workspaces.isError ? (
                <Panel>
                    <Empty
                        icon={<Icon name="alert" size={28} />}
                        title={t("workspaces.loadErrorTitle")}
                        description={`${t("workspaces.loadErrorText")} (${errorText})`}
                        action={
                            <Button variant="primary" onClick={() => void workspaces.refetch()}>
                                <Icon name="refresh" />
                                {t("common.retry")}
                            </Button>
                        }
                    />
                </Panel>
            ) : all.length === 0 || (primary.length === 0 && !showAll) ? (
                <Panel>
                    <Empty
                        icon={<Icon name="folder" size={28} />}
                        title={all.length === 0 ? t("workspaces.emptyTitle") : t("workspaces.allHidden")}
                        description={all.length === 0 ? t("workspaces.emptyText") : t("workspaces.allHiddenText", { n: secondaryCount })}
                        action={
                            all.length === 0 ? (
                                <Button variant="primary" onClick={() => setDialogOpen(true)}>
                                    <Icon name="plus" />
                                    {t("workspaces.new")}
                                </Button>
                            ) : (
                                <Button variant="ghost" onClick={toggleShowAll}>
                                    <Icon name="eye" />
                                    {t("workspaces.showHidden", { n: secondaryCount })}
                                </Button>
                            )
                        }
                    />
                </Panel>
            ) : (
                <Panel className="ws-panel">
                    <div className="panel__body ws-panel__body">
                        {items.map((workspace) => (
                            <WorkspaceRow key={workspace.workspaceId} workspace={workspace} />
                        ))}
                    </div>
                </Panel>
            )}

            <NewWorkspaceDialog open={dialogOpen} onOpenChange={setDialogOpen} onCreate={createWorkspace} />
        </div>
    );
}
