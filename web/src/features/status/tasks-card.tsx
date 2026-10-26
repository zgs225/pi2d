import { useTranslation } from "react-i18next";

import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import type { StatusTask } from "@/features/status/queries";
import { formatDuration } from "@/features/status/server";

import { ErrorBlock, LoadingBlock, StatusCard, StatusEmpty } from "./card-parts";

export type { StatusTask };

const TASK_DOT: Record<string, DotStatus> = {
    running: "busy",
    completed: "ok",
    failed: "err",
    stopped: "exited",
};

export interface TasksCardProps {
    tasks: StatusTask[];
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
}

/** Card 5 — background tasks from the live session store plus every workspace's sessions. */
export function TasksCard({ tasks, loading = false, error = null, onRetry }: TasksCardProps) {
    const { t } = useTranslation();
    return (
        <StatusCard
            title={t("status.tasks")}
            icon="terminal"
            headExtra={<span className="card__sub">{t("status.taskCount", { n: tasks.length })}</span>}
        >
            {error ? (
                <ErrorBlock message={error} onRetry={onRetry} />
            ) : loading ? (
                <LoadingBlock rows={3} />
            ) : tasks.length === 0 ? (
                <StatusEmpty icon="terminal" title={t("status.noTasksTitle")} text={t("status.noTasksText")} />
            ) : (
                <div className="task-list">
                    {tasks.map((task) => (
                        <div className="task-row" key={`${task.sessionId}-${task.id}`} title={task.command}>
                            <StatusDot status={TASK_DOT[task.status] ?? "idle"} />
                            <span className="task-cmd mono truncate grow">{task.command}</span>
                            <span className="task-dur faint tabular">{formatDuration(task.durationMs)}</span>
                            {task.exitCode != null ? (
                                <span className={task.exitCode === 0 ? "task-state mono is-ok" : "task-state mono is-err"}>
                                    exit {task.exitCode}
                                </span>
                            ) : (
                                <span className={task.status === "running" ? "task-state is-run" : "task-state"}>
                                    {t(`state.${task.status}`, { defaultValue: task.status })}
                                </span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </StatusCard>
    );
}
