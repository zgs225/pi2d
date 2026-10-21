import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import type { ServerIdentity } from "@/features/status/server";
import { plural } from "@/lib/i18n";
import type { WorkspaceInfo } from "@/lib/protocol";

import { workspaceName } from "./commands";

function serverDot(status: ServerIdentity["status"]): DotStatus {
    if (status === "online") return "ok";
    if (status === "degraded") return "attention";
    return "exited";
}

export interface ServerContextBarProps {
    server: ServerIdentity;
    workspaceCount: number;
    sessionCount: number;
}

/** Single-server identity bar: dot + name + hostname:port + counts + status link. */
export function ServerContextBar({ server, workspaceCount, sessionCount }: ServerContextBarProps) {
    const { t } = useTranslation();
    const hostPort = `${server.hostname}${server.port != null ? `:${server.port}` : ""}`;

    return (
        <section className="ws-context" aria-label={t("workspaces.contextAria")}>
            <StatusDot status={serverDot(server.status)} title={t(`state.${server.status}`)} />
            <span className="ws-context__name truncate">{server.name}</span>
            <span className="ws-context__host mono muted">{hostPort}</span>
            <Badge tone="info">{plural("workspaces.count", workspaceCount)}</Badge>
            <Badge>{plural("workspaces.sessionCount", sessionCount)}</Badge>
            <span className="spacer" />
            <Link
                to="/status"
                className="ws-context__link"
                title={t("workspaces.contextAria")}
                aria-label={`${t("workspaces.contextAria")}: ${server.name} — ${t("workspaces.openStatus")}`}
            >
                {t("workspaces.openStatus")}
                <Icon name="chevron-right" />
            </Link>
        </section>
    );
}

function instanceDot(workspace: WorkspaceInfo): { status: DotStatus; labelKey: string } {
    if (!workspace.exists) return { status: "err", labelKey: "workspaces.instanceMissing" };
    const status = workspace.instance?.status;
    switch (status) {
        case "ready":
            return { status: "ok", labelKey: "workspaces.instanceReady" };
        case "starting":
            return { status: "busy", labelKey: "workspaces.instanceStarting" };
        case "degraded":
            return { status: "attention", labelKey: "workspaces.instanceDegraded" };
        case "stopping":
            return { status: "attention", labelKey: "workspaces.instanceStopping" };
        case "unmanaged":
            return { status: "idle", labelKey: "workspaces.instanceUnmanaged" };
        case "stopped":
        default:
            return { status: "exited", labelKey: "workspaces.instanceStopped" };
    }
}

export interface WorkspaceRowProps {
    workspace: WorkspaceInfo;
}

/** One flat workspace row (folder + name + full cwd + count + rel + dot + enter). */
export function WorkspaceRow({ workspace }: WorkspaceRowProps) {
    const { t } = useTranslation();
    const dot = instanceDot(workspace);
    const count = Math.max(workspace.liveCount || 0, workspace.sessionCount || 0);

    return (
        <div className="list-row" data-workspace-id={workspace.workspaceId}>
            <span className="ico list-row__icon">
                <Icon name="folder" />
            </span>
            <div className="list-row__main">
                <div className="list-row__name">{workspaceName(workspace, t("workspaces.unnamed"))}</div>
                <div className="list-row__cwd mono muted truncate">{workspace.cwd}</div>
            </div>
            <Badge tone="info" className="list-row__count">
                {plural("workspaces.sessionCount", count)}
            </Badge>
            <RelativeTime ts={workspace.lastActiveAt} className="list-row__rel muted" />
            <StatusDot status={dot.status} title={t(dot.labelKey)} />
            <a
                className="btn btn--sm btn--primary list-row__go"
                href={`/chat?workspace=${encodeURIComponent(workspace.workspaceId)}`}
            >
                {t("workspaces.enter")}
            </a>
        </div>
    );
}

export function WorkspacesSkeleton() {
    const { t } = useTranslation();
    return (
        <div className="list-row list-row--skeleton" role="status" aria-label={t("common.loading")}>
            <span className="skeleton skeleton--icon" />
            <div className="list-row__main">
                <span className="skeleton skeleton--name" />
                <span className="skeleton skeleton--cwd" />
            </div>
            <span className="skeleton skeleton--badge" />
            <span className="skeleton skeleton--time" />
            <span className="skeleton skeleton--dot" />
            <span className="skeleton skeleton--go" />
        </div>
    );
}
