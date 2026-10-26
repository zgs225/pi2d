import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { RelativeTime } from "@/components/shared/relative-time";
import { Empty } from "@/components/ui/empty";
import { StatusDot } from "@/components/ui/status-dot";
import { plural } from "@/lib/i18n";
import type { WorkspaceInfo } from "@/lib/protocol";

import { workspaceName, workspaceSessionCount } from "./commands";
import { instanceState } from "./workspace-card";

/** The design lists the newest 5 entries. */
export const ACTIVITY_LIMIT = 5;

export interface ActivityColumnProps {
    workspaces: readonly WorkspaceInfo[];
}

/**
 * "Recent activity" column (pi2-web-ui-design v0.1.1 §5.1): the newest
 * `ACTIVITY_LIMIT` entries by `lastActiveAt`, dot + name + meta + relative
 * time, each row linking into the chat UI.
 *
 * The prototype derives it from `MOCK.sessions`; the daemon exposes no
 * cross-workspace session feed (only `/workspaces/<id>/sessions`), so the rows
 * are workspace-level and the meta slot carries the session count instead of
 * the owning workspace name.
 */
export function ActivityColumn({ workspaces }: ActivityColumnProps) {
    const { t } = useTranslation();
    const recent = [...workspaces]
        .filter((workspace) => typeof workspace.lastActiveAt === "number" && Number.isFinite(workspace.lastActiveAt))
        .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
        .slice(0, ACTIVITY_LIMIT);

    return (
        <aside className="ws-activity" aria-label={t("workspaces.activity")} data-testid="workspaces-activity">
            <div className="ws-activity__head">
                <span className="section-label ws-activity__label">{t("workspaces.activity")}</span>
                {recent.length > 0 ? <span className="ws-activity__count tabular">{recent.length}</span> : null}
            </div>
            {recent.length > 0 ? (
                <div className="ws-activity__list">
                    {recent.map((workspace) => {
                        const state = instanceState(workspace);
                        return (
                            <Link
                                key={workspace.workspaceId}
                                to="/chat"
                                search={{ workspace: workspace.workspaceId }}
                                className="ws-activity__row"
                                data-workspace-id={workspace.workspaceId}
                                data-testid="workspace-activity-row"
                            >
                                <StatusDot status={state.status} title={t(state.labelKey)} />
                                <span className="ws-activity__main">
                                    <span className="ws-activity__name">
                                        {workspaceName(workspace, t("workspaces.unnamed"))}
                                    </span>
                                    <span className="ws-activity__ws">
                                        {plural("workspaces.sessionCount", workspaceSessionCount(workspace))}
                                    </span>
                                </span>
                                <RelativeTime ts={workspace.lastActiveAt} className="ws-activity__rel" />
                            </Link>
                        );
                    })}
                </div>
            ) : (
                <Empty icon={<Icon name="clock" size={22} />} title={t("workspaces.activityEmpty")} />
            )}
        </aside>
    );
}
