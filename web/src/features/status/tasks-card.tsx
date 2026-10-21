import { useTranslation } from "react-i18next";

import { StatusDot, type DotStatus } from "@/components/ui/status-dot";
import type { TaskItem } from "@/lib/protocol";
import { formatDuration } from "@/features/status/server";

import { StatusCard, StatusEmpty } from "./card-parts";

export interface StatusTask extends TaskItem {
    sessionId: string;
}

const TASK_DOT: Record<string, DotStatus> = {
    running: "busy",
    completed: "ok",
    failed: "err",
    stopped: "exited",
};

export interface TasksCardProps {
    tasks: StatusTask[];
}

/** Card 5 — background task summary from the live session store. */
export function TasksCard({ tasks }: TasksCardProps) {
    const { t } = useTranslation();
    return (
        <StatusCard
            title={t("status.tasks")}
            icon="terminal"
            headExtra={<span className="card__sub">{t("status.taskCount", { n: tasks.length })}</span>}
        >
            {tasks.length === 0 ? (
                <StatusEmpty icon="terminal" title={t("status.noTasksTitle")} text={t("status.noTasksText")} />
            ) : (
                <div className="task-list">
                    {tasks.map((task) => (
                        <div className="task-row" key={`${task.sessionId}-${task.id}`} title={task.command}>
                            <StatusDot status={TASK_DOT[task.status] ?? "idle"} />
                            <span className="task-cmd mono truncate grow">{task.command}</span>
                            <span className="task-dur muted">{formatDuration(task.durationMs)}</span>
                            <span className="task-exit">
                                {task.exitCode == null ? (
                                    <span className="badge badge--info">{t("state.running")}</span>
                                ) : (
                                    <span className={task.exitCode === 0 ? "badge badge--ok" : "badge badge--err"}>
                                        exit {task.exitCode}
                                    </span>
                                )}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </StatusCard>
    );
}
