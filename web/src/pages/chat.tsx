import type {
    AttentionItem,
    ModelRef,
    SessionState,
    Subagent,
    TaskItem,
    ThinkingLevel,
} from "@protocol/types";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/ui/empty";
import { StatusDot } from "@/components/ui/status-dot";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { ApiError, errorI18nKey } from "@/lib/api";
import { useConnectionStore } from "@/stores/connection";
import { useSessionsStore } from "@/stores/sessions";
import { AttentionDialog } from "@/features/chat/attention";
import { Composer } from "@/features/chat/composer";
import { chatCommands, runCommand, type AttentionResponse, type ChatCommand, type PromptImage, type PromptMode } from "@/features/chat/commands";
import {
    useChatModels,
    useChatSessions,
    useChatSocket,
    useChatWorkspaces,
    useSessionLookup,
} from "@/features/chat/data";
import { truncate } from "@/features/chat/format";
import { HeadChips } from "@/features/chat/head-chips";
import { useSessionHistory } from "@/features/chat/history";
import { ChatLayout } from "@/features/chat/layout";
import { MessageStream } from "@/features/chat/message-stream";
import { onSessionMigration, replaceChatUrl } from "@/features/chat/migration";
import { DispatchModal, RenameDialog, TaskOutputModal, type DispatchInput } from "@/features/chat/modals";
import { SessionTray } from "@/features/chat/session-tray";
import { sessionTitle } from "@/features/chat/session-title";
import {
    findSubagent,
    flattenSubagents,
    emptySessionState,
    sessionDot,
    sessionStatusKey,
} from "@/features/chat/session-state";
import { SessionTree } from "@/features/chat/session-tree";
import { SubagentView } from "@/features/chat/subagent-view";
import { useChatStore, type TrayTab } from "@/features/chat/store";
import { Telemetry } from "@/features/chat/telemetry";
import { markWorkspaceUsed } from "@/features/chat/workspace-order";

import "@/styles/pages/chat.css";

const NO_ENTRIES: [] = [];

function escapeAttr(value: string): string {
    return value.replace(/["\\]/g, "\\$&");
}

type RenameTarget =
    | { kind: "session"; session: SessionState }
    | { kind: "subagent"; subagent: Subagent };

function errorText(error: unknown, translate: (key: string) => string): string {
    if (error instanceof ApiError) return translate(errorI18nKey(error.code));
    return error instanceof Error ? error.message : String(error);
}

function renameInTree(list: Subagent[] | undefined, id: string, name: string): Subagent[] | undefined {
    if (!list) return list;
    return list.map((subagent) => ({
        ...subagent,
        ...(subagent.id === id ? { name } : {}),
        ...(subagent.children ? { children: renameInTree(subagent.children, id, name) } : {}),
    }));
}

export function ChatPage() {
    const params = useParams({ strict: false }) as { sessionId?: string };
    return <ChatExperience sessionId={params.sessionId} />;
}

export function ChatIndexPage() {
    return <ChatExperience />;
}

function ChatExperience({ sessionId }: { sessionId?: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const paired = useConnectionStore((state) => state.paired);
    const wsState = useConnectionStore((state) => state.wsState);
    const connected = paired && wsState === "open";
    const { workspaces } = useChatWorkspaces(paired);

    const routeSearch = useRouterState({ select: (state) => state.location.search }) as Record<string, unknown>;
    const workspaceParam = typeof routeSearch.workspace === "string" ? routeSearch.workspace : undefined;
    const knownSession = useSessionsStore((state) => (sessionId ? state.getSession(sessionId) : undefined));
    const workspaceId =
        workspaceParam ??
        knownSession?.workspaceId ??
        workspaces.find((workspace) => workspace.instance)?.workspaceId ??
        workspaces[0]?.workspaceId;

    const sessionsQuery = useChatSessions(workspaceId, paired);
    // "Recently used" for the workspace picker: whichever workspace is active
    // (deep link, picker pick, default choice) gets a browser-local stamp.
    useEffect(() => {
        if (workspaceId) markWorkspaceUsed(workspaceId);
    }, [workspaceId]);
    const sessions = sessionsQuery.sessions;
    const sessionIds = useMemo(() => sessions.map((session) => session.sessionId), [sessions]);
    useChatSocket(workspaceId, sessionIds, paired);
    // An unknown deep link resolves to nothing (never to another session);
    // `missing` stays false until the list has loaded, so no error flash.
    const { session: active, missing: sessionMissing } = useSessionLookup(
        sessionId,
        sessions,
        sessionsQuery.loaded,
    );
    // `:PiSessions` TabEnter: the routed session is in view, so its unread
    // notifications are consumed — the plugin clears `done`/`error` when the user
    // enters the tab and only raises `done` for a session that is not current.
    const viewedSessionId = active?.sessionId;
    const viewedDone = active?.flags.done;
    const viewedError = active?.flags.error;
    useEffect(() => {
        if (!viewedSessionId || (!viewedDone && !viewedError)) return;
        useSessionsStore.getState().markSeen(viewedSessionId);
    }, [viewedSessionId, viewedDone, viewedError]);
    // The stream head shows the same session the selected tree row does, so it
    // renders that row's `DotView` (`viewed: true`) rather than re-deriving a
    // colour: one session must never show two different blink rates.
    const headDot = active ? sessionDot(active, { viewed: true }) : null;
    const history = useSessionHistory(
        active?.sessionId,
        active?.entries ?? NO_ENTRIES,
        paired,
        active?.workspaceId ?? workspaceId,
    );
    const models = useChatModels(workspaceId, paired);
    const workspace = workspaces.find((item) => item.workspaceId === workspaceId);
    // pi2.nvim's placeholder vocabulary, and the display title of the routed
    // session: name → first message → `(unnamed)`. Never the session id.
    const titlePhrases = useMemo(
        () => ({ unnamed: t("chat.sessionUnnamed"), subagentUnnamed: t("chat.subagentUnnamed") }),
        [t],
    );
    // Patch the window title from the routed session's display title: name →
    // first message → nothing (an unnamed session keeps the page title).
    const activeTitle = useMemo(
        () => (active ? sessionTitle(active, titlePhrases) : null),
        [active, titlePhrases],
    );

    const filter = useChatStore((state) => state.filter);
    const setFilter = useChatStore((state) => state.setFilter);
    const collapsed = useChatStore((state) => state.collapsed);
    const toggleCollapsed = useChatStore((state) => state.toggleCollapsed);
    const showHidden = useChatStore((state) => state.showHidden);
    const toggleShowHidden = useChatStore((state) => state.toggleShowHidden);
    const setAllCollapsed = useChatStore((state) => state.setAllCollapsed);
    const treeOpen = useChatStore((state) => state.treeOpen);
    const setTreeOpen = useChatStore((state) => state.setTreeOpen);
    const closeDrawers = useChatStore((state) => state.closeDrawers);
    const trayTab = useChatStore((state) => state.trayTab);
    const trayOpen = useChatStore((state) => state.trayOpen);
    const toggleTray = useChatStore((state) => state.toggleTray);
    const setTrayOpen = useChatStore((state) => state.setTrayOpen);
    const setTrayTab = useChatStore((state) => state.setTrayTab);
    const activeOnly = useChatStore((state) => state.activeOnly);
    const toggleActiveOnly = useChatStore((state) => state.toggleActiveOnly);
    const activeSubagentId = useChatStore((state) => state.activeSubagentId);
    const setActiveSubagentId = useChatStore((state) => state.setActiveSubagentId);
    const rowMenuId = useChatStore((state) => state.rowMenuId);
    const setRowMenuId = useChatStore((state) => state.setRowMenuId);
    const wsMenuOpen = useChatStore((state) => state.wsMenuOpen);
    const setWsMenuOpen = useChatStore((state) => state.setWsMenuOpen);
    const sending = useChatStore((state) => state.sending);
    const setSending = useChatStore((state) => state.setSending);

    const [creating, setCreating] = useState(false);
    const [dispatchOpen, setDispatchOpen] = useState(false);
    const [renaming, setRenaming] = useState<RenameTarget | null>(null);
    const [closing, setClosing] = useState<SessionState | null>(null);
    const [stoppingTask, setStoppingTask] = useState<TaskItem | null>(null);
    const [taskOutput, setTaskOutput] = useState<TaskItem | null>(null);
    /** Chip elements, so closing the tray can hand focus back to its trigger. */
    const chipRefs = useRef<Partial<Record<TrayTab, HTMLButtonElement | null>>>({});
    const streamNameRef = useRef<HTMLHeadingElement | null>(null);

    // `?sub=<id>` is the child view: the in-place subagent page, no modal and no
    // separate route (the parent session row stays selected in the tree).
    const subParam = typeof routeSearch.sub === "string" ? routeSearch.sub : undefined;
    const activeSub = useMemo(
        () =>
            activeSubagentId
                ? (findSubagent(active?.subagents, (item) => item.id === activeSubagentId) ?? null)
                : null,
        [active, activeSubagentId],
    );

    const emptySession = useMemo(
        () => emptySessionState({ sessionId: "", workspaceId: workspaceId ?? "" }),
        [workspaceId],
    );

    // URL → store: `?sub=` is the only writer of the child-view state (deep link,
    // back/forward). Selecting a session row drops it by navigating without it.
    useEffect(() => {
        const next = subParam ?? null;
        if ((activeSubagentId ?? null) !== next) setActiveSubagentId(next);
    }, [activeSubagentId, setActiveSubagentId, subParam]);

    // A stale `?sub=` (subagent missing from this session) is dropped instead of
    // rendering a dead child view.
    useEffect(() => {
        if (!activeSubagentId || activeSub || !active || !sessionsQuery.loaded) return;
        setActiveSubagentId(null);
        void navigate({
            to: "/chat/$sessionId",
            params: { sessionId: active.sessionId },
            search: workspaceId ? { workspace: workspaceId } : {},
            replace: true,
        });
    }, [active, activeSub, activeSubagentId, navigate, sessionsQuery.loaded, setActiveSubagentId, workspaceId]);

    // Single-layer Esc chain (modals win, the tray closes itself):
    // ws menu → row menu → child view → tree drawer.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (document.querySelector(".modal-backdrop")) return;
            if (trayOpen) return;
            if (wsMenuOpen) {
                setWsMenuOpen(false);
                return;
            }
            if (rowMenuId) {
                setRowMenuId(null);
                return;
            }
            if (activeSubagentId) {
                event.preventDefault();
                closeSubagentView(true);
                return;
            }
            if (treeOpen) closeDrawers();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [activeSubagentId, closeDrawers, rowMenuId, setRowMenuId, setWsMenuOpen, treeOpen, trayOpen]);

    useEffect(() => {
        // A placeholder title is not a title for the window chrome.
        const fallback = sessionMissing ? t("errors.sessionNotFound") : t("nav.chat");
        const title = activeTitle && !activeTitle.provisional ? activeTitle.text : fallback;
        document.title = `${title} — pi2.nvim`;
    }, [activeTitle, sessionMissing, t]);

    // The optimistic "sending" chip disappears when the authoritative user
    // entry arrives (via entry_appended) or after a safety timeout.
    useEffect(() => {
        if (!sending) return;
        if (!active || active.sessionId !== sending.sessionId) {
            setSending(null);
            return;
        }
        const text = sending.text.trim();
        const arrived = active.entries.some(
            (entry) =>
                entry.role === "user" &&
                entry.blocks.some((block) => block.type === "text" && block.text.trim() === text),
        );
        if (arrived) setSending(null);
    }, [active, sending, setSending]);

    useEffect(() => {
        if (!sending) return;
        const timer = setTimeout(() => setSending(null), 20_000);
        return () => clearTimeout(timer);
    }, [sending, setSending]);

    // A `tmp-N` → real-id migration re-keys the stores and the socket; the router
    // still addresses the old id, so swap the URL in place and refresh the tree.
    useEffect(
        () =>
            onSessionMigration((migration) => {
                if (replaceChatUrl(migration.from, migration.to, workspaceId)) {
                    void navigate({
                        to: "/chat/$sessionId",
                        params: { sessionId: migration.to },
                        search: workspaceId ? { workspace: workspaceId } : {},
                        replace: true,
                    });
                }
                void queryClient.invalidateQueries({ queryKey: ["chat-sessions", migration.workspaceId] });
            }),
        [navigate, queryClient, workspaceId],
    );

    async function exec(
        command: ChatCommand,
        successKey?: string,
        params?: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> {
        try {
            const result = await runCommand(command);
            if (successKey) toast.success(t(successKey, params));
            return result;
        } catch (error) {
            toast.error(t("chat.commandFailed", { error: errorText(error, t) }));
            return undefined;
        }
    }

    function navigateSession(id: string) {
        closeDrawers();
        void navigate({
            to: "/chat/$sessionId",
            params: { sessionId: id },
            search: workspaceId ? { workspace: workspaceId } : {},
        });
    }

    function navigateWorkspace(id: string) {
        closeDrawers();
        setTrayOpen(false);
        void navigate({ to: "/chat", search: { workspace: id } });
    }

    /** Close the tray and hand focus back to the chip that opened it. */
    function closeTray() {
        const tab = trayTab;
        const hadFocus = document.getElementById("chat-tray")?.contains(document.activeElement) ?? false;
        setTrayOpen(false);
        if (!hadFocus) return;
        requestAnimationFrame(() => chipRefs.current[tab]?.focus({ preventScroll: true }));
    }

    /** Tree row / sub-report click → in-place child view (`?sub=`). */
    function openSubagentView(sessionId: string, subagentId: string) {
        setTrayOpen(false);
        setRowMenuId(null);
        setActiveSubagentId(subagentId);
        void navigate({
            to: "/chat/$sessionId",
            params: { sessionId },
            search: { ...(workspaceId ? { workspace: workspaceId } : {}), sub: subagentId },
        });
        requestAnimationFrame(() => {
            document.querySelector<HTMLElement>(".sub-back")?.focus({ preventScroll: true });
        });
    }

    /** `← 父级` / Esc: back to the session stream and refocus the tree row. */
    function closeSubagentView(restoreFocus = true) {
        const subagentId = activeSubagentId;
        const sessionId = active?.sessionId;
        setActiveSubagentId(null);
        setTrayOpen(false);
        if (sessionId) {
            void navigate({
                to: "/chat/$sessionId",
                params: { sessionId },
                search: workspaceId ? { workspace: workspaceId } : {},
                replace: true,
            });
        }
        if (!restoreFocus) return;
        // Two frames: the tree has to re-render (row no longer `aria-current`)
        // before the row regains focus.
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                const row = subagentId
                    ? document.querySelector<HTMLElement>(`[data-sub-id="${escapeAttr(subagentId)}"]`)
                    : null;
                if (row?.focus) {
                    row.focus({ preventScroll: true });
                    return;
                }
                streamNameRef.current?.focus({ preventScroll: true });
            }),
        );
    }

    async function handleSend(text: string, images: PromptImage[], mode?: PromptMode) {
        if (!active) return;
        setSending({ sessionId: active.sessionId, text });
        try {
            await runCommand(chatCommands.sendPrompt(active.sessionId, text, images, mode));
        } catch (error) {
            setSending(null);
            toast.error(t("chat.sendFailed", { error: errorText(error, t) }));
        }
    }

    /**
     * Steering is a session-wide mode (`queue.setSteer {mode}`), so the toast
     * names the mode instead of implying a per-message flag.
     */
    async function setSteerMode(steer: boolean) {
        const sessionId = active?.sessionId;
        if (!sessionId) return;
        const mode = steer ? "all" : "one-at-a-time";
        try {
            await runCommand(chatCommands.setQueueSteer(sessionId, steer));
            toast.success(`${t("chat.steer")}: ${mode}`);
        } catch (error) {
            toast.error(t("chat.commandFailed", { error: errorText(error, t) }));
        }
    }

    /**
     * Child view: steer targets the subagent by display name (the same identity
     * the tree row and the sub-report use), never the session.
     */
    async function steerSubagent(text: string) {
        if (!active || !activeSub) return;
        const target = activeSub.name?.trim() || activeSub.id;
        try {
            await runCommand(chatCommands.steerSubagent(active.sessionId, target, text));
            toast.success(t("chat.steerSent", { text: truncate(text, 60) }));
        } catch (error) {
            toast.error(t("chat.commandFailed", { error: errorText(error, t) }));
        }
    }

    async function handleNewSession() {
        if (!workspaceId || creating) return;
        setCreating(true);
        try {
            const result = await runCommand(chatCommands.createSession(workspaceId));
            await queryClient.invalidateQueries({ queryKey: ["chat-sessions", workspaceId] });
            const created =
                typeof result.sessionId === "string"
                    ? result.sessionId
                    : typeof (result.session as Record<string, unknown> | undefined)?.sessionId === "string"
                      ? String((result.session as Record<string, unknown>).sessionId)
                      : undefined;
            toast.success(t("chat.newSessionCreated"));
            if (created) navigateSession(created);
        } catch (error) {
            toast.error(t("chat.newSessionFailed", { error: errorText(error, t) }));
        } finally {
            setCreating(false);
        }
    }

    async function dispatchSubagent(input: DispatchInput) {
        if (!active) return;
        const result = await exec(chatCommands.dispatchSubagent(active.sessionId, input));
        if (result !== undefined) toast.success(t("chat.dispatched", { name: input.name ?? "-" }));
    }

    async function saveRename(value: string) {
        if (!renaming) return;
        if (renaming.kind === "session") {
            const target = renaming.session;
            const previous = useSessionsStore.getState().getSession(target.sessionId)?.name ?? target.name;
            try {
                // The plugin owns the name: apply it only after the ack.
                await runCommand(chatCommands.renameSession(target.sessionId, value));
                useSessionsStore.getState().upsertSession({ ...target, name: value });
                toast.success(t("chat.renamed", { name: value }));
            } catch (error) {
                // Roll back so the tree never keeps an unconfirmed name.
                useSessionsStore.getState().upsertSession({ ...target, name: previous });
                toast.error(t("chat.commandFailed", { error: errorText(error, t) }));
                throw error;
            }
            return;
        }
        if (!active) return;
        // Subagent names are local display only (the plugin has no rename command).
        useSessionsStore.getState().upsertSession({
            ...active,
            subagents: renameInTree(active.subagents, renaming.subagent.id, value) ?? [],
        });
        toast.success(t("chat.renamed", { name: value }));
    }

    async function closeSession(session: SessionState) {
        await exec(chatCommands.closeSession(session.sessionId), "chat.closedProcess", {
            name: sessionTitle(session, titlePhrases).text,
        });
        setClosing(null);
    }

    async function stopTask(task: TaskItem) {
        await exec(chatCommands.stopTask(active?.sessionId ?? "", task.id), "chat.taskStopped", { id: task.id });
        setStoppingTask(null);
    }

    async function respondAttention(item: AttentionItem, response: AttentionResponse | string) {
        if (!active) return;
        await exec(chatCommands.respondAttention(active.sessionId, item.requestId, response));
    }

    const allIds = useMemo(
        () =>
            sessions.flatMap((session) => [
                session.sessionId,
                ...flattenSubagents(session.subagents).map(({ subagent }) => subagent.id),
            ]),
        [sessions],
    );
    const anyOpen = allIds.some((id) => !collapsed[id]);
    // Only offer the way back when the parent is actually in this workspace list;
    // a pruned/archived parent would otherwise dead-end on the not-found page.
    const parentSessionId =
        active?.parentId && sessions.some((session) => session.sessionId === active.parentId)
            ? active.parentId
            : null;

    const planDone = active?.todos.filter((item) => item.status === "completed").length ?? 0;
    const planTotal = active?.todos.length ?? 0;
    const taskCount = active?.tasks.length ?? 0;
    const runningTasks = active?.tasks.filter((item) => item.status === "running").length ?? 0;

    // The session stream head. The child view owns its own `.stream-head--sub`
    // (`subagent-view.tsx`), so this one never renders while `?sub=` is set.
    const streamHead = (
        <div
            className="stream-head"
            // Identity + the two chips only. Workspace / model / thinking move to
            // the tooltip; context usage lives in the telemetry line, never here.
            title={
                [workspace?.cwd, active?.model?.id, active?.thinking].filter(Boolean).join(" · ") || undefined
            }
        >
            <button
                type="button"
                className="btn btn--sm btn--ghost stream-head__tree"
                aria-label={t("chat.expandTree")}
                title={t("chat.expandTree")}
                onClick={() => setTreeOpen(true)}
            >
                <Icon name="branch" />
            </button>
            {parentSessionId ? (
                // A sub-session row is reachable from the tree and by deep link;
                // this is the way back up without opening the tree.
                <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => navigateSession(parentSessionId)}
                >
                    {t("chat.backToParent")}
                </button>
            ) : null}
            <div className="stream-title">
                {active && headDot ? (
                    <StatusDot
                        status={headDot.status}
                        blink={headDot.blink}
                        current={headDot.current}
                        title={t(`state.${sessionStatusKey(active)}`)}
                    />
                ) : null}
                <h2 className="stream-name truncate" tabIndex={-1} ref={streamNameRef}>
                    {active ? activeTitle?.text : (workspace?.name ?? t("nav.chat"))}
                </h2>
                {active?.flags.attention && active.attention.length ? (
                    <Badge tone="warn">{t("chat.pending", { n: active.attention.length })}</Badge>
                ) : null}
                {active ? (
                    <Badge className="stream-status">{t(`state.${sessionStatusKey(active)}`)}</Badge>
                ) : null}
            </div>
            <div className="spacer" />
            {active ? (
                <HeadChips
                    planDone={planDone}
                    planTotal={planTotal}
                    taskCount={taskCount}
                    runningTasks={runningTasks}
                    trayTab={trayTab}
                    trayOpen={trayOpen}
                    onToggle={toggleTray}
                    registerTrigger={(tab, element) => {
                        chipRefs.current[tab] = element;
                    }}
                />
            ) : null}
        </div>
    );

    return (
        <>
            <ChatLayout
                treeOpen={treeOpen}
                onCloseDrawers={closeDrawers}
                tree={
                    <SessionTree
                        sessions={sessions}
                        workspaces={workspaces}
                        activeWorkspaceId={workspaceId ?? null}
                        selectedId={active?.sessionId ?? null}
                        activeSubagentId={activeSubagentId}
                        filter={filter}
                        collapsed={collapsed}
                        activeOnly={activeOnly}
                        showHidden={showHidden}
                        connected={connected}
                        creating={creating}
                        onFilter={setFilter}
                        onToggleCollapse={toggleCollapsed}
                        onToggleAll={() => setAllCollapsed(allIds, anyOpen)}
                        onToggleActiveOnly={toggleActiveOnly}
                        onToggleShowHidden={toggleShowHidden}
                        onSelectSession={navigateSession}
                        onSelectWorkspace={navigateWorkspace}
                        onSelectSubagent={openSubagentView}
                        onNewSession={() => void handleNewSession()}
                        onRenameSession={(session) => setRenaming({ kind: "session", session })}
                        onCloseSession={setClosing}
                        onDispatchSubagent={(id) => {
                            if (id === active?.sessionId) setDispatchOpen(true);
                        }}
                        onRenameSubagent={(subagent) => setRenaming({ kind: "subagent", subagent })}
                        onCloseDrawer={() => setTreeOpen(false)}
                    />
                }
                stream={
                    <>
                        {activeSub ? null : streamHead}
                        {sessionMissing ? (
                            <div className="stream-body stream-blank">
                                <div className="stream-status stream-status--err" data-testid="session-not-found">
                                    <Empty
                                        icon={<Icon name="alert" size={28} />}
                                        title={t("errors.sessionNotFound")}
                                        description={`${t("errors.notFound")}: ${sessionId ?? ""}`}
                                        action={
                                            <div className="row">
                                                <button
                                                    type="button"
                                                    className="btn btn--sm btn--primary"
                                                    data-testid="session-not-found-retry"
                                                    onClick={sessionsQuery.refetch}
                                                    disabled={sessionsQuery.fetching}
                                                >
                                                    <Icon name="refresh" />
                                                    {t("common.retry")}
                                                </button>
                                                <Link to="/workspaces" className="btn btn--sm">
                                                    <Icon name="folder" />
                                                    {t("connect.backToWorkspaces")}
                                                </Link>
                                            </div>
                                        }
                                    />
                                </div>
                            </div>
                        ) : active && activeSub ? (
                            <SubagentView
                                session={active}
                                subagent={activeSub}
                                entries={history.entries}
                                onBack={() => closeSubagentView(true)}
                                onOpenTray={() => setTrayOpen(true)}
                                onOpenTree={() => setTreeOpen(true)}
                                onSteer={(text) => void steerSubagent(text)}
                                chips={{
                                    planDone,
                                    planTotal,
                                    taskCount,
                                    runningTasks,
                                    trayTab,
                                    trayOpen,
                                    onToggle: toggleTray,
                                    registerTrigger: (tab: TrayTab, element: HTMLButtonElement | null) => {
                                        chipRefs.current[tab] = element;
                                    },
                                }}
                                composer={{ models, connected, paired }}
                            />
                        ) : active ? (
                            <MessageStream
                                session={active}
                                entries={history.entries}
                                hasMore={history.hasMore}
                                loadingOlder={history.loadingOlder}
                                error={history.error}
                                onLoadOlder={history.loadOlder}
                                onRetry={history.retry}
                                onOpenSubagent={(subagent) => openSubagentView(active.sessionId, subagent.id)}
                            />
                        ) : (
                            <div className="stream-body stream-blank">
                                {sessions.length === 0 && !connected ? (
                                    <div className="row muted">
                                        <Spinner /> {t("chat.loading")}
                                    </div>
                                ) : (
                                    <Empty
                                        icon={<Icon name="chat" />}
                                        title={t("chat.noSessions")}
                                        description={t("chat.noSessionsText")}
                                        action={
                                            <button
                                                type="button"
                                                className="btn btn--sm btn--primary"
                                                onClick={() => void handleNewSession()}
                                                disabled={creating || !workspaceId}
                                            >
                                                <Icon name="plus" />
                                                {t("chat.newSession")}
                                            </button>
                                        }
                                    />
                                )}
                            </div>
                        )}
                        {sessionMissing || activeSub ? null : (
                            <Composer
                                session={active ?? null}
                                models={models}
                                connected={connected}
                                paired={paired}
                                sending={sending}
                                onSend={(text, images, mode) => void handleSend(text, images, mode)}
                                onAbort={() => {
                                    setSending(null);
                                    void exec(chatCommands.abort(active?.sessionId ?? ""));
                                }}
                                onRemoveQueue={(id) =>
                                    void exec(chatCommands.removeQueued(active?.sessionId ?? "", id), "chat.queueRemoved")
                                }
                                onSetSteer={(steer) => void setSteerMode(steer)}
                                onSetModel={(model: ModelRef) =>
                                    void exec(
                                        chatCommands.setModel(active?.sessionId ?? "", model),
                                        "chat.modelSwitched",
                                        { model: model.id },
                                    )
                                }
                                onSetThinking={(level: ThinkingLevel) =>
                                    void exec(
                                        chatCommands.setThinking(active?.sessionId ?? "", level),
                                        "chat.thinkingSet",
                                        { level },
                                    )
                                }
                            />
                        )}
                        {sessionMissing ? null : (
                            <Telemetry session={active ?? null} subagent={activeSub} entries={history.entries} />
                        )}
                        <SessionTray
                            open={trayOpen && Boolean(active)}
                            tab={trayTab}
                            session={active ?? null}
                            subagent={activeSub}
                            onTab={setTrayTab}
                            onClose={closeTray}
                            onOpenTask={setTaskOutput}
                            onStopTask={setStoppingTask}
                        />
                    </>
                }
            />

            {active ? (
                <AttentionDialog
                    session={active}
                    onRespond={(item, response) => void respondAttention(item, response)}
                    onRemoteResolved={() => toast.info(t("chat.attentionResolvedOther"))}
                />
            ) : null}

            <DispatchModal
                open={dispatchOpen && Boolean(active)}
                session={active ?? emptySession}
                models={models}
                onClose={() => setDispatchOpen(false)}
                onDispatch={(input) => dispatchSubagent(input)}
            />

            <TaskOutputModal
                open={Boolean(taskOutput)}
                session={active ?? emptySession}
                task={taskOutput}
                onClose={() => setTaskOutput(null)}
                onStop={(task) => {
                    setTaskOutput(null);
                    setStoppingTask(task);
                }}
            />

            <RenameDialog
                open={Boolean(renaming)}
                title={renaming?.kind === "session" ? t("chat.renameSession") : t("chat.renameSubagentAria")}
                initial={
                    renaming?.kind === "session"
                        ? (renaming.session.name ?? "")
                        : (renaming?.subagent.name ?? "")
                }
                hint={
                    renaming?.kind === "session" ? t("chat.renameSessionHint") : t("chat.renameSubagentHint")
                }
                onClose={() => setRenaming(null)}
                onSave={saveRename}
            />

            <ConfirmDialog
                open={Boolean(closing)}
                onOpenChange={(open) => {
                    if (!open) setClosing(null);
                }}
                title={t("chat.closeProcess")}
                description={
                    closing ? t("chat.closeSessionText", { name: sessionTitle(closing, titlePhrases).text }) : undefined
                }
                confirmLabel={t("chat.closeProcess")}
                danger
                onConfirm={() => (closing ? closeSession(closing) : undefined)}
            />

            <ConfirmDialog
                open={Boolean(stoppingTask)}
                onOpenChange={(open) => {
                    if (!open) setStoppingTask(null);
                }}
                title={t("chat.stopTask")}
                description={
                    stoppingTask ? t("chat.stopTaskText", { command: stoppingTask.command }) : undefined
                }
                confirmLabel={t("common.stop")}
                danger
                onConfirm={() => (stoppingTask ? stopTask(stoppingTask) : undefined)}
            />
        </>
    );
}
