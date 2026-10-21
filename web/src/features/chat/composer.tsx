import type { ModelRef, SessionState, ThinkingLevel } from "@protocol/types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { Modal } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { promptImage, type PromptImage } from "./commands";
import type { ModelGroup } from "./data";
import { withCurrentModel } from "./data";
import { THINKING_LEVELS } from "./format";
import type { Attachment } from "./store";

export interface ComposerProps {
    session: SessionState | null;
    models: ModelGroup[];
    connected: boolean;
    paired?: boolean;
    sending?: { text: string } | null;
    onSend: (text: string, images: PromptImage[]) => void;
    onAbort: () => void;
    onRemoveQueue: (id: string) => void;
    onSetSteer: (id: string, steer: boolean) => void;
    onSetModel: (model: ModelRef) => void;
    onSetThinking: (level: ThinkingLevel) => void;
    disabled?: boolean;
    className?: string;
}

function attachmentId(file: File): string {
    return `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Bottom composer: auto-growing textarea, queue chips, model/thinking, send/abort. */
export function Composer({
    session,
    models,
    connected,
    paired = true,
    sending,
    onSend,
    onAbort,
    onRemoveQueue,
    onSetSteer,
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

    function submit() {
        const trimmed = text.trim();
        if (!trimmed || !enabled) return;
        const images = attachments.map(({ mimeType, data }) => ({ mimeType, data }));
        setText("");
        setAttachments([]);
        onSend(trimmed, images);
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
            {queue.length || sending ? (
                <div className="composer__queue">
                    {sending ? (
                        <Chip className="chip--queue chip--sending">
                            <Icon name="clock" />
                            <span>{t("chat.sending")}</span>
                            {sending.text ? <span className="truncate">{sending.text}</span> : null}
                        </Chip>
                    ) : null}
                    {queue.map((item) => (
                        <Chip key={item.id} className="chip--queue">
                            <Icon name="clock" />
                            <span>{t("state.queued")}</span>
                            <span className="truncate" title={item.text}>
                                {item.text}
                            </span>
                            <label className="q-steer-wrap">
                                <input
                                    type="checkbox"
                                    className="q-steer"
                                    checked={item.steer}
                                    aria-label={t("chat.steer")}
                                    onChange={(event) => onSetSteer(item.id, event.target.checked)}
                                />
                                <span>{t("chat.steer")}</span>
                            </label>
                            <button
                                type="button"
                                className="icon-btn"
                                title={t("chat.removeQueued")}
                                aria-label={t("chat.removeQueued")}
                                onClick={() => onRemoveQueue(item.id)}
                            >
                                <Icon name="x" />
                            </button>
                        </Chip>
                    ))}
                </div>
            ) : null}

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
                    {busy ? (
                        <Button
                            variant="danger"
                            className="composer__send"
                            title={t("chat.abortTitle")}
                            disabled={!connected}
                            onClick={onAbort}
                        >
                            <Icon name="stop" />
                            {t("chat.abort")}
                        </Button>
                    ) : (
                        <Button
                            variant="primary"
                            className="composer__send"
                            title={t("chat.sendTitle")}
                            disabled={!enabled || !text.trim()}
                            onClick={submit}
                        >
                            <Icon name="send" />
                            {t("chat.send")}
                        </Button>
                    )}
                </div>
            </div>
            {hint ? (
                <div className="composer__hint" role="status">
                    <Icon name="alert" />
                    {hint}
                </div>
            ) : null}

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
                        <div className="muted">{t("chat.dropNote")}</div>
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
                    <div className="muted composer__note">{t("chat.attachNote")}</div>
                </div>
            </Modal>
        </div>
    );
}
