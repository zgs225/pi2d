import type {
    AttentionItem,
    ModelRef,
    SessionState,
    Subagent,
    TaskItem,
    ThinkingLevel,
} from "@protocol/types";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/ui/empty";
import { StatusDot } from "@/components/ui/status-dot";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { ApiError, errorI18nKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";
import { useSessionsStore } from "@/stores/sessions";
import { AttentionDialog } from "@/features/chat/attention";
import { Composer } from "@/features/chat/composer";
import { chatCommands, runCommand, type ChatCommand, type PromptImage } from "@/features/chat/commands";
import {
    useActiveSession,
    useChatModels,
    useChatSessions,
    useChatSocket,
    useChatWorkspaces,
} from "@/features/chat/data";
import { useSessionHistory } from "@/features/chat/history";
import { ChatLayout } from "@/features/chat/layout";
import { MessageStream } from "@/features/chat/message-stream";
import { DispatchModal, RenameDialog, SubagentModal, TaskOutputModal, type DispatchInput } from "@/features/chat/modals";
import { flattenSubagents, emptySessionState, sessionDot, sessionStatusKey } from "@/features/chat/session-state";
import { SessionTree } from "@/features/chat/session-tree";
import { SidePanel } from "@/features/chat/side-panel";
import { useChatStore } from "@/features/chat/store";
import type { PanelTab } from "@/features/chat/store";

import "@/styles/pages/chat.css";

const NO_ENTRIES: [] = [];

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

    const sessions = useChatSessions(workspaceId, paired);
    const sessionIds = useMemo(() => sessions.map((session) => session.sessionId), [sessions]);
    useChatSocket(workspaceId, sessionIds, paired);
    const active = useActiveSession(sessionId, sessions);
    const history = useSessionHistory(active?.sessionId, active?.entries ?? NO_ENTRIES, paired);
    const models = useChatModels(workspaceId, paired);
    const workspace = workspaces.find((item) => item.workspaceId === workspaceId);

    const filter = useChatStore((state) => state.filter);
    const setFilter = useChatStore((state) => state.setFilter);
    const collapsed = useChatStore((state) => state.collapsed);
    const toggleCollapsed = useChatStore((state) => state.toggleCollapsed);
    const setAllCollapsed = useChatStore((state) => state.setAllCollapsed);
    const tab = useChatStore((state) => state.tab);
    const setTab = useChatStore((state) => state.setTab);
    const treeOpen = useChatStore((state) => state.treeOpen);
    const panelOpen = useChatStore((state) => state.panelOpen);
    const treeCollapsed = useChatStore((state) => state.treeCollapsed);
    const treeWidth = useChatStore((state) => state.treeWidth);
    const panelWidth = useChatStore((state) => state.panelWidth);
    const setTreeOpen = useChatStore((state) => state.setTreeOpen);
    const setPanelOpen = useChatStore((state) => state.setPanelOpen);
    const setTreeCollapsed = useChatStore((state) => state.setTreeCollapsed);
    const setWidths = useChatStore((state) => state.setWidths);
    const closeDrawers = useChatStore((state) => state.closeDrawers);
    const sending = useChatStore((state) => state.sending);
    const setSending = useChatStore((state) => state.setSending);

    const [creating, setCreating] = useState(false);
    const [dispatchOpen, setDispatchOpen] = useState(false);
    const [preview, setPreview] = useState<{ session: SessionState; subagent: Subagent } | null>(null);
    const [renaming, setRenaming] = useState<RenameTarget | null>(null);
    const [closing, setClosing] = useState<SessionState | null>(null);
    const [stoppingTask, setStoppingTask] = useState<TaskItem | null>(null);
    const [taskOutput, setTaskOutput] = useState<TaskItem | null>(null);

    const emptySession = useMemo(
        () => emptySessionState({ sessionId: "", workspaceId: workspaceId ?? "" }),
        [workspaceId],
    );

    useEffect(() => {
        const title = active?.name?.trim() || t("nav.chat");
        document.title = `${title} — pi2.nvim`;
    }, [active?.name, t]);

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

    async function exec(
        command: ChatCommand,
        successKey?: string,
        params?: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> {
        try {
            const result = await runCommand(command);
            if (successKey) toast(t(successKey, params));
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
        void navigate({ to: "/chat", search: { workspace: id } });
    }

    async function handleSend(text: string, images: PromptImage[]) {
        if (!active) return;
        setSending({ sessionId: active.sessionId, text });
        try {
            await runCommand(chatCommands.sendPrompt(active.sessionId, text, images));
        } catch (error) {
            setSending(null);
            toast.error(t("chat.sendFailed", { error: errorText(error, t) }));
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
            toast(t("chat.newSessionCreated"));
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
        if (result !== undefined) toast(t("chat.dispatched", { name: input.name ?? "-" }));
    }

    async function saveRename(value: string) {
        if (!renaming) return;
        if (renaming.kind === "session") {
            try {
                await runCommand(chatCommands.renameSession(renaming.session.sessionId, value));
                useSessionsStore.getState().upsertSession({ ...renaming.session, name: value });
                toast(t("chat.renamed", { name: value }));
            } catch (error) {
                toast.error(t("chat.commandFailed", { error: errorText(error, t) }));
                throw error;
            }
            return;
        }
        if (!active) return;
        useSessionsStore.getState().upsertSession({
            ...active,
            subagents: renameInTree(active.subagents, renaming.subagent.id, value) ?? [],
        });
        toast(t("chat.renamed", { name: value }));
    }

    async function closeSession(session: SessionState) {
        const result = await exec(chatCommands.closeSession(session.sessionId));
        if (result !== undefined) toast.error(t("chat.closedProcess", { name: session.name ?? session.sessionId }));
        setClosing(null);
    }

    async function stopTask(task: TaskItem) {
        const result = await exec(chatCommands.stopTask(active?.sessionId ?? "", task.id));
        if (result !== undefined) toast.error(t("chat.taskStopped", { id: task.id }));
        setStoppingTask(null);
    }

    async function respondAttention(item: AttentionItem, response: unknown) {
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

    const streamHead = (
        <div className="stream-head">
            <button
                type="button"
                className="btn btn--sm btn--ghost chat-btn--tree"
                onClick={() => setTreeOpen(true)}
            >
                <Icon name="branch" />
                {t("chat.sessions")}
            </button>
            <button
                type="button"
                className="btn btn--sm btn--ghost chat-btn--collapse"
                title={t("chat.collapseTree")}
                aria-label={t("chat.collapseTree")}
                onClick={() => setTreeCollapsed(!treeCollapsed)}
            >
                <Icon name="chevron-right" />
            </button>
            <div className="stream-title">
                {active ? <StatusDot status={sessionDot(active)} title={t(`state.${sessionStatusKey(active)}`)} /> : null}
                <span className="stream-name truncate">
                    {active?.name?.trim() || (active ? active.sessionId : (workspace?.name ?? t("nav.chat")))}
                </span>
                {active?.flags.attention && active.attention.length ? (
                    <Badge tone="warn">{t("chat.pending", { n: active.attention.length })}</Badge>
                ) : null}
                {active ? (
                    <Badge className="stream-status">{t(`state.${sessionStatusKey(active)}`)}</Badge>
                ) : null}
            </div>
            <div className="spacer" />
            <span className={cn("chat-conn", connected ? "is-on" : "is-off")}>
                <StatusDot status={connected ? "ok" : "exited"} />
                <span>{t(connected ? "state.online" : "state.offline")}</span>
            </span>
            <span className="muted truncate stream-meta" title={workspace?.cwd ?? ""}>
                {workspace?.name ?? t("chat.workspace")}
                {active?.contextUsage
                    ? ` · ctx ${active.contextUsage.tokens}/${active.contextUsage.window}`
                    : ""}
            </span>
            <button
                type="button"
                className="btn btn--sm chat-btn--panel"
                onClick={() => setPanelOpen(true)}
            >
                <Icon name="branch" />
                {t("chat.panel")}
            </button>
        </div>
    );

    return (
        <>
            <ChatLayout
                treeOpen={treeOpen}
                panelOpen={panelOpen}
                treeCollapsed={treeCollapsed}
                treeWidth={treeWidth}
                panelWidth={panelWidth}
                onWidths={setWidths}
                onCloseDrawers={closeDrawers}
                tree={
                    <SessionTree
                        sessions={sessions}
                        workspaces={workspaces}
                        activeWorkspaceId={workspaceId}
                        selectedId={active?.sessionId ?? null}
                        filter={filter}
                        collapsed={collapsed}
                        connected={connected}
                        creating={creating}
                        onFilter={setFilter}
                        onToggleCollapse={toggleCollapsed}
                        onToggleAll={() => setAllCollapsed(allIds, anyOpen)}
                        onSelectSession={navigateSession}
                        onSelectWorkspace={navigateWorkspace}
                        onNewSession={() => void handleNewSession()}
                        onRenameSession={(session) => setRenaming({ kind: "session", session })}
                        onCloseSession={setClosing}
                        onOpenSubagent={(session, subagent) => setPreview({ session, subagent })}
                        onRenameSubagent={(subagent) => setRenaming({ kind: "subagent", subagent })}
                        onCloseDrawer={() => setTreeOpen(false)}
                    />
                }
                stream={
                    <>
                        {streamHead}
                        {active ? (
                            <MessageStream
                                session={active}
                                entries={history.entries}
                                hasMore={history.hasMore}
                                loadingOlder={history.loadingOlder}
                                error={history.error}
                                onLoadOlder={history.loadOlder}
                                onRetry={history.retry}
                                onOpenSubagent={(subagent) => setPreview({ session: active, subagent })}
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
                        <Composer
                            session={active ?? null}
                            models={models}
                            connected={connected}
                            paired={paired}
                            sending={sending}
                            onSend={(text, images) => void handleSend(text, images)}
                            onAbort={() => {
                                setSending(null);
                                void exec(chatCommands.abort(active?.sessionId ?? ""));
                            }}
                            onRemoveQueue={(id) =>
                                void exec(chatCommands.removeQueued(active?.sessionId ?? "", id), "chat.queueRemoved")
                            }
                            onSetSteer={(id, steer) =>
                                void exec(
                                    chatCommands.setQueueSteer(active?.sessionId ?? "", id, steer),
                                    steer ? "chat.steerOn" : "chat.steerOff",
                                )
                            }
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
                    </>
                }
                panel={
                    <SidePanel
                        session={active ?? emptySession}
                        tab={tab as PanelTab}
                        onTab={setTab}
                        onDispatch={() => setDispatchOpen(true)}
                        onOpenSubagent={(subagent) => {
                            if (active) setPreview({ session: active, subagent });
                        }}
                        onOpenTask={setTaskOutput}
                        onStopTask={setStoppingTask}
                        onCloseDrawer={() => setPanelOpen(false)}
                    />
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

            <SubagentModal
                open={Boolean(preview)}
                session={preview?.session ?? active ?? emptySession}
                subagent={preview?.subagent ?? null}
                onClose={() => setPreview(null)}
                onBack={() => {
                    if (preview) {
                        navigateSession(preview.session.sessionId);
                        toast(t("chat.returnedParent", { name: preview.session.name ?? preview.session.sessionId }));
                    }
                    setPreview(null);
                }}
                onSteer={(subagent, message) => {
                    const sessionId = active?.sessionId ?? preview?.session.sessionId;
                    if (!sessionId) return;
                    void exec(
                        chatCommands.steerSubagent(sessionId, subagent.name ?? subagent.id, message),
                        "chat.steerSent",
                        { text: message },
                    );
                }}
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
                        ? (renaming.session.name ?? renaming.session.sessionId)
                        : (renaming?.subagent.name ?? renaming?.subagent.id ?? "")
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
                    closing ? t("chat.closeSessionText", { name: closing.name ?? closing.sessionId }) : undefined
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
