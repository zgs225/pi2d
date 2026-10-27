import type { ModelRef, SessionState, TaskItem, ThinkingLevel } from "@protocol/types";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { KV } from "@/components/ui/kv";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { ApiError, errorI18nKey } from "@/lib/api";
import { chatCommands, runCommand } from "./commands";
import type { ModelGroup } from "./data";
import { withCurrentModel } from "./data";
import { formatDuration, THINKING_LEVELS } from "./format";

function rec(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Human-readable text for a failed command (`ApiError.code` → `errors.*`). */
function commandErrorText(error: unknown, translate: (key: string) => string): string {
    if (error instanceof ApiError) return translate(errorI18nKey(error.code));
    return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */

export interface DispatchInput {
    task: string;
    name?: string;
    model?: ModelRef;
    thinking?: ThinkingLevel;
    wait?: boolean;
    cancelSiblingsOnFail?: boolean;
}

export interface DispatchModalProps {
    open: boolean;
    session: SessionState;
    models: ModelGroup[];
    onClose: () => void;
    onDispatch: (input: DispatchInput) => void | Promise<void>;
}

export function DispatchModal({ open, session, models, onClose, onDispatch }: DispatchModalProps) {
    const { t } = useTranslation();
    const groups = withCurrentModel(models, session.model);
    const [task, setTask] = useState("");
    const [name, setName] = useState("");
    const [modelValue, setModelValue] = useState("");
    const [thinking, setThinking] = useState<ThinkingLevel>("low");
    const [wait, setWait] = useState(false);
    const [cancelSiblings, setCancelSiblings] = useState(true);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        const first = groups[0]?.provider && groups[0]?.models[0] ? `${groups[0].provider}/${groups[0].models[0].id}` : "";
        setModelValue(session.model ? `${session.model.provider}/${session.model.id}` : first);
    }, [open, session.model, groups]);

    function parseModel(): ModelRef | undefined {
        const slash = modelValue.indexOf("/");
        if (slash <= 0) return undefined;
        return { provider: modelValue.slice(0, slash), id: modelValue.slice(slash + 1) };
    }

    async function submit() {
        if (!task.trim()) {
            toast.error(t("chat.taskRequired"));
            return;
        }
        setBusy(true);
        try {
            await onDispatch({
                task: task.trim(),
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(parseModel() ? { model: parseModel() } : {}),
                thinking,
                wait,
                cancelSiblingsOnFail: cancelSiblings,
            });
            setTask("");
            setName("");
            onClose();
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            title={t("chat.dispatchTitle")}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button variant="primary" onClick={() => void submit()} disabled={busy}>
                        {t("chat.dispatch")}
                    </Button>
                </>
            }
        >
            <div className="field">
                <label htmlFor="dispatch-task">{t("chat.taskLabel")}</label>
                <textarea
                    id="dispatch-task"
                    className="textarea"
                    rows={3}
                    value={task}
                    placeholder={t("chat.taskPlaceholder")}
                    onChange={(event) => setTask(event.target.value)}
                />
            </div>
            <div className="field">
                <label htmlFor="dispatch-name">{t("chat.nameLabel")}</label>
                <input
                    id="dispatch-name"
                    className="input"
                    value={name}
                    placeholder={t("chat.subagentNamePlaceholder")}
                    onChange={(event) => setName(event.target.value)}
                />
            </div>
            <div className="field">
                <label htmlFor="dispatch-model">{t("chat.modelLabel")}</label>
                <select
                    id="dispatch-model"
                    className="select"
                    value={modelValue}
                    onChange={(event) => setModelValue(event.target.value)}
                >
                    {groups.map((group) => (
                        <optgroup key={group.provider} label={group.provider}>
                            {group.models.map((item) => (
                                <option key={`${group.provider}/${item.id}`} value={`${group.provider}/${item.id}`}>
                                    {item.id}
                                </option>
                            ))}
                        </optgroup>
                    ))}
                </select>
            </div>
            <div className="field">
                <label htmlFor="dispatch-thinking">{t("chat.thinkingAria")}</label>
                <select
                    id="dispatch-thinking"
                    className="select"
                    value={thinking}
                    onChange={(event) => setThinking(event.target.value as ThinkingLevel)}
                >
                    {THINKING_LEVELS.map((level) => (
                        <option key={level} value={level}>
                            {level}
                        </option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label className="check-row">
                    <input type="checkbox" checked={wait} onChange={(event) => setWait(event.target.checked)} />
                    {t("chat.waitLabel")}
                </label>
            </div>
            <div className="field">
                <label className="check-row">
                    <input
                        type="checkbox"
                        checked={cancelSiblings}
                        onChange={(event) => setCancelSiblings(event.target.checked)}
                    />
                    {t("chat.cancelSiblingsLabel")}
                </label>
            </div>
        </Modal>
    );
}

/* ------------------------------------------------------------------ */
/* task output                                                         */
/* ------------------------------------------------------------------ */

/** `task.output` response payload (plugin handler, `docs/protocol.md` §3.2). */
export interface TaskOutputResult {
    output?: string;
    outputFile?: string;
    status?: TaskItem["status"];
    exitCode?: number | null;
    durationMs?: number;
}

/** Read the fields the modal renders, ignoring anything the daemon added. */
export function normalizeTaskOutput(raw: unknown): TaskOutputResult {
    const record = rec(raw) ?? {};
    const status = str(record.status);
    return {
        ...(str(record.output) !== undefined ? { output: str(record.output) } : {}),
        ...(str(record.outputFile) !== undefined ? { outputFile: str(record.outputFile) } : {}),
        ...(status ? { status: status as TaskItem["status"] } : {}),
        ...(record.exitCode === null || num(record.exitCode) !== undefined
            ? { exitCode: record.exitCode === null ? null : num(record.exitCode) }
            : {}),
        ...(num(record.durationMs) !== undefined ? { durationMs: num(record.durationMs) } : {}),
    };
}

export interface TaskOutputModalProps {
    open: boolean;
    session: SessionState;
    task: TaskItem | null;
    onClose: () => void;
    onStop: (task: TaskItem) => void;
}

export function TaskOutputModal({ open, session, task, onClose, onStop }: TaskOutputModalProps) {
    const { t } = useTranslation();
    const [result, setResult] = useState<TaskOutputResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open || !task) return;
        let cancelled = false;
        setResult(null);
        setError(null);
        setLoading(true);
        void runCommand(chatCommands.taskOutput(session.sessionId, task.id))
            .then((response) => {
                if (!cancelled) setResult(normalizeTaskOutput(response));
            })
            .catch((cause: unknown) => {
                // A real failure (e.g. E_UNSUPPORTED on an older plugin) is shown
                // as-is; it must not look like an empty output file.
                if (!cancelled) setError(commandErrorText(cause, t));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, session.sessionId, task, t]);

    if (!task) return null;
    const status = result?.status ?? task.status;
    const running = status === "running";
    const duration = result?.durationMs ?? (running ? Date.now() - task.startTime : (task.durationMs ?? 0));
    const exitCode = result?.exitCode !== undefined ? result.exitCode : (task.exitCode ?? null);
    const outputFile = result?.outputFile ?? task.outputFile;

    return (
        <Modal
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            title={t("chat.taskOutput", { id: task.id })}
            footer={
                <>
                    {running ? (
                        <Button variant="danger" onClick={() => onStop(task)}>
                            {t("common.stop")}
                        </Button>
                    ) : null}
                    <Button variant="primary" onClick={onClose}>
                        {t("common.close")}
                    </Button>
                </>
            }
        >
            <div className="stack">
                <pre className="mono tool__pre" data-testid="task-output">
                    {loading
                        ? t("chat.loading")
                        : error
                          ? t("chat.commandFailed", { error })
                          : (result?.output ?? t("chat.noOutput"))}
                </pre>
                {outputFile ? <div className="muted mono truncate">{outputFile}</div> : null}
                <div>
                    <KV label={t("chat.status")}>
                        <span className="row">
                            <span className={`dot ${running ? "dot--busy" : status === "completed" ? "dot--ok" : status === "failed" ? "dot--err" : "dot--idle"}`} />
                            {t(`state.${status}`)}
                        </span>
                    </KV>
                    <KV label={t("chat.duration")}>{formatDuration(duration)}</KV>
                    <KV label="exit code" mono>
                        {exitCode == null ? "—" : exitCode}
                    </KV>
                    <KV label={t("chat.command")} mono>
                        {task.command}
                    </KV>
                </div>
                {running ? (
                    <div className="row muted">
                        <Spinner /> {t("chat.taskRunning")}
                    </div>
                ) : null}
            </div>
        </Modal>
    );
}

/* ------------------------------------------------------------------ */
/* rename                                                              */
/* ------------------------------------------------------------------ */

export interface RenameDialogProps {
    open: boolean;
    title: string;
    initial: string;
    hint?: string;
    onClose: () => void;
    onSave: (value: string) => void | Promise<void>;
}

export function RenameDialog({ open, title, initial, hint, onClose, onSave }: RenameDialogProps) {
    const { t } = useTranslation();
    const [value, setValue] = useState(initial);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (open) {
            setValue(initial);
            setError(null);
        }
    }, [open, initial]);

    async function save() {
        const trimmed = value.trim();
        if (!trimmed) {
            setError(t("chat.nameRequired"));
            return;
        }
        setBusy(true);
        try {
            await onSave(trimmed);
            onClose();
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            title={title}
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {t("common.cancel")}
                    </Button>
                    <Button variant="primary" onClick={() => void save()} disabled={busy}>
                        {t("common.save")}
                    </Button>
                </>
            }
        >
            <div className="field">
                <label htmlFor="rename-input">{t("chat.name")}</label>
                <input
                    id="rename-input"
                    className="input"
                    value={value}
                    onChange={(event) => {
                        setValue(event.target.value);
                        setError(null);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            void save();
                        }
                    }}
                />
                {error ? (
                    <div className="hint is-err" role="alert">
                        {error}
                    </div>
                ) : hint ? (
                    <div className="hint">{hint}</div>
                ) : null}
            </div>
        </Modal>
    );
}
