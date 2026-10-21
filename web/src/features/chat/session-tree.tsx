import type { SessionState, Subagent, WorkspaceInfo } from "@protocol/types";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { StatusDot, subagentDotClass } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { flattenSubagents, sessionDot, sessionStatusKey } from "./session-state";

export interface SessionTreeProps {
    sessions: SessionState[];
    workspaces?: WorkspaceInfo[];
    activeWorkspaceId?: string | null;
    selectedId?: string | null;
    filter: string;
    collapsed: Record<string, boolean>;
    connected?: boolean;
    creating?: boolean;
    onFilter: (value: string) => void;
    onToggleCollapse: (id: string) => void;
    onToggleAll: () => void;
    onSelectSession: (id: string) => void;
    onSelectWorkspace?: (id: string) => void;
    onNewSession: () => void;
    onRenameSession: (session: SessionState) => void;
    onCloseSession: (session: SessionState) => void;
    onOpenSubagent?: (session: SessionState, subagent: Subagent) => void;
    onRenameSubagent?: (subagent: Subagent) => void;
    onCloseDrawer?: () => void;
    className?: string;
}

function sessionName(session: SessionState, fallback: string): string {
    return session.name?.trim() || fallback;
}

function matchesFilter(session: SessionState, filter: string, fallback: string): boolean {
    if (!filter) return true;
    const needle = filter.toLowerCase();
    if (sessionName(session, fallback).toLowerCase().includes(needle)) return true;
    return flattenSubagents(session.subagents).some(({ subagent }) =>
        (subagent.name ?? "").toLowerCase().includes(needle),
    );
}

function ChevronToggle({
    hasChildren,
    collapsed,
    onClick,
}: {
    hasChildren: boolean;
    collapsed: boolean;
    onClick: () => void;
}) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            className={cn("tree-toggle", hasChildren ? (collapsed ? undefined : "open") : "leaf")}
            aria-label={collapsed ? t("chat.unfold") : t("chat.fold")}
            aria-expanded={hasChildren ? !collapsed : undefined}
            tabIndex={hasChildren ? 0 : -1}
            onClick={(event) => {
                event.stopPropagation();
                if (hasChildren) onClick();
            }}
        >
            <Icon name="chevron-right" />
        </button>
    );
}

function SubagentRow({
    session,
    subagent,
    collapsed,
    onToggleCollapse,
    onOpenSubagent,
    onRenameSubagent,
}: {
    session: SessionState;
    subagent: Subagent;
    collapsed: Record<string, boolean>;
    onToggleCollapse: (id: string) => void;
    onOpenSubagent?: (session: SessionState, subagent: Subagent) => void;
    onRenameSubagent?: (subagent: Subagent) => void;
}) {
    const { t } = useTranslation();
    const children = subagent.children ?? [];
    const isCollapsed = collapsed[subagent.id] === true;
    const status = t(`state.${subagent.status}`);
    const name = subagent.name ?? subagent.id;
    return (
        <li>
            <div
                className="tree-row tree-row--sub"
                role="button"
                tabIndex={0}
                aria-label={name}
                onClick={() => onOpenSubagent?.(session, subagent)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpenSubagent?.(session, subagent);
                    }
                }}
            >
                <ChevronToggle
                    hasChildren={children.length > 0}
                    collapsed={isCollapsed}
                    onClick={() => onToggleCollapse(subagent.id)}
                />
                <span className={cn("dot", subagentDotClass(subagent.status))} title={status} />
                <span className="t-main">
                    <span className="t-name truncate">{name}</span>
                    <span className="t-sub truncate muted">
                        {subagent.model ?? "—"}
                        {subagent.thinking ? ` · ${subagent.thinking}` : ""}
                    </span>
                </span>
                <span className="t-actions">
                    <button
                        type="button"
                        className="icon-btn"
                        title={t("chat.preview")}
                        aria-label={t("chat.previewSubagent")}
                        onClick={(event) => {
                            event.stopPropagation();
                            onOpenSubagent?.(session, subagent);
                        }}
                    >
                        <Icon name="eye" />
                    </button>
                    <button
                        type="button"
                        className="icon-btn"
                        title={t("chat.rename")}
                        aria-label={t("chat.renameSubagentAria")}
                        onClick={(event) => {
                            event.stopPropagation();
                            onRenameSubagent?.(subagent);
                        }}
                    >
                        <Icon name="edit" />
                    </button>
                </span>
            </div>
            {children.length && !isCollapsed ? (
                <ul>
                    {children.map((child) => (
                        <SubagentRow
                            key={child.id}
                            session={session}
                            subagent={child}
                            collapsed={collapsed}
                            onToggleCollapse={onToggleCollapse}
                            onOpenSubagent={onOpenSubagent}
                            onRenameSubagent={onRenameSubagent}
                        />
                    ))}
                </ul>
            ) : null}
        </li>
    );
}

function SessionRow({
    session,
    selected,
    collapsed,
    onToggleCollapse,
    onSelectSession,
    onRenameSession,
    onCloseSession,
    onOpenSubagent,
    onRenameSubagent,
}: {
    session: SessionState;
    selected: boolean;
    collapsed: Record<string, boolean>;
    onToggleCollapse: (id: string) => void;
    onSelectSession: (id: string) => void;
    onRenameSession: (session: SessionState) => void;
    onCloseSession: (session: SessionState) => void;
    onOpenSubagent?: (session: SessionState, subagent: Subagent) => void;
    onRenameSubagent?: (subagent: Subagent) => void;
}) {
    const { t } = useTranslation();
    const subagents = session.subagents ?? [];
    const isCollapsed = collapsed[session.sessionId] === true;
    const dot = sessionDot(session);
    const status = t(`state.${sessionStatusKey(session)}`);
    const name = sessionName(session, session.sessionId);
    return (
        <li>
            <div
                className={cn("tree-row", selected && "selected")}
                role="button"
                tabIndex={0}
                aria-label={name}
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelectSession(session.sessionId)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectSession(session.sessionId);
                    }
                }}
            >
                <ChevronToggle
                    hasChildren={subagents.length > 0}
                    collapsed={isCollapsed}
                    onClick={() => onToggleCollapse(session.sessionId)}
                />
                <StatusDot status={dot} title={status} />
                <span className="t-main">
                    <span className="t-name truncate">
                        {name}
                        {session.flags.attention && session.attention.length ? (
                            <Badge tone="warn">{`!${session.attention.length}`}</Badge>
                        ) : null}
                    </span>
                    <span className="t-sub truncate muted">
                        {session.model?.id ?? "—"}
                        {session.thinking ? ` · ${session.thinking}` : ""}
                    </span>
                </span>
                {subagents.length ? (
                    <span className="t-meta" title={t("chat.subagentCount", { n: subagents.length })}>
                        {`(${subagents.length})`}
                    </span>
                ) : null}
                <span className="t-actions">
                    <button
                        type="button"
                        className="icon-btn"
                        title={t("chat.rename")}
                        aria-label={t("chat.renameSession")}
                        onClick={(event) => {
                            event.stopPropagation();
                            onRenameSession(session);
                        }}
                    >
                        <Icon name="edit" />
                    </button>
                    <button
                        type="button"
                        className="icon-btn icon-btn--danger"
                        title={t("chat.closeProcess")}
                        aria-label={t("chat.closeProcess")}
                        onClick={(event) => {
                            event.stopPropagation();
                            onCloseSession(session);
                        }}
                    >
                        <Icon name="x" />
                    </button>
                </span>
            </div>
            {subagents.length && !isCollapsed ? (
                <ul>
                    {subagents.map((subagent) => (
                        <SubagentRow
                            key={subagent.id}
                            session={session}
                            subagent={subagent}
                            collapsed={collapsed}
                            onToggleCollapse={onToggleCollapse}
                            onOpenSubagent={onOpenSubagent}
                            onRenameSubagent={onRenameSubagent}
                        />
                    ))}
                </ul>
            ) : null}
        </li>
    );
}

/** Left sidebar: workspace picker + indent-only session/subagent tree. */
export function SessionTree({
    sessions,
    workspaces = [],
    activeWorkspaceId,
    selectedId,
    filter,
    collapsed,
    connected = false,
    creating = false,
    onFilter,
    onToggleCollapse,
    onToggleAll,
    onSelectSession,
    onSelectWorkspace,
    onNewSession,
    onRenameSession,
    onCloseSession,
    onOpenSubagent,
    onRenameSubagent,
    onCloseDrawer,
    className,
}: SessionTreeProps) {
    const { t } = useTranslation();
    const visible = sessions.filter((session) => matchesFilter(session, filter, session.sessionId));
    const allIds = sessions.flatMap((session) => [
        session.sessionId,
        ...flattenSubagents(session.subagents).map(({ subagent }) => subagent.id),
    ]);
    const anyOpen = allIds.some((id) => !collapsed[id]);
    const activeWorkspace = workspaces.find((workspace) => workspace.workspaceId === activeWorkspaceId);
    const workspaceLabel = activeWorkspace?.name ?? activeWorkspace?.cwd ?? t("chat.workspace");

    return (
        <div className={cn("tree-pane__inner", className)} aria-label={t("chat.treeAria")}>
            <div className="pane-head">
                {workspaces.length ? (
                    <div className="row">
                        <select
                            className="select tree-workspace"
                            aria-label={t("chat.workspace")}
                            value={activeWorkspaceId ?? ""}
                            onChange={(event) => onSelectWorkspace?.(event.target.value)}
                            title={activeWorkspace?.cwd ?? workspaceLabel}
                        >
                            {workspaces.map((workspace) => (
                                <option key={workspace.workspaceId} value={workspace.workspaceId}>
                                    {workspace.name}
                                </option>
                            ))}
                        </select>
                        {onCloseDrawer ? (
                            <button
                                type="button"
                                className="icon-btn tree-close"
                                title={t("common.close")}
                                aria-label={t("chat.closeTree")}
                                onClick={onCloseDrawer}
                            >
                                <Icon name="x" />
                            </button>
                        ) : null}
                    </div>
                ) : null}
                <div className="row">
                    <Input
                        type="search"
                        className="tree-search"
                        value={filter}
                        placeholder={t("chat.search")}
                        aria-label={t("chat.searchAria")}
                        onChange={(event) => onFilter(event.target.value)}
                    />
                    {onCloseDrawer && !workspaces.length ? (
                        <button
                            type="button"
                            className="icon-btn tree-close"
                            title={t("common.close")}
                            aria-label={t("chat.closeTree")}
                            onClick={onCloseDrawer}
                        >
                            <Icon name="x" />
                        </button>
                    ) : null}
                </div>
                <div className="row">
                    <button type="button" className="btn btn--sm" onClick={onNewSession} disabled={creating}>
                        <Icon name="plus" />
                        {t("chat.newSession")}
                    </button>
                    <div className="spacer" />
                    <span className="tree-conn">
                        <StatusDot status={connected ? "ok" : "exited"} />
                        <span className="muted">{t(connected ? "state.online" : "state.offline")}</span>
                    </span>
                    <button
                        type="button"
                        className="icon-btn"
                        title={t("chat.toggleAll")}
                        aria-label={t("chat.toggleAllAria")}
                        onClick={onToggleAll}
                    >
                        <Icon name={anyOpen ? "chevron-down" : "chevron-right"} />
                    </button>
                </div>
            </div>
            <div className="pane-scroll">
                {visible.length ? (
                    <ul className="tree">
                        {visible.map((session) => (
                            <SessionRow
                                key={session.sessionId}
                                session={session}
                                selected={session.sessionId === selectedId}
                                collapsed={collapsed}
                                onToggleCollapse={onToggleCollapse}
                                onSelectSession={onSelectSession}
                                onRenameSession={onRenameSession}
                                onCloseSession={onCloseSession}
                                onOpenSubagent={onOpenSubagent}
                                onRenameSubagent={onRenameSubagent}
                            />
                        ))}
                    </ul>
                ) : sessions.length ? (
                    <Empty
                        icon={<Icon name="search" />}
                        title={t("chat.noMatch")}
                        description={t("chat.tryOther")}
                    />
                ) : (
                    <Empty
                        icon={<Icon name="chat" />}
                        title={t("chat.noSessions")}
                        description={t("chat.noSessionsText")}
                        action={
                            <button type="button" className="btn btn--sm" onClick={onNewSession} disabled={creating}>
                                <Icon name="plus" />
                                {t("chat.newSession")}
                            </button>
                        }
                    />
                )}
            </div>
        </div>
    );
}
