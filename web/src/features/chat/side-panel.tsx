/**
 * @deprecated v0.1.1 Chat IA v3 — the right panel is gone. Subagents live in the
 * session tree / child view, and Todo + Tasks moved to the anchored session tray
 * (`./session-tray.tsx`, triggered by the stream-head chips). This file is kept
 * only because it still typechecks against the store and other pages may import
 * it; nothing in the Chat page renders it any more. Delete once no importer
 * remains.
 */
import type { SessionState, Subagent, TaskItem } from "@protocol/types";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Empty } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { TodoList } from "./blocks";
import { formatDuration } from "./format";
import { flattenSubagents } from "./session-state";
import type { PanelTab } from "./store";

const SUB_BADGE: Record<string, { tone: BadgeProps["tone"]; label: string }> = {
    active: { tone: "info", label: "active" },
    completed: { tone: "ok", label: "completed" },
    failed: { tone: "err", label: "failed" },
    interrupted: { tone: "warn", label: "interrupted" },
    dormant: { tone: "default", label: "dormant" },
};

function subagentStatus(status: Subagent["status"]) {
    return SUB_BADGE[status] ?? { tone: "default" as const, label: status };
}

function taskDot(status: TaskItem["status"]): "busy" | "ok" | "err" | "idle" {
    if (status === "running") return "busy";
    if (status === "completed") return "ok";
    if (status === "failed") return "err";
    return "idle";
}

export interface SidePanelProps {
    session: SessionState;
    /** Legacy three-tab vocabulary; the deprecated `subagents` tab is still accepted. */
    tab: PanelTab | "subagents";
    onTab: (tab: PanelTab | "subagents") => void;
    onDispatch: () => void;
    onOpenSubagent: (subagent: Subagent) => void;
    onOpenTask: (task: TaskItem) => void;
    onStopTask: (task: TaskItem) => void;
    onCloseDrawer?: () => void;
    className?: string;
}

/** Right panel: Subagents / Todo / Tasks (tabs + counts + empty states). */
export function SidePanel({
    session,
    tab,
    onTab,
    onDispatch,
    onOpenSubagent,
    onOpenTask,
    onStopTask,
    onCloseDrawer,
    className,
}: SidePanelProps) {
    const { t } = useTranslation();
    const subagents = flattenSubagents(session.subagents);
    const tasks = session.tasks;
    const tabs: { id: PanelTab | "subagents"; label: string; count: number }[] = [
        { id: "subagents", label: t("chat.tabSubagents"), count: subagents.length },
        { id: "todo", label: t("chat.tabTodo"), count: session.todos.length },
        { id: "tasks", label: t("chat.tabTasks"), count: tasks.length },
    ];

    return (
        <div className={cn("panel-pane__inner", className)}>
            <div className="tabs panel-tabs" role="tablist" aria-label={t("chat.panel")}>
                {tabs.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={tab === item.id}
                        className={cn("tab", tab === item.id && "active")}
                        data-testid={`panel-tab-${item.id}`}
                        onClick={() => onTab(item.id)}
                    >
                        {item.label}
                        {item.count ? <span className="badge">{item.count}</span> : null}
                    </button>
                ))}
                <div className="spacer" />
                {onCloseDrawer ? (
                    <button
                        type="button"
                        className="icon-btn panel-close"
                        title={t("chat.closePanel")}
                        aria-label={t("chat.closePanel")}
                        onClick={onCloseDrawer}
                    >
                        <Icon name="x" />
                    </button>
                ) : null}
            </div>
            <div className="panel-scroll">
                <div className="panel__body stack">
                    {tab === "subagents" ? (
                        <>
                            <div className="row">
                                <span className="muted grow">
                                    {t("chat.currentSubagents", { n: subagents.length })}
                                </span>
                                <button type="button" className="btn btn--sm btn--primary" onClick={onDispatch}>
                                    <Icon name="plus" />
                                    {t("chat.dispatch")}
                                </button>
                            </div>
                            {subagents.length ? (
                                <div className="stack">
                                    {subagents.map(({ subagent, depth }) => {
                                        const badge = subagentStatus(subagent.status);
                                        return (
                                            <div
                                                key={subagent.id}
                                                className={cn("sub-item", depth > 0 && "sub-item--nested")}
                                                style={depth ? { marginLeft: `${depth * 16}px` } : undefined}
                                                role="button"
                                                tabIndex={0}
                                                onClick={() => onOpenSubagent(subagent)}
                                                onKeyDown={(event) => {
                                                    if (event.key === "Enter" || event.key === " ") {
                                                        event.preventDefault();
                                                        onOpenSubagent(subagent);
                                                    }
                                                }}
                                            >
                                                <span
                                                    className={cn(
                                                        "dot",
                                                        subagent.status === "active"
                                                            ? "dot--busy"
                                                            : subagent.status === "completed"
                                                              ? "dot--ok"
                                                              : subagent.status === "failed"
                                                                ? "dot--err"
                                                                : subagent.status === "interrupted"
                                                                  ? "dot--attention"
                                                                  : "dot--exited",
                                                    )}
                                                />                                                <span className="sub-item__main">
                                                    <span className="sub-item__name truncate">
                                                        {subagent.name ?? subagent.id}
                                                    </span>
                                                    <span className="sub-item__meta muted truncate">
                                                        {subagent.model ?? "—"}
                                                        {subagent.thinking ? ` · ${subagent.thinking}` : ""}
                                                    </span>
                                                </span>
                                                <Badge tone={badge.tone}>{t(`state.${badge.label}`)}</Badge>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <Empty
                                    icon={<Icon name="branch" />}
                                    title={t("chat.noSubagents")}
                                    description={t("chat.noSubagentsText")}
                                />
                            )}
                        </>
                    ) : null}

                    {tab === "todo" ? (
                        session.todos.length ? (
                            <>
                                <div className="row">
                                    <span className="muted grow">
                                        {t("chat.progress", {
                                            done: session.todos.filter((item) => item.status === "completed").length,
                                            total: session.todos.length,
                                        })}
                                    </span>
                                    <Badge>{t("common.readonly")}</Badge>
                                </div>
                                <Progress
                                    value={session.todos.filter((item) => item.status === "completed").length}
                                    max={session.todos.length || 1}
                                />
                                <TodoList items={session.todos} idPrefix="panel-todo" />
                                <div className="muted panel__note">{t("chat.todoNote")}</div>
                            </>
                        ) : (
                            <Empty
                                icon={<Icon name="todo" />}
                                title={t("chat.noTodo")}
                                description={t("chat.noTodoText")}
                            />
                        )
                    ) : null}

                    {tab === "tasks" ? (
                        tasks.length ? (
                            tasks.map((task) => {
                                const running = task.status === "running";
                                const duration = running ? Date.now() - task.startTime : (task.durationMs ?? 0);
                                return (
                                    <div
                                        key={task.id}
                                        className="task-item"
                                        role="button"
                                        tabIndex={0}
                                        data-task-id={task.id}
                                        onClick={() => onOpenTask(task)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter" || event.key === " ") {
                                                event.preventDefault();
                                                onOpenTask(task);
                                            }
                                        }}
                                    >
                                        <StatusDot status={taskDot(task.status)} />
                                        <span className="grow">
                                            <span className="task-item__cmd mono truncate" title={task.command}>
                                                {task.command}
                                            </span>
                                            <span className="task-item__meta muted">
                                                {running ? <Spinner /> : null}
                                                <span>{formatDuration(duration)}</span>
                                                {task.exitCode != null ? (
                                                    <Badge tone={task.exitCode === 0 ? "ok" : "err"}>
                                                        {`exit ${task.exitCode}`}
                                                    </Badge>
                                                ) : (
                                                    <span>{t(`state.${task.status}`)}</span>
                                                )}
                                            </span>
                                        </span>
                                        {running ? (
                                            <button
                                                type="button"
                                                className="btn btn--sm btn--danger"
                                                onClick={(event) => {
                                                    event.stopPropagation();
                                                    onStopTask(task);
                                                }}
                                            >
                                                {t("common.stop")}
                                            </button>
                                        ) : null}
                                    </div>
                                );
                            })
                        ) : (
                            <Empty
                                icon={<Icon name="terminal" />}
                                title={t("chat.noTasks")}
                                description={t("chat.noTasksText")}
                            />
                        )
                    ) : null}
                </div>
            </div>
        </div>
    );
}
