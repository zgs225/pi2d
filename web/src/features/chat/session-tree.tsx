import type { SessionState, Subagent, WorkspaceInfo } from "@protocol/types";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { StatusDot, subagentDotClass } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { flattenSubagents, sessionDot, sessionStatusKey } from "./session-state";
import {
    buildSessionTree,
    treeNodeId,
    treeNodeKey,
    type SessionTreeNode,
    type SubagentTreeNode,
    type TreeNode,
} from "./session-tree-model";

export interface SessionTreeProps {
    sessions: SessionState[];
    workspaces?: WorkspaceInfo[];
    activeWorkspaceId?: string | null;
    selectedId?: string | null;
    filter: string;
    collapsed: Record<string, boolean>;
    /** Render sub-sessions the plugin marked `visible: false`. */
    showHidden: boolean;
    connected?: boolean;
    creating?: boolean;
    onFilter: (value: string) => void;
    onToggleCollapse: (id: string) => void;
    onToggleAll: () => void;
    onToggleShowHidden: () => void;
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

interface TreeHandlers {
    onToggleCollapse: (id: string) => void;
    onSelectSession: (id: string) => void;
    onRenameSession: (session: SessionState) => void;
    onCloseSession: (session: SessionState) => void;
    onOpenSubagent?: (session: SessionState, subagent: Subagent) => void;
    onRenameSubagent?: (subagent: Subagent) => void;
}

/**
 * One row of the session tree plus its children.
 *
 * A real child session renders as a `tree-row--sub` (indent only, no vertical
 * guides) and navigates to its own transcript; a manifest subagent keeps the
 * eye/rename affordances of the subagent preview.
 */
function TreeRow({
    node,
    selectedId,
    collapsed,
    ...handlers
}: TreeHandlers & { node: TreeNode; selectedId?: string | null; collapsed: Record<string, boolean> }) {
    const isCollapsed = collapsed[treeNodeId(node)] === true && !node.forcedOpen;
    return (
        <li>
            {node.kind === "session" ? (
                <SessionNodeRow
                    node={node}
                    collapsed={isCollapsed}
                    selected={node.session.sessionId === selectedId}
                    {...handlers}
                />
            ) : (
                <SubagentNodeRow node={node} collapsed={isCollapsed} {...handlers} />
            )}
            {node.children.length && !isCollapsed ? (
                <ul>
                    {node.children.map((child) => (
                        <TreeRow
                            key={treeNodeKey(child)}
                            node={child}
                            collapsed={collapsed}
                            selectedId={selectedId}
                            {...handlers}
                        />
                    ))}
                </ul>
            ) : null}
        </li>
    );
}

function SessionNodeRow({
    node,
    collapsed,
    selected,
    onToggleCollapse,
    onSelectSession,
    onRenameSession,
    onCloseSession,
}: {
    node: SessionTreeNode;
    collapsed: boolean;
    selected: boolean;
} & Pick<TreeHandlers, "onToggleCollapse" | "onSelectSession" | "onRenameSession" | "onCloseSession">) {
    const { t } = useTranslation();
    const session = node.session;
    const status = t(`state.${sessionStatusKey(session)}`);
    const name = sessionName(session, session.sessionId);
    return (
        <div
            className={cn("tree-row", node.depth > 0 && "tree-row--sub", selected && "selected")}
            role="button"
            tabIndex={0}
            aria-label={name}
            aria-current={selected ? "true" : undefined}
            data-session-id={session.sessionId}
            data-hidden={node.hidden ? "true" : undefined}
            onClick={() => onSelectSession(session.sessionId)}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectSession(session.sessionId);
                }
            }}
        >
            <ChevronToggle
                hasChildren={node.children.length > 0}
                collapsed={collapsed}
                onClick={() => onToggleCollapse(session.sessionId)}
            />
            <StatusDot status={sessionDot(session)} title={status} />
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
            {node.childCount ? (
                <span className="t-meta" title={t("chat.childCount", { n: node.childCount })}>
                    {`(${node.childCount})`}
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
    );
}

function SubagentNodeRow({
    node,
    collapsed,
    onToggleCollapse,
    onOpenSubagent,
    onRenameSubagent,
}: {
    node: SubagentTreeNode;
    collapsed: boolean;
} & Pick<TreeHandlers, "onToggleCollapse" | "onOpenSubagent" | "onRenameSubagent">) {
    const { t } = useTranslation();
    const { session, subagent } = node;
    const status = t(`state.${subagent.status}`);
    const name = subagent.name ?? subagent.id;
    return (
        <div
            className="tree-row tree-row--sub"
            role="button"
            tabIndex={0}
            aria-label={name}
            data-subagent-id={subagent.id}
            data-hidden={node.hidden ? "true" : undefined}
            onClick={() => onOpenSubagent?.(session, subagent)}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenSubagent?.(session, subagent);
                }
            }}
        >
            <ChevronToggle
                hasChildren={node.children.length > 0}
                collapsed={collapsed}
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
            {node.childCount ? (
                <span className="t-meta" title={t("chat.childCount", { n: node.childCount })}>
                    {`(${node.childCount})`}
                </span>
            ) : null}
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
    showHidden,
    connected = false,
    creating = false,
    onFilter,
    onToggleCollapse,
    onToggleAll,
    onToggleShowHidden,
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
    const nodes = useMemo(
        () => buildSessionTree(sessions, { filter, showHidden, selectedId }),
        [sessions, filter, showHidden, selectedId],
    );
    // Every id — including rows the visibility policy or the filter dropped — so
    // "collapse all" also folds folded-away parents.
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
                        className={cn("icon-btn", showHidden && "is-on")}
                        title={t("chat.showHidden")}
                        aria-label={t("chat.showHiddenAria")}
                        aria-pressed={showHidden}
                        onClick={onToggleShowHidden}
                    >
                        <Icon name="eye" />
                    </button>
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
                {nodes.length ? (
                    <ul className="tree">
                        {nodes.map((node) => (
                            <TreeRow
                                key={treeNodeKey(node)}
                                node={node}
                                selectedId={selectedId}
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
                ) : filter.trim() ? (
                    <Empty
                        icon={<Icon name="search" />}
                        title={t("chat.noMatch")}
                        description={t("chat.tryOther")}
                    />
                ) : sessions.length ? (
                    <Empty
                        icon={<Icon name="eye" />}
                        title={t("chat.allHidden")}
                        description={t("chat.allHiddenText")}
                        action={
                            <button type="button" className="btn btn--sm" onClick={onToggleShowHidden}>
                                <Icon name="eye" />
                                {t("chat.showHidden")}
                            </button>
                        }
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
