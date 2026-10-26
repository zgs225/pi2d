import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { cn } from "@/lib/utils";

import type { TrayTab } from "./store";

export interface HeadChipsProps {
    /** Completed / total todo items of the current scope (session scope in the child view). */
    planDone: number;
    planTotal: number;
    /** Background tasks in the current scope. */
    taskCount: number;
    runningTasks: number;
    /** Which tray tab is selected — drives `aria-expanded` / `is-open`. */
    trayTab: TrayTab;
    trayOpen: boolean;
    /** Chip click. The chip is a *toggle*: same tab again closes the tray. */
    onToggle: (tab: TrayTab) => void;
    /** Hands the chip element back so the page can restore focus on close. */
    registerTrigger?: (tab: TrayTab, element: HTMLButtonElement | null) => void;
    className?: string;
}

/**
 * Stream-head chips (v0.1.1 Chat IA v3): `计划 c/t` + `任务 n`.
 *
 * They replace the old right panel tabs. Both are dialog triggers — the tray
 * itself is `role="dialog" aria-modal="false"` anchored under the stream head.
 * `.head-chip__label` is hidden below 1150px, so the icons + counts must be
 * readable on their own (the `aria-label` carries the full sentence).
 */
export function HeadChips({
    planDone,
    planTotal,
    taskCount,
    runningTasks,
    trayTab,
    trayOpen,
    onToggle,
    registerTrigger,
    className,
}: HeadChipsProps) {
    const { t } = useTranslation();
    const planOpen = trayOpen && trayTab === "todo";
    const tasksOpen = trayOpen && trayTab === "tasks";
    const running = runningTasks > 0;

    return (
        <div className={cn("head-chips", className)} data-testid="head-chips">
            <button
                type="button"
                ref={(element) => registerTrigger?.("todo", element)}
                className={cn("head-chip", planOpen && "is-open")}
                data-testid="head-chip-plan"
                aria-haspopup="dialog"
                aria-expanded={planOpen}
                aria-controls="chat-tray"
                aria-label={t("chat.planAria")}
                title={t("chat.planAria")}
                onClick={() => onToggle("todo")}
            >
                <Icon name="todo" />
                <span className="head-chip__label">{t("chat.plan")}</span>
                <span className="head-chip__count tabular">
                    {planTotal ? `${planDone}/${planTotal}` : "—"}
                </span>
            </button>
            <button
                type="button"
                ref={(element) => registerTrigger?.("tasks", element)}
                className={cn("head-chip", running && "has-running", tasksOpen && "is-open")}
                data-testid="head-chip-tasks"
                aria-haspopup="dialog"
                aria-expanded={tasksOpen}
                aria-controls="chat-tray"
                aria-label={t("chat.tasksAria")}
                title={t("chat.tasksAria")}
                onClick={() => onToggle("tasks")}
            >
                <Icon name="terminal" />
                <span className="head-chip__label">{t("chat.tabTasks")}</span>
                {running ? <span className="dot dot--busy" aria-hidden="true" /> : null}
                <span className="head-chip__count tabular">{taskCount}</span>
            </button>
        </div>
    );
}
