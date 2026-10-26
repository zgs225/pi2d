import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import type { ServerIdentity } from "@/features/status/server";
import { plural } from "@/lib/i18n";

function serverDot(status: ServerIdentity["status"]): DotStatus {
    if (status === "online") return "ok";
    if (status === "degraded") return "attention";
    return "exited";
}

export interface WorkspaceStatusLineProps {
    server: ServerIdentity;
    workspaceCount: number;
    sessionCount: number;
    runningCount: number;
}

/**
 * Single-server identity as one quiet `.status-line` (pi2-web-ui-design v0.1.1
 * §5.1): dot + name + hostname:port + workspace count + session/running
 * summary + the status link. No card, no border — a surface-1 strip only.
 */
export function WorkspaceStatusLine({ server, workspaceCount, sessionCount, runningCount }: WorkspaceStatusLineProps) {
    const { t } = useTranslation();
    const hostPort = `${server.hostname}${server.port != null ? `:${server.port}` : ""}`;
    const statusLabel = t(`state.${server.status}`);

    return (
        <section
            className="status-line ws-status-line"
            role="group"
            aria-label={t("workspaces.contextAria")}
            data-testid="workspaces-status-line"
        >
            <StatusDot status={serverDot(server.status)} className="dot--lg" title={statusLabel} />
            <span className="status-line__name">{server.name}</span>
            <span className="sep ws-sep-host" aria-hidden="true">
                ·
            </span>
            <span className="mono ws-status-host">{hostPort}</span>
            <span className="sep ws-sep-count" aria-hidden="true">
                ·
            </span>
            <span className="tabular ws-status-count">{plural("workspaces.count", workspaceCount)}</span>
            <span className="sep ws-sep-summary" aria-hidden="true">
                ·
            </span>
            <span className="tabular ws-status-summary">
                {t("workspaces.serverSummary", { sessions: sessionCount, running: runningCount })}
            </span>
            <span className="spacer" />
            <Link
                to="/status"
                className="ws-status-link"
                title={t("workspaces.openStatus")}
                aria-label={`${t("workspaces.openStatus")}: ${server.name}`}
            >
                <span>{t("workspaces.openStatus")}</span>
                <Icon name="chevron-right" />
            </Link>
        </section>
    );
}
