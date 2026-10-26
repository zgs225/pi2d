import type { SessionState, Subagent, TaskItem } from "@protocol/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Empty } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";

import { TodoList } from "./blocks";
import { formatDuration } from "./format";
import type { TrayTab } from "./store";

import "@/styles/pages/chat-tray.css";

export interface SessionTrayProps {
    open: boolean;
    tab: TrayTab;
    /** The session whose Todo/Tasks are shown (subagent rows share the session's data). */
    session: SessionState | null;
    /**
     * Subagent currently opened in the child view — the tray keeps showing
     * **session-scoped** Todo/Tasks (pi2d has no per-subagent buckets yet) and
     * says so explicitly instead of silently pretending to be scoped.
     */
    subagent: Subagent | null;
    onTab: (tab: TrayTab) => void;
    onClose: () => void;
    onOpenTask: (task: TaskItem) => void;
    onStopTask: (task: TaskItem) => void;
    className?: string;
}

const TABS: TrayTab[] = ["todo", "tasks"];

function taskDot(status: TaskItem["status"]): DotStatus {
    if (status === "running") return "busy";
    if (status === "completed") return "ok";
    if (status === "failed") return "err";
    return "idle";
}

/**
 * Session tray (v0.1.1 Chat IA v3) — the replacement for the old right panel.
 *
 * Anchored under the stream head (`top: 54px`), never a third column:
 * `role="dialog" aria-modal="false"` because it is non-blocking and the stream
 * stays interactive. Two tabs only (`todo` / `tasks`); subagents moved into the
 * session tree and the child view. Todo is read-only, Tasks has a single write
 * action (stop, confirmed by the page).
 *
 * Keyboard: `←/→` cycle the tablist (roving tabindex), `Esc` closes and the
 * page restores focus to the chip that opened it. Below 600px the tray becomes
 * a bottom sheet with a backdrop; ≥600px the backdrop is always hidden.
 */
export function SessionTray({
    open,
    tab,
    session,
    subagent,
    onTab,
    onClose,
    onOpenTask,
    onStopTask,
    className,
}: SessionTrayProps) {
    const { t } = useTranslation();
    const rootRef = useRef<HTMLElement | null>(null);
    const tabsRef = useRef<HTMLDivElement | null>(null);
    const [entered, setEntered] = useState(false);

    const title = subagent
        ? t("chat.subview.trayTitle", { name: subagent.name ?? subagent.id })
        : t("chat.trayTitle");

    // Enter animation: flip `is-open` on the frame after the node is painted.
    useEffect(() => {
        if (!open) {
            setEntered(false);
            return;
        }
        const frame = requestAnimationFrame(() => setEntered(true));
        return () => cancelAnimationFrame(frame);
    }, [open]);

    // Opening moves focus onto the selected tab (the dialog's first stop).
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => {
            tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
    }, [open]);

    // Esc closes the tray — unless a modal is on top, in which case it belongs
    // to the modal (single-layer close chain).
    useEffect(() => {
        if (!open) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            if (document.querySelector(".modal-backdrop")) return;
            event.preventDefault();
            onClose();
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [onClose, open]);

    // Click outside closes. `composedPath()` (not `contains`) because selecting a
    // tab re-renders and detaches the clicked node first; a chip click is *not*
    // an outside click (it toggles and must keep its own state machine).
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: Event) => {
            if (document.querySelector(".modal-backdrop")) return;
            const path = typeof event.composedPath === "function" ? event.composedPath() : [];
            if (rootRef.current && path.includes(rootRef.current)) return;
            const fromChip = path.some(
                (node) => node instanceof HTMLElement && node.classList.contains("head-chip"),
            );
            if (fromChip) return;
            onClose();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [onClose, open]);

    const moveTab = useCallback(
        (delta: 1 | -1 | "home" | "end") => {
            // Two tabs: ←/→ and Home/End both resolve to the other end.
            const next: TrayTab =
                delta === "home" ? "todo" : delta === "end" ? "tasks" : tab === "todo" ? "tasks" : "todo";
            onTab(next);
            requestAnimationFrame(() => {
                tabsRef.current?.querySelector<HTMLElement>(`[data-tray-tab="${next}"]`)?.focus({
                    preventScroll: true,
                });
            });
        },
        [onTab, tab],
    );

    const todos = session?.todos ?? [];
    const tasks = session?.tasks ?? [];
    const done = todos.filter((item) => item.status === "completed").length;
    const counts: Record<TrayTab, number> = { todo: todos.length, tasks: tasks.length };

    return (
        <>
            <div
                className={cn("tray-backdrop", open && "is-open")}
                data-testid="tray-backdrop"
                aria-hidden="true"
                onClick={onClose}
            />
            <aside
                ref={rootRef}
                id="chat-tray"
                className={cn("session-tray", open && entered && "is-open", className)}
                role="dialog"
                aria-modal="false"
                aria-labelledby="chat-tray-title"
                data-testid="session-tray"
                data-tab={tab}
                hidden={!open}
            >
                <div className="tray-head">
                    <h3 id="chat-tray-title" className="tray-head__title">
                        <Icon name="todo" />
                        <span className="truncate">{title}</span>
                    </h3>
                    <button
                        type="button"
                        className="icon-btn tray-close"
                        aria-label={t("chat.closeTray")}
                        title={t("chat.closeTray")}
                        onClick={onClose}
                    >
                        <Icon name="x" />
                    </button>
                </div>

                <p className="tray-scope" data-testid="tray-scope">
                    <span className="tray-scope__label">
                        {subagent
                            ? t("chat.trayScopeSubagent", { name: subagent.name ?? subagent.id })
                            : t("chat.trayScopeSession")}
                    </span>
                    {subagent ? <span className="tray-scope__note">{t("chat.trayScopeNote")}</span> : null}
                </p>

                <div
                    ref={tabsRef}
                    className="seg seg--quiet tray-tabs"
                    role="tablist"
                    aria-label={t("chat.trayTitle")}
                >
                    {TABS.map((item) => {
                        const selected = tab === item;
                        return (
                            <button
                                key={item}
                                type="button"
                                role="tab"
                                id={`chat-tray-tab-${item}`}
                                data-tray-tab={item}
                                data-testid={`tray-tab-${item}`}
                                className={cn("tray-tab", selected && "active")}
                                aria-selected={selected}
                                aria-controls="chat-tray-body"
                                tabIndex={selected ? 0 : -1}
                                onClick={() => onTab(item)}
                                onKeyDown={(event) => {
                                    if (event.key === "ArrowRight") {
                                        event.preventDefault();
                                        moveTab(1);
                                    } else if (event.key === "ArrowLeft") {
                                        event.preventDefault();
                                        moveTab(-1);
                                    } else if (event.key === "Home") {
                                        event.preventDefault();
                                        moveTab("home");
                                    } else if (event.key === "End") {
                                        event.preventDefault();
                                        moveTab("end");
                                    }
                                }}
                            >
                                <span>{t(item === "todo" ? "chat.tabTodo" : "chat.tabTasks")}</span>
                                {counts[item] ? <span className="badge badge--sm">{counts[item]}</span> : null}
                            </button>
                        );
                    })}
                </div>

                <div
                    className="tray-body"
                    id="chat-tray-body"
                    role="tabpanel"
                    aria-labelledby={`chat-tray-tab-${tab}`}
                >
                    {tab === "todo" ? (
                        todos.length ? (
                            <>
                                <div className="tray-row">
                                    <span className="muted grow">
                                        {t("chat.progress", { done, total: todos.length })}
                                    </span>
                                    <Badge>{t("common.readonly")}</Badge>
                                </div>
                                <Progress value={done} max={todos.length || 1} label={t("chat.tabTodo")} />
                                <TodoList items={todos} idPrefix="tray-todo" />
                                <div className="tray__note muted">{t("chat.todoNote")}</div>
                            </>
                        ) : (
                            <Empty
                                icon={<Icon name="todo" />}
                                title={t("chat.noTodo")}
                                description={t("chat.noTodoText")}
                            />
                        )
                    ) : tasks.length ? (
                        <div className="tray-list">
                            {tasks.map((task) => {
                                const running = task.status === "running";
                                const duration = running ? Date.now() - task.startTime : task.durationMs;
                                return (
                                    <div key={task.id} className="task-row" data-task-id={task.id}>
                                        <StatusDot status={taskDot(task.status)} />
                                        <button
                                            type="button"
                                            className="task-row__main"
                                            title={t("chat.taskOutput", { id: task.id })}
                                            aria-label={t("chat.taskOutput", { id: task.id })}
                                            onClick={() => onOpenTask(task)}
                                        >
                                            <span className="task-row__cmd mono truncate">{task.command}</span>
                                            <span className="task-row__meta">
                                                <span className="tabular">{formatDuration(duration)}</span>
                                                {task.exitCode != null ? (
                                                    <Badge tone={task.exitCode === 0 ? "ok" : "err"}>
                                                        {`exit ${task.exitCode}`}
                                                    </Badge>
                                                ) : (
                                                    <span className="faint">{t(`state.${task.status}`)}</span>
                                                )}
                                            </span>
                                        </button>
                                        {running ? (
                                            <button
                                                type="button"
                                                className="btn btn--sm btn--danger task-row__stop"
                                                onClick={() => onStopTask(task)}
                                            >
                                                {t("common.stop")}
                                            </button>
                                        ) : null}
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <Empty
                            icon={<Icon name="terminal" />}
                            title={t("chat.noTasks")}
                            description={t("chat.noTasksText")}
                        />
                    )}
                </div>
            </aside>
        </>
    );
}
