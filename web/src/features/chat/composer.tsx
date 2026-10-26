import type { ModelRef, SessionState, ThinkingLevel } from "@protocol/types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { plural } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import "@/styles/pages/chat-composer.css";
import { promptImage, type PromptImage, type PromptMode } from "./commands";
import type { ModelGroup } from "./data";
import { withCurrentModel } from "./data";
import { THINKING_LEVELS } from "./format";
import type { Attachment } from "./store";

export interface ComposerProps {
    session: SessionState | null;
    models: ModelGroup[];
    connected: boolean;
    paired?: boolean;
    /**
     * The optimistic first message of a send. The composer never renders its body
     * any more (CHG-2026-10-26-16): it only adds to the pending count while the
     * daemon has not projected the message into `session.queue` yet.
     */
    sending?: { text: string } | null;
    /** `mode` is `follow_up` when the run is busy (queued) and `steer` for an interrupt. */
    onSend: (text: string, images: PromptImage[], mode?: PromptMode) => void;
    onAbort: () => void;
    onRemoveQueue: (id: string) => void;
    /**
     * Kept for signature compatibility (`pages/chat.tsx` still passes it). Steering
     * is a session-wide mode (`queue.setSteer {mode}`), so the composer renders no
     * per-message toggle any more — the queued footer in the stream owns it.
     */
    onSetSteer: (steer: boolean) => void;
    /** Session-level bulk clear for the status bar; falls back to `onRemoveQueue`. */
    onClearQueue?: () => void;
    /** Authoritative pending count (e.g. including an in-stream queued entity). */
    queuedCount?: number;
    onSetModel: (model: ModelRef) => void;
    onSetThinking: (level: ThinkingLevel) => void;
    disabled?: boolean;
    className?: string;
}

function attachmentId(file: File): string {
    return `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Bottom composer: auto-growing textarea, a `role="status"` pending bar (no queue
 * bodies), model/thinking pickers and one circular send slot that turns into abort.
 */
export function Composer({
    session,
    models,
    connected,
    paired = true,
    sending,
    onSend,
    onAbort,
    onRemoveQueue,
    onClearQueue,
    queuedCount,
    onSetModel,
    onSetThinking,
    disabled = false,
    className,
}: ComposerProps) {
    const { t } = useTranslation();
    const [text, setText] = useState("");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [attachOpen, setAttachOpen] = useState(false);
    const [dragging, setDragging] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);

    const enabled = Boolean(session) && connected && !disabled;
    const busy = session ? session.status === "busy" || session.status === "compacting" : false;
    const queue = session?.queue ?? [];
    const model = session?.model ?? null;
    const thinking = session?.thinking ?? "off";
    const groups = withCurrentModel(models, model);
    const hint = !paired ? t("chat.unpairedHint") : !connected ? t("chat.offlineHint") : null;
    // The stream owns the single queued entity; the composer only counts. `sending`
    // counts once and only until `queue_update` projects the same message.
    const pending = Math.max(queuedCount ?? (queue.length || (sending ? 1 : 0)), 0);
    const inline = queue.filter((item) => item.steer).length;
    const pendingLabel = plural("chat.queueCount", pending, {
        defaultValue: pending === 1 ? "{n} pending message" : "{n} pending messages",
    });
    const hintLabel =
        inline > 0
            ? t("chat.queueCountInline", { n: inline, defaultValue: "{n} inserting now" })
            : t("chat.queueAfterTurn", { defaultValue: "Sends after this turn" });

    useLayoutEffect(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.style.height = "auto";
        const max = 5 * 24;
        element.style.height = `${Math.min(element.scrollHeight, max)}px`;
        element.style.overflowY = element.scrollHeight > max ? "auto" : "hidden";
    }, [text]);

    useEffect(() => {
        if (!enabled) return;
        textareaRef.current?.focus({ preventScroll: true });
    }, [enabled]);

    function submit(mode?: PromptMode) {
        const trimmed = text.trim();
        if (!trimmed || !enabled) return;
        const images = attachments.map(({ mimeType, data }) => ({ mimeType, data }));
        setText("");
        setAttachments([]);
        // A busy session queues the message as a follow-up; idle sends a plain prompt.
        onSend(trimmed, images, mode ?? (busy ? "follow_up" : undefined));
    }

    /**
     * The protocol has no bulk `queue.clear`: `onClearQueue` (one session-level
     * command) wins; the fallback removes the projected items one by one.
     */
    function clearQueue() {
        if (onClearQueue) {
            onClearQueue();
            return;
        }
        for (const item of queue) onRemoveQueue(item.id);
    }

    async function addFiles(files: FileList | File[] | null) {
        if (!files) return;
        for (const file of Array.from(files)) {
            if (!file.type.startsWith("image/")) continue;
            try {
                const image = await promptImage(file);
                setAttachments((current) => [
                    ...current,
                    {
                        id: attachmentId(file),
                        name: file.name,
                        mimeType: image.mimeType,
                        data: image.data,
                        preview: `data:${image.mimeType};base64,${image.data}`,
                    },
                ]);
                toast(t("chat.attachmentAdded", { name: file.name }));
            } catch {
                toast.error(t("chat.attachmentFailed", { name: file.name }));
            }
        }
    }

    return (
        <div className={cn("composer", className)}>
            <div className="composer__inner">
                <div
                    className={cn("composer__queue", pending === 0 && "is-empty")}
                    role="status"
                    aria-live="polite"
                    data-testid="composer-queue"
                >
                    <span className="queue-bar__ico" aria-hidden="true">
                        <Icon name={inline > 0 ? "zap" : "clock"} />
                    </span>
                    <span className="queue-bar__label">{pendingLabel}</span>
                    <span className="tsep" aria-hidden="true">
                        ·
                    </span>
                    <span className="queue-bar__hint">{hintLabel}</span>
                    <div className="spacer" />
                    <button
                        type="button"
                        className="btn btn--sm btn--ghost queue-bar__clear"
                        data-testid="composer-queue-clear"
                        disabled={!enabled || pending === 0}
                        onClick={clearQueue}
                    >
                        {t("chat.queueClear", { defaultValue: "Clear queue" })}
                    </button>
                </div>

                <div className={cn("composer__box", !enabled && "is-disabled")}>
                    {attachments.length ? (
                        <div className="composer__attachments">
                            {attachments.map((attachment) => (
                                <span key={attachment.id} className="composer__att">
                                    <img src={attachment.preview} alt="" className="composer__att-img" />
                                    <span className="truncate">{attachment.name}</span>
                                    <button
                                        type="button"
                                        className="icon-btn"
                                        aria-label={t("chat.removeAttachment")}
                                        title={t("chat.removeAttachment")}
                                        onClick={() =>
                                            setAttachments((current) =>
                                                current.filter((item) => item.id !== attachment.id),
                                            )
                                        }
                                    >
                                        <Icon name="x" />
                                    </button>
                                </span>
                            ))}
                        </div>
                    ) : null}
                    <textarea
                        ref={textareaRef}
                        className="textarea composer__ta"
                        rows={1}
                        value={text}
                        placeholder={t("chat.composerPlaceholder")}
                        aria-label={t("chat.composerAria")}
                        data-testid="composer-input"
                        disabled={!enabled}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                            event.preventDefault();
                            submit();
                        }}
                    />
                    <div className="composer__bar">
                        <button
                            type="button"
                            className="btn btn--icon btn--ghost"
                            title={t("chat.addAttachment")}
                            aria-label={t("chat.addAttachment")}
                            disabled={!enabled}
                            onClick={() => setAttachOpen(true)}
                        >
                            <Icon name="plus" />
                        </button>
                        <select
                            className="select composer__sel"
                            aria-label={t("chat.model")}
                            data-testid="composer-model"
                            value={model ? `${model.provider}/${model.id}` : ""}
                            disabled={!enabled || !groups.length}
                            onChange={(event) => {
                                const slash = event.target.value.indexOf("/");
                                if (slash <= 0) return;
                                onSetModel({
                                    provider: event.target.value.slice(0, slash),
                                    id: event.target.value.slice(slash + 1),
                                });
                            }}
                        >
                            {groups.length ? null : (
                                <option value="">{model ? `${model.provider}/${model.id}` : t("chat.model")}</option>
                            )}
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
                        <select
                            className="select composer__sel"
                            aria-label={t("chat.thinkingAria")}
                            data-testid="composer-thinking"
                            value={thinking}
                            disabled={!enabled}
                            onChange={(event) => onSetThinking(event.target.value as ThinkingLevel)}
                        >
                            {THINKING_LEVELS.map((level) => (
                                <option key={level} value={level}>
                                    {level}
                                </option>
                            ))}
                        </select>
                        <div className="spacer" />
                        {/*
                         * One circular slot: send while idle, abort while busy. The
                         * text label stays screen-reader only so the button keeps a
                         * textContent of `Send` for the Playwright facts.
                         */}
                        <Button
                            variant={busy ? "danger" : "primary"}
                            className={cn("composer__send", busy && "is-busy")}
                            title={busy ? t("chat.abortTitle") : t("chat.sendTitle")}
                            data-testid={busy ? "composer-abort" : "composer-send"}
                            disabled={busy ? !connected : !enabled || !text.trim()}
                            onClick={busy ? onAbort : () => submit()}
                        >
                            <Icon name={busy ? "stop" : "send"} />
                            <span className="visually-hidden">{busy ? t("chat.abort") : t("chat.send")}</span>
                        </Button>
                    </div>
                </div>
                {hint ? (
                    <div className="composer__hint" role="status">
                        <Icon name="alert" />
                        {hint}
                    </div>
                ) : null}
            </div>

            <Modal
                open={attachOpen}
                onOpenChange={setAttachOpen}
                title={t("chat.attachTitle")}
                footer={
                    <Button variant="primary" onClick={() => setAttachOpen(false)}>
                        {t("common.close")}
                    </Button>
                }
            >
                <div className="stack">
                    <div
                        className={cn("drop-zone", dragging && "dragover")}
                        role="button"
                        tabIndex={0}
                        onClick={() => fileRef.current?.click()}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                fileRef.current?.click();
                            }
                        }}
                        onDragOver={(event) => {
                            event.preventDefault();
                            setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(event) => {
                            event.preventDefault();
                            setDragging(false);
                            void addFiles(event.dataTransfer.files);
                        }}
                    >
                        <Icon name="plus" />
                        <div>{t("chat.dropHint")}</div>
                    </div>
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        multiple
                        hidden
                        onChange={(event) => {
                            void addFiles(event.target.files);
                            event.target.value = "";
                        }}
                    />
                    {attachments.length ? (
                        <div className="att-list">
                            {attachments.map((attachment) => (
                                <div className="att-file" key={attachment.id}>
                                    <img src={attachment.preview} alt="" className="att-thumb" />
                                    <span className="grow truncate">{attachment.name}</span>
                                    <button
                                        type="button"
                                        className="icon-btn"
                                        title={t("chat.removeAttachment")}
                                        aria-label={t("chat.removeAttachment")}
                                        onClick={() =>
                                            setAttachments((current) =>
                                                current.filter((item) => item.id !== attachment.id),
                                            )
                                        }
                                    >
                                        <Icon name="x" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : null}
                </div>
            </Modal>
        </div>
    );
}
