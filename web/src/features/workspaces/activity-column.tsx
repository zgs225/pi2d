import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { RelativeTime } from "@/components/shared/relative-time";
import { Empty } from "@/components/ui/empty";
import { StatusDot } from "@/components/ui/status-dot";
import { sessionDot, sessionStatusKey } from "@/features/chat/session-state";
import { sessionTitle } from "@/features/chat/session-title";
import type { WorkspaceInfo } from "@/lib/protocol";

import { useRecentSessions, type RecentSessionRow } from "./recent-sessions";

export interface ActivityColumnProps {
    workspaces: readonly WorkspaceInfo[];
}

/**
 * "Recent activity" column (pi2-web-ui-design v0.1.1 §5.1): the newest
 * `RECENT_SESSION_LIMIT` sessions across every visible workspace, dot + title +
 * owning-workspace + relative time, each row linking into the chat UI.
 *
 * Two read-only sources feed it (`features/workspaces/recent-sessions.ts`): the
 * daemon's disk feed (survives restarts, never spawns an instance) and the
 * per-workspace session list for live instances (adds names and live status).
 */
export function ActivityColumn({ workspaces }: ActivityColumnProps) {
    const { t } = useTranslation();
    const sessions = useRecentSessions(workspaces, workspaces.length > 0);
    const phrases = {
        unnamed: t("chat.sessionUnnamed"),
        subagentUnnamed: t("chat.subagentUnnamed"),
    };

    return (
        <aside className="ws-activity" aria-label={t("workspaces.activity")} data-testid="workspaces-activity">
            <div className="ws-activity__head">
                <span className="section-label ws-activity__label">{t("workspaces.activity")}</span>
                {sessions.length > 0 ? <span className="ws-activity__count tabular">{sessions.length}</span> : null}
            </div>
            {sessions.length > 0 ? (
                <div className="ws-activity__list">
                    {sessions.map((session) => (
                        <ActivityRow key={session.sessionId} session={session} phrases={phrases} />
                    ))}
                </div>
            ) : (
                <Empty icon={<Icon name="clock" size={22} />} title={t("workspaces.activityEmpty")} />
            )}
        </aside>
    );
}

type Phrases = { unnamed: string; subagentUnnamed: string };

function ActivityRow({ session, phrases }: { session: RecentSessionRow; phrases: Phrases }) {
    const { t } = useTranslation();
    // A disk-only row has no live state; the session title contract then falls
    // back to `(unnamed)` (never an id), and the dot is the hollow "exited".
    const title = session.state
        ? sessionTitle(session.state, phrases)
        : { text: phrases.unnamed, provisional: true, spinner: false };
    const dot = session.state ? sessionDot(session.state) : { status: "exited" as const };
    const label = session.state ? t(`state.${sessionStatusKey(session.state)}`) : t("state.exited");

    return (
        <Link
            to="/chat/$sessionId"
            params={{ sessionId: session.sessionId }}
            search={{ workspace: session.workspaceId }}
            className="ws-activity__row"
            data-session-id={session.sessionId}
            data-workspace-id={session.workspaceId}
            data-testid="workspace-activity-row"
        >
            <StatusDot status={dot.status} blink={dot.blink} title={label} />
            <span className="ws-activity__main">
                <span className="ws-activity__name">{title.text}</span>
                <span className="ws-activity__ws">{session.workspaceName}</span>
            </span>
            <RelativeTime ts={session.ts || null} className="ws-activity__rel" />
        </Link>
    );
}
