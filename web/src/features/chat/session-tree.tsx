import type { SessionState, Subagent, WorkspaceInfo } from "@protocol/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Empty } from "@/components/ui/empty";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { SessionRowMenu } from "./session-row-menu";
import { childSessionDot, flattenSubagents, sessionDot, subagentDot } from "./session-state";
import { sessionTitle, subagentTitle } from "./session-title";
import { SessionTitleSpinner } from "./session-title-spinner";
import {
    buildSessionTreeView,
    treeNodeId,
    treeNodeKey,
    type SessionTreeNode,
    type SubagentTreeNode,
    type TreeNode,
} from "./session-tree-model";
import { WorkspaceSwitch } from "./workspace-switch";

/**
 * Left rail of the chat page (v0.1.1 Chat IA v3, CHG-2026-10-26-10/11/12/13/17).
 *
 * One workspace, one flat-indent tree: every row is a *single* line
 * (`.tree-row__main` = status dot + name + `!N` attention), hierarchy is
 * expressed by indentation only, and the per-row `…` button opens a body-level
 * anchored popover (`SessionRowMenu`). Sessions and sub-sessions/subagents are
 * selectable; the child view lives in the stream pane, not in a modal.
 *
 * The two filters are independent and deliberately so:
 * - `activeOnly` — the user's IA lens ("only live rows", persisted).
 * - `showHidden` — the plugin's `:PiSessions` visibility policy.
 */
export interface SessionTreeProps {
    /** Sessions of the active workspace only. */
    sessions: SessionState[];
    workspaces: WorkspaceInfo[];
    activeWorkspaceId: string | null;
    selectedId: string | null;
    /** Subagent shown in the in-place child view (`?sub=`); its row stays reachable. */
    activeSubagentId: string | null;
    filter: string;
    collapsed: Record<string, boolean>;
    /** IA lens: hide rows whose process is gone. */
    activeOnly: boolean;
    /** Render rows the plugin marked `visible: false`. */
    showHidden: boolean;
    /** Accepted for the page contract; the v0.1.1 tree shows no connection dot. */
    connected: boolean;
    creating: boolean;
    onFilter(value: string): void;
    onToggleCollapse(id: string): void;
    onToggleAll(): void;
    onToggleActiveOnly(): void;
    onToggleShowHidden(): void;
    onSelectSession(id: string): void;
    onSelectWorkspace(id: string): void;
    onSelectSubagent(sessionId: string, subagentId: string): void;
    onNewSession(): void;
    onRenameSession(session: SessionState): void;
    onCloseSession(session: SessionState): void;
    onDispatchSubagent(sessionId: string): void;
    /**
     * Reserved for the subagent child-view `⋯` menu (stream workstream): the
     * tree rows themselves open no subagent menu in v0.1.1.
     */
    onRenameSubagent(subagent: Subagent): void;
    onCloseDrawer?(): void;
    className?: string;
}

/** `name · model · thinking [· status]` — the row shows the name, the title the rest. */
function rowTitle(parts: (string | null | undefined)[]): string {
    return parts.filter((part): part is string => Boolean(part && part.trim())).join(" · ");
}

export function SessionTree({
    sessions,
    workspaces,
    activeWorkspaceId,
    selectedId,
    activeSubagentId,
    filter,
    collapsed,
    activeOnly,
    showHidden,
    creating,
    onFilter,
    onToggleCollapse,
    onToggleAll,
    onToggleActiveOnly,
    onToggleShowHidden,
    onSelectSession,
    onSelectWorkspace,
    onSelectSubagent,
    onNewSession,
    onRenameSession,
    onCloseSession,
    onDispatchSubagent,
    onCloseDrawer,
    className,
}: SessionTreeProps) {
    const { t } = useTranslation();
    const [wsMenuOpen, setWsMenuOpen] = useState(false);
    const [rowMenu, setRowMenu] = useState<{ session: SessionState; anchor: HTMLElement } | null>(null);
    const anchorRef = useRef<HTMLElement | null>(null);
    // pi2.nvim's `(unnamed)` / `sub-session` placeholders, in the active locale.
    const titlePhrases = useMemo(
        () => ({ unnamed: t("chat.sessionUnnamed"), subagentUnnamed: t("chat.subagentUnnamed") }),
        [t],
    );

    const view = useMemo(
        () =>
            buildSessionTreeView(sessions, {
                filter,
                showHidden,
                selectedId,
                activeOnly,
                viewingSubagentId: activeSubagentId,
            }),
        [sessions, filter, showHidden, selectedId, activeOnly, activeSubagentId],
    );

    // "Collapse all" is a toggle: fold everything while any row is open.
    const anyOpen = useMemo(() => {
        const ids = sessions.flatMap((session) => [
            session.sessionId,
            ...flattenSubagents(session.subagents).map(({ subagent }) => subagent.id),
        ]);
        return ids.some((id) => collapsed[id] !== true);
    }, [sessions, collapsed]);

    useEffect(() => {
        anchorRef.current = rowMenu?.anchor ?? null;
    }, [rowMenu]);

    const closeRowMenu = useCallback((restoreFocus: boolean) => {
        const anchor = anchorRef.current;
        anchorRef.current = null;
        setRowMenu(null);
        // Esc/Tab hand focus back to the `…` button (the row never unmounts).
        if (restoreFocus) anchor?.focus({ preventScroll: true });
    }, []);

    function toggleRowMenu(session: SessionState, anchor: HTMLElement): void {
        if (rowMenu?.session.sessionId === session.sessionId) {
            closeRowMenu(true);
            return;
        }
        anchorRef.current = anchor;
        setRowMenu({ session, anchor });
    }

    const isOpen = (node: TreeNode): boolean =>
        node.children.length > 0 && (collapsed[treeNodeId(node)] !== true || node.forcedOpen);

    function foldButton(node: TreeNode, label: string) {
        const open = isOpen(node);
        return (
            <button
                type="button"
                className={cn("tree-toggle", open && "open")}
                aria-expanded={open}
                aria-label={label}
                onClick={(event) => {
                    event.stopPropagation();
                    onToggleCollapse(treeNodeId(node));
                }}
            >
                <Icon name="chevron-right" />
            </button>
        );
    }

    function renderSessionRow(node: SessionTreeNode) {
        const session = node.session;
        const selected = session.sessionId === selectedId;
        const dot =
            node.depth > 0
                ? childSessionDot(session, { viewed: selected })
                : sessionDot(session, { viewed: selected });
        const menuOpen = rowMenu?.session.sessionId === session.sessionId;
        // A row is never labelled with its id (pi2.nvim shows `(unnamed)`).
        const title = sessionTitle(session, titlePhrases);
        const attention = session.attention.length;
        return (
            <div
                className={cn(
                    "tree-row",
                    // A child session is a sub row: same single line, indent-only.
                    node.depth > 0 && "tree-row--sub",
                    node.depth > 0 && `sub-d${Math.min(node.depth, 3)}`,
                    selected && "selected",
                    menuOpen && "is-menu",
                )}
                data-session-id={session.sessionId}
                data-hidden={node.hidden ? "true" : undefined}
            >
                {node.children.length ? (
                    foldButton(node, t(isOpen(node) ? "chat.fold" : "chat.unfold"))
                ) : (
                    <span className="tree-toggle leaf" aria-hidden="true">
                        <Icon name="chevron-right" />
                    </span>
                )}
                <button
                    type="button"
                    className="tree-row__main"
                    title={rowTitle([title.text, session.model?.id, session.thinking])}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelectSession(session.sessionId)}
                >
                    <StatusDot status={dot.status} steady={dot.steady} current={dot.current} />
                    {title.spinner ? <SessionTitleSpinner /> : null}
                    <span
                        className={cn(
                            "t-name truncate",
                            title.kind === "unnamed" && "is-unnamed",
                            title.kind === "generating" && "is-generating",
                        )}
                    >
                        {title.text}
                    </span>
                    {attention > 0 ? <span className="t-attn">{`!${attention}`}</span> : null}
                </button>
                <button
                    type="button"
                    className="icon-btn t-more"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    aria-label={t("common.manage")}
                    title={t("common.manage")}
                    data-menu-id={session.sessionId}
                    onClick={(event) => {
                        event.stopPropagation();
                        toggleRowMenu(session, event.currentTarget);
                    }}
                >
                    <Icon name="more" />
                </button>
            </div>
        );
    }

    function renderSubagentRow(node: SubagentTreeNode) {
        const { session, subagent } = node;
        const viewing = subagent.id === activeSubagentId;
        const dot = subagentDot(subagent, { viewed: viewing });
        // Sub-session rows resolve name → task prompt (40 chars) → `sub-session`;
        // the id stays an identity, never a label.
        const title = subagentTitle(subagent, titlePhrases);
        // Status is carried by the dot only; text goes to title/aria-label.
        const label = rowTitle([title.text, subagent.model, subagent.thinking, t(`state.${subagent.status}`)]);
        return (
            <div
                className={cn(
                    "tree-row tree-row--sub",
                    `sub-d${Math.min(node.depth, 3)}`,
                    viewing && "is-viewing",
                )}
                data-subagent-id={subagent.id}
                data-hidden={node.hidden ? "true" : undefined}
            >
                {node.children.length ? (
                    foldButton(node, t(isOpen(node) ? "chat.fold" : "chat.unfold"))
                ) : (
                    <span className="tree-toggle leaf" aria-hidden="true">
                        <Icon name="chevron-right" />
                    </span>
                )}
                <button
                    type="button"
                    className={cn("tree-row__main", viewing && "is-viewing")}
                    title={label}
                    aria-label={label}
                    aria-current={viewing ? "true" : undefined}
                    data-sub-id={subagent.id}
                    onClick={() => onSelectSubagent(session.sessionId, subagent.id)}
                >
                    <StatusDot status={dot.status} steady={dot.steady} />
                    <span
                        className={cn(
                            "t-name truncate",
                            title.kind === "unnamed" && "is-unnamed",
                            title.kind === "generating" && "is-generating",
                        )}
                    >
                        {title.text}
                    </span>
                    {node.hiddenCount > 0 ? (
                        <span className="t-hidden tabular" title={t("chat.hiddenSubs", { n: node.hiddenCount })}>
                            {`+${node.hiddenCount}`}
                        </span>
                    ) : null}
                </button>
            </div>
        );
    }

    function renderRows(nodes: TreeNode[], level: number) {
        return (
            <ul className={level === 0 ? "tree tree--sessions" : "tree"}>
                {nodes.map((node) => (
                    <li key={treeNodeKey(node)}>
                        {node.kind === "session" ? renderSessionRow(node) : renderSubagentRow(node)}
                        {isOpen(node) ? renderRows(node.children, level + 1) : null}
                    </li>
                ))}
            </ul>
        );
    }

    const hiddenByPolicy = showHidden ? 0 : view.hiddenByPolicy;

    return (
        <div className={cn("tree-inner", className)} aria-label={t("chat.treeAria")}>
            <div className="pane-head">
                <div className="tree-head-row">
                    <WorkspaceSwitch
                        className="tree-head__switch"
                        workspaces={workspaces}
                        activeWorkspaceId={activeWorkspaceId}
                        sessionCount={sessions.length}
                        open={wsMenuOpen}
                        onOpenChange={setWsMenuOpen}
                        onSelect={onSelectWorkspace}
                    />
                    {onCloseDrawer ? (
                        <button
                            type="button"
                            className="icon-btn tree-close"
                            title={t("chat.closeTree")}
                            aria-label={t("chat.closeTree")}
                            onClick={onCloseDrawer}
                        >
                            <Icon name="x" />
                        </button>
                    ) : null}
                </div>
                <div className="tree-toolbar">
                    <input
                        type="search"
                        className="tree-search"
                        value={filter}
                        placeholder={t("chat.searchPlaceholder")}
                        aria-label={t("chat.searchAria")}
                        onChange={(event) => onFilter(event.target.value)}
                    />
                    <button
                        type="button"
                        className="icon-btn"
                        title={t("chat.newSessionShort")}
                        aria-label={t("chat.newSessionShort")}
                        data-testid="tree-new-session"
                        disabled={creating}
                        onClick={onNewSession}
                    >
                        <Icon name="plus" />
                    </button>
                    <button
                        type="button"
                        className="icon-btn"
                        title={t("chat.toggleAllAria")}
                        aria-label={t("chat.toggleAllAria")}
                        onClick={onToggleAll}
                    >
                        <Icon name={anyOpen ? "chevron-down" : "chevron-right"} />
                    </button>
                </div>
            </div>
            <div className="pane-scroll">
                {view.roots.length ? (
                    <>
                        {renderRows(view.roots, 0)}
                        {view.hiddenSessions > 0 ? (
                            <button
                                type="button"
                                className="tree-hidden"
                                title={t("chat.showAllSessions")}
                                data-testid="tree-hidden-sessions"
                                onClick={onToggleActiveOnly}
                            >
                                <Icon name="eye" />
                                <span className="truncate">{t("chat.hiddenSubs", { n: view.hiddenSessions })}</span>
                            </button>
                        ) : null}
                        {hiddenByPolicy > 0 ? (
                            <button
                                type="button"
                                className="tree-hidden"
                                title={t("chat.showHidden")}
                                data-testid="tree-hidden-policy"
                                onClick={onToggleShowHidden}
                            >
                                <Icon name="eye" />
                                <span className="truncate">{t("chat.hiddenSubs", { n: hiddenByPolicy })}</span>
                            </button>
                        ) : null}
                    </>
                ) : sessions.length === 0 ? (
                    <Empty
                        icon={<Icon name="chat" />}
                        title={t("chat.noSessionInWorkspace")}
                        description={t("chat.noSessionInWorkspaceText")}
                        action={
                            <button type="button" className="btn btn--sm" onClick={onNewSession} disabled={creating}>
                                <Icon name="plus" />
                                {t("chat.newSessionShort")}
                            </button>
                        }
                    />
                ) : filter.trim() ? (
                    <Empty icon={<Icon name="search" />} title={t("chat.noMatch")} description={t("chat.tryOther")} />
                ) : (
                    <Empty
                        icon={<Icon name="check" />}
                        title={t("chat.noActiveTitle")}
                        description={t("chat.noActiveText")}
                        action={
                            view.hiddenByPolicy > 0 && !showHidden ? (
                                <button type="button" className="btn btn--sm" onClick={onToggleShowHidden}>
                                    <Icon name="eye" />
                                    {t("chat.showHidden")}
                                </button>
                            ) : (
                                <button type="button" className="btn btn--sm" onClick={onToggleActiveOnly}>
                                    <Icon name="eye" />
                                    {t("chat.showAllSessions")}
                                </button>
                            )
                        }
                    />
                )}
            </div>
            {rowMenu ? (
                <SessionRowMenu
                    session={rowMenu.session}
                    anchor={rowMenu.anchor}
                    activeOnly={activeOnly}
                    onClose={closeRowMenu}
                    onToggleActiveOnly={onToggleActiveOnly}
                    onDispatchSubagent={onDispatchSubagent}
                    onRenameSession={onRenameSession}
                    onCloseSession={onCloseSession}
                />
            ) : null}
        </div>
    );
}
