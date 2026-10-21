import type { ModelRef, SessionState, Subagent, TaskItem, ThinkingLevel } from "@protocol/types";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { KV } from "@/components/ui/kv";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { ApiError, errorI18nKey } from "@/lib/api";
import { cn } from "@/lib/utils";
import { chatCommands, runCommand } from "./commands";
import type { ModelGroup } from "./data";
import { withCurrentModel } from "./data";
import { formatDuration, THINKING_LEVELS } from "./format";
import { flattenSubagents } from "./session-state";

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
/* subagent conversation (read-only tail + steer)                      */
/* ------------------------------------------------------------------ */

const SUB_BADGE: Record<Subagent["status"], { tone: "info" | "ok" | "err" | "warn" | "default"; key: string }> = {
    active: { tone: "info", key: "active" },
    completed: { tone: "ok", key: "completed" },
    failed: { tone: "err", key: "failed" },
    interrupted: { tone: "warn", key: "interrupted" },
    dormant: { tone: "default", key: "dormant" },
};

const SUB_DOT: Record<Subagent["status"], string> = {
    active: "dot--busy",
    completed: "dot--ok",
    failed: "dot--err",
    interrupted: "dot--attention",
    dormant: "dot--exited",
};

/**
 * One projected line of a sub-session file.
 *
 * `subagent.read` returns `{sessionFile, lines}` where each line is the plugin's
 * text projection of a raw pi entry (`"[12] user: please fix it"`, see
 * `pi.subsessions.read.project_entry`).
 */
export interface SubagentEntry {
    id: string;
    role: string;
    text: string;
}

const SUB_ROLES = new Set(["user", "assistant", "system", "notice", "toolResult", "toolUse"]);

/** Parse `[<index>] <role>: <text>` back into role + text rows. */
export function parseSubagentLines(lines: unknown): SubagentEntry[] {
    if (!Array.isArray(lines)) return [];
    const out: SubagentEntry[] = [];
    lines.forEach((value, position) => {
        const line = typeof value === "string" ? value : JSON.stringify(value);
        if (!line) return;
        const match = /^\[(\d+)\]\s*([A-Za-z_]+):\s?([\s\S]*)$/.exec(line);
        if (match && SUB_ROLES.has(match[2] ?? "")) {
            out.push({ id: `sub-${match[1]}`, role: match[2] ?? "system", text: match[3] ?? "" });
            return;
        }
        out.push({ id: `sub-line-${position}`, role: "system", text: line });
    });
    return out;
}

export interface SubagentModalProps {
    open: boolean;
    session: SessionState;
    subagent: Subagent | null;
    onClose: () => void;
    onBack: () => void;
    onSteer: (subagent: Subagent, message: string) => void;
}

export function SubagentModal({ open, session, subagent, onClose, onBack, onSteer }: SubagentModalProps) {
    const { t } = useTranslation();
    const [steer, setSteer] = useState("");
    const [feed, setFeed] = useState<SubagentEntry[]>([]);
    const [sessionFile, setSessionFile] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const badge = subagent ? (SUB_BADGE[subagent.status] ?? { tone: "default" as const, key: subagent.status }) : null;

    useEffect(() => {
        if (!open || !subagent) return;
        let cancelled = false;
        setFeed([]);
        setSessionFile(null);
        setError(null);
        setLoading(true);
        const target = subagent.name ?? subagent.id;
        void runCommand(chatCommands.readSubagent(session.sessionId, target))
            .then((response) => {
                if (cancelled) return;
                const raw = rec(response) ?? {};
                setSessionFile(str(raw.sessionFile) ?? null);
                setFeed(parseSubagentLines(raw.lines ?? raw.entries));
            })
            .catch((cause: unknown) => {
                if (cancelled) return;
                setError(commandErrorText(cause, t));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [open, session.sessionId, subagent, t]);

    const children = useMemo(() => (subagent ? flattenSubagents(subagent.children) : []), [subagent]);

    function sendSteer() {
        if (!steer.trim()) {
            toast.error(t("chat.steerRequired"));
            return;
        }
        if (subagent) onSteer(subagent, steer.trim());
        setSteer("");
    }

    return (
        <Modal
            open={open}
            onOpenChange={(next) => {
                if (!next) onClose();
            }}
            title={t("chat.subagentTitle", { name: subagent?.name ?? subagent?.id ?? "" })}
            size="wide"
            footer={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        {t("common.close")}
                    </Button>
                    <Button variant="primary" onClick={onBack}>
                        {t("chat.backToParent")}
                    </Button>
                </>
            }
        >
            {subagent ? (
                <div className="sub-preview">
                    <div className="row">
                        <span className={`dot ${SUB_DOT[subagent.status] ?? "dot--exited"}`} />
                        {badge ? <Badge tone={badge.tone}>{t(`state.${badge.key}`)}</Badge> : null}
                        <span className="muted mono truncate">{subagent.id}</span>
                    </div>
                    <div>
                        <KV label={t("chat.task")}>{subagent.task ?? "—"}</KV>
                        <KV label={t("chat.model")} mono>
                            {subagent.model ?? "—"}
                            {subagent.thinking ? ` · ${subagent.thinking}` : ""}
                        </KV>
                        <KV label={t("status.created")}>
                            <RelativeTime ts={subagent.createdAt} />
                        </KV>
                        <KV label={t("status.lastActive")}>
                            <RelativeTime ts={subagent.lastActiveAt} />
                        </KV>
                    </div>
                    {children.length ? (
                        <div className="stack">
                            <div className="muted">{t("chat.currentSubagents", { n: children.length })}</div>
                            {children.map(({ subagent: child, depth }) => (
                                <div
                                    key={child.id}
                                    className="sub-item sub-item--nested"
                                    style={{ marginLeft: `${depth * 16}px` }}
                                >
                                    <span className={`dot ${SUB_DOT[child.status] ?? "dot--exited"}`} />
                                    <span className="sub-item__main">
                                        <span className="sub-item__name truncate">{child.name ?? child.id}</span>
                                        <span className="sub-item__meta muted truncate">{child.model ?? "—"}</span>
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    <div className="sub-preview__feed" aria-label={t("chat.preview")}>
                        {loading ? (
                            <div className="row muted">
                                <Spinner /> {t("chat.loading")}
                            </div>
                        ) : error ? (
                            <div className="msg__error" role="alert">
                                <div className="msg__error-meta">
                                    <span className="who who--err">{t("chat.error")}</span>
                                </div>
                                <div className="msg__text">{error}</div>
                            </div>
                        ) : feed.length ? (
                            feed.map((entry) => (
                                <article
                                    key={entry.id}
                                    className={cn("msg", `msg--${entry.role === "user" ? "user" : "assistant"}`)}
                                    data-entry-id={entry.id}
                                    data-role={entry.role}
                                >
                                    <div className="msg__meta">
                                        <span className={cn("who", entry.role === "user" ? "who--user" : "who--agent")}>
                                            {entry.role}
                                        </span>
                                        <span className="muted msg__time mono">{entry.id}</span>
                                    </div>
                                    <div className="msg__text">{entry.text}</div>
                                </article>
                            ))
                        ) : (
                            <div className="muted">{t("chat.noOutput")}</div>
                        )}
                    </div>
                    {sessionFile ? <div className="muted mono truncate">{sessionFile}</div> : null}
                    <div className="muted sub-preview__note">{t("chat.previewNote")}</div>
                    <div className="row sub-steer">
                        <input
                            className="input"
                            value={steer}
                            placeholder={t("chat.steerPlaceholder")}
                            aria-label={t("chat.steer")}
                            onChange={(event) => setSteer(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                                    event.preventDefault();
                                    sendSteer();
                                }
                            }}
                        />
                        <Button size="sm" onClick={sendSteer}>
                            {t("chat.steer")}
                        </Button>
                    </div>
                </div>
            ) : null}
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
