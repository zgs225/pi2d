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

    const items = useMemo(
        () => (workspaces.data ?? []).filter((workspace) => !workspace.hidden).slice().sort(compareWorkspaces),
        [workspaces.data],
    );
    const sessionCount = useMemo(
        () => items.reduce((total, workspace) => total + Math.max(workspace.liveCount || 0, workspace.sessionCount || 0), 0),
        [items],
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
                    <Button variant="primary" onClick={() => setDialogOpen(true)}>
                        <Icon name="plus" />
                        {t("workspaces.new")}
                    </Button>
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
            ) : items.length === 0 ? (
                <Panel>
                    <Empty
                        icon={<Icon name="folder" size={28} />}
                        title={t("workspaces.emptyTitle")}
                        description={t("workspaces.emptyText")}
                        action={
                            <Button variant="primary" onClick={() => setDialogOpen(true)}>
                                <Icon name="plus" />
                                {t("workspaces.new")}
                            </Button>
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
