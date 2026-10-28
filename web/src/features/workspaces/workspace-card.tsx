import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import { plural } from "@/lib/i18n";
import type { WorkspaceInfo } from "@/lib/protocol";

import { workspaceName, workspaceSessionCount } from "./commands";
import { isSecondary, reasonLabelKey } from "./visibility";

/**
 * Aggregate row state → the card's "dot + text" pair (pi2-web-ui-design v0.1.1
 * §5.1: state is never colour-only). `/api/v1/workspaces` carries no session
 * list, so the workspace instance state is the whole aggregate here; the
 * prototype derives it from `MOCK.sessions`.
 */
export function instanceState(workspace: WorkspaceInfo): { status: DotStatus; labelKey: string } {
    if (!workspace.exists) return { status: "err", labelKey: "workspaces.instanceMissing" };
    // No instance row at all means "not started yet": this daemon starts one on
    // demand (opening the workspace), so "stopped" would be a lie.
    if (!workspace.instance) return { status: "idle", labelKey: "workspaces.instanceNotStarted" };
    switch (workspace.instance.status) {
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

/** Statuses where the daemon's `instance.reason` explains the label below it. */
const REASON_STATUSES: ReadonlySet<string> = new Set(["degraded", "stopped", "unmanaged"]);

/**
 * The instance's own explanation, but only for the states where it adds
 * information (a `ready` instance can still carry a stale reason).
 */
export function instanceReason(workspace: WorkspaceInfo): string | undefined {
    const instance = workspace.instance;
    const reason = instance?.reason?.trim();
    if (!instance || !reason) return undefined;
    return REASON_STATUSES.has(instance.status) ? reason : undefined;
}

export interface WorkspaceCardProps {
    workspace: WorkspaceInfo;
}

/**
 * One quiet card. The whole card is the link (native `<a>` from TanStack
 * `Link`, so Enter/Space and focus-visible come for free) — there is no
 * in-row primary "enter" button any more (§1.3).
 */
export function WorkspaceCard({ workspace }: WorkspaceCardProps) {
    const { t } = useTranslation();
    const name = workspaceName(workspace, t("workspaces.unnamed"));
    const state = instanceState(workspace);
    const stateLabel = t(state.labelKey);
    const count = workspaceSessionCount(workspace);
    const countLabel = plural("workspaces.sessionCount", count);
    // Secondary rows stay dimmed and carry the policy reason; the page decides
    // *whether* they render at all (see features/workspaces/visibility.ts).
    const secondary = isSecondary(workspace);
    const reasonKey = secondary ? reasonLabelKey(workspace) : null;
    const detail = instanceReason(workspace);

    return (
        <Link
            to="/chat"
            search={{ workspace: workspace.workspaceId }}
            className={secondary ? "ws-card card--quiet ws-card--secondary" : "ws-card card--quiet"}
            aria-label={`${name} — ${workspace.cwd} — ${countLabel}`}
            title={workspace.cwd}
            data-workspace-id={workspace.workspaceId}
            data-testid="workspace-row"
            data-visibility={secondary ? "secondary" : "default"}
            data-visibility-reason={reasonKey ? (workspace.visibilityReason ?? "hidden") : undefined}
        >
            <div className="ws-card__head">
                <span className="ico ws-card__icon" aria-hidden="true">
                    <Icon name="folder" />
                </span>
                <span className="ws-card__name truncate">{name}</span>
                <span className="ws-card__state">
                    <StatusDot status={state.status} title={stateLabel} />
                    <span>{stateLabel}</span>
                </span>
            </div>
            <div className="ws-card__cwd mono truncate">{workspace.cwd}</div>
            {detail ? (
                // Full text stays in `title`; the line itself is ellipsized by CSS.
                <div className="ws-card__note truncate" title={detail} data-testid="workspace-instance-reason">
                    {detail}
                </div>
            ) : null}
            <div className="ws-card__last">
                {count > 0 ? (
                    <>
                        <span className="ws-card__last-label">{t("workspaces.lastSession")}</span>
                        <RelativeTime ts={workspace.lastActiveAt} className="ws-card__last-rel" />
                    </>
                ) : (
                    <span className="ws-card__last-title faint">{t("workspaces.noSessions")}</span>
                )}
            </div>
            <div className="ws-card__foot">
                {reasonKey ? (
                    <Badge className="ws-card__reason" data-testid="workspace-reason">
                        {t(reasonKey)}
                    </Badge>
                ) : null}
                <span className="ws-card__count tabular">{countLabel}</span>
                <span className="ws-card__open">
                    <span>{t("workspaces.openWorkspace")}</span>
                    <Icon name="chevron-right" />
                </span>
            </div>
        </Link>
    );
}

/** Loading placeholder sized like a card (same 14px padding, same gaps). */
export function WorkspacesSkeleton() {
    const { t } = useTranslation();
    return (
        <div className="ws-skeleton" role="status" aria-label={t("common.loading")}>
            <span className="skeleton skeleton--icon" />
            <span className="skeleton skeleton--name" />
            <span className="skeleton skeleton--cwd" />
            <span className="skeleton skeleton--meta" />
        </div>
    );
}
