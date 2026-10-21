import type { Entry, ModelRef, SessionState, Subagent, TaskItem, ThinkingLevel } from "@protocol/types";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { KV } from "@/components/ui/kv";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { projectEntries } from "@/lib/entry-projection";
import { EntryBlock } from "./blocks";
import { chatCommands, runCommand } from "./commands";
import type { ModelGroup } from "./data";
import { withCurrentModel } from "./data";
import { formatDuration, THINKING_LEVELS } from "./format";
import { flattenSubagents } from "./session-state";

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

function statusTail(subagent: Subagent, t: (key: string) => string): Entry[] {
    const ts = subagent.lastActiveAt ?? subagent.createdAt ?? Date.now();
    if (subagent.status === "failed") {
        return [{ id: `preview-${subagent.id}-err`, role: "notice", ts, done: true, blocks: [{ type: "error", text: t("chat.previewFailed") }] }];
    }
    if (subagent.status === "interrupted") {
        return [{ id: `preview-${subagent.id}-int`, role: "assistant", ts, done: true, blocks: [{ type: "text", text: t("chat.previewInterrupted") }] }];
    }
    if (subagent.status === "completed") {
        return [{ id: `preview-${subagent.id}-done`, role: "assistant", ts, done: true, blocks: [{ type: "text", text: t("chat.previewCompleted") }] }];
    }
    if (subagent.status === "dormant") {
        return [{ id: `preview-${subagent.id}-dorm`, role: "assistant", ts, done: true, blocks: [{ type: "text", text: t("chat.previewDormant") }] }];
    }
    return [];
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
    const [tail, setTail] = useState<Entry[] | null>(null);
    const [loading, setLoading] = useState(false);
    const badge = subagent ? (SUB_BADGE[subagent.status] ?? { tone: "default" as const, key: subagent.status }) : null;

    useEffect(() => {
        if (!open || !subagent) return;
        setTail(null);
        setLoading(true);
        const target = subagent.name ?? subagent.id;
        void runCommand(chatCommands.readSubagent(session.sessionId, target))
            .then((response) => {
                const raw = response as Record<string, unknown>;
                const entries = Array.isArray(raw.entries)
                    ? raw.entries
                    : Array.isArray(raw.messages)
                      ? raw.messages
                      : [];
                if (entries.length) setTail(projectEntries(entries));
                else setTail(statusTail(subagent, t));
            })
            .catch(() => {
                if (subagent) setTail(statusTail(subagent, t));
            })
            .finally(() => setLoading(false));
    }, [open, session.sessionId, subagent, t]);

    const feed = useMemo(() => {
        if (!subagent) return [];
        if (tail && tail.length) return tail;
        return [
            {
                id: `preview-${subagent.id}-task`,
                role: "user" as const,
                ts: subagent.createdAt ?? Date.now(),
                done: true,
                blocks: [{ type: "text" as const, text: subagent.task ?? t("chat.task") }],
            },
            ...statusTail(subagent, t),
        ];
    }, [subagent, t, tail]);

    const children = subagent ? flattenSubagents(subagent.children) : [];

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
                        ) : (
                            feed.map((entry) => <EntryBlock key={entry.id} entry={entry} />)
                        )}
                    </div>
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

function fakePid(task: TaskItem): number {
    let hash = 0;
    for (const char of task.id) hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
    return 10_000 + (hash % 8_000);
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
    const [output, setOutput] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!open || !task) return;
        setOutput(null);
        setLoading(true);
        void runCommand(chatCommands.taskOutput(session.sessionId, task.id))
            .then((response) => {
                const record = response as Record<string, unknown>;
                const text =
                    typeof record.output === "string"
                        ? record.output
                        : typeof record.text === "string"
                          ? record.text
                          : typeof record.data === "string"
                            ? record.data
                            : null;
                setOutput(text);
            })
            .catch(() => setOutput(null))
            .finally(() => setLoading(false));
    }, [open, session.sessionId, task]);

    if (!task) return null;
    const running = task.status === "running";
    const duration = running ? Date.now() - task.startTime : (task.durationMs ?? 0);

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
                <pre className="mono tool__pre">{loading ? t("chat.loading") : (output ?? t("chat.noOutput"))}</pre>
                {task.outputFile ? <div className="muted mono truncate">{task.outputFile}</div> : null}
                <div>
                    <KV label="pid" mono>
                        {fakePid(task)}
                    </KV>
                    <KV label={t("chat.status")}>
                        <span className="row">
                            <span className={`dot ${running ? "dot--busy" : task.status === "completed" ? "dot--ok" : task.status === "failed" ? "dot--err" : "dot--idle"}`} />
                            {t(`state.${task.status}`)}
                        </span>
                    </KV>
                    <KV label={t("chat.duration")}>{formatDuration(duration)}</KV>
                    <KV label="exit code" mono>
                        {task.exitCode == null ? "—" : task.exitCode}
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
