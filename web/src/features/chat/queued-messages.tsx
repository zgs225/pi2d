import type { QueueItem } from "@protocol/types";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Pending ("queued") prompt entity.
 *
 * The message stream is the only place a pending prompt is rendered as text —
 * the composer keeps a status line only (no body, no second delete entry). The
 * daemon exposes the queue as `session.queue: QueueItem[]` (a `queue_update`
 * projection), which is *not* part of `entries`: there is no `ts` and no
 * "sending" state, so `sending` (the optimistic prompt pi2d tracks locally) is
 * folded in here as one more queued variant instead of living in the composer.
 */

export interface QueuedMessageActions {
    /** Recall to edit: drop the queue entry and refill the composer. */
    onRecallQueued?: (id: string) => void;
    onRemoveQueued?: (id: string) => void;
    /**
     * `queue.setSteer {mode}` is **session-wide**: the plugin flips every
     * pending message at once. Never render this as a per-message toggle.
     */
    onSetSteerAll?: (steer: boolean) => void;
}

export interface QueuedMessageProps extends QueuedMessageActions {
    item: QueueItem;
    /** Optimistic, locally tracked prompt that was already handed to the plugin. */
    sending?: boolean;
    /** Session-wide steer mode (`every queued item has steer`). */
    steerAll?: boolean;
}

/** One `.msg--user.msg--queued` entity plus its `.msg__queue-foot` actions. */
export function QueuedMessage({
    item,
    sending = false,
    steerAll = false,
    onRecallQueued,
    onRemoveQueued,
    onSetSteerAll,
}: QueuedMessageProps) {
    const { t } = useTranslation();
    const inline = item.steer;
    return (
        <article className="msg msg--user msg--queued" data-queue-id={item.id} data-sending={sending ? "true" : undefined}>
            <div className="msg__meta">
                <span className="who who--user">{t("chat.you")}</span>
                {sending ? <span className="muted msg__time">{t("chat.sending")}</span> : null}
            </div>
            <div className="msg__text">{item.text}</div>
            <div className="msg__queue-foot">
                <span className={cn("msg__queue-state", inline && "is-inline")}>
                    <Icon name={inline ? "zap" : "clock"} size={12} />
                    <span>{t("chat.queuePending")}</span>
                    <span className="tsep">·</span>
                    <span>{inline ? t("chat.queueInline") : t("chat.queueAfterTurn")}</span>
                    {steerAll && !sending ? (
                        <>
                            <span className="tsep">·</span>
                            <span className="msg__queue-scope">{t("chat.queueSteerScope")}</span>
                        </>
                    ) : null}
                </span>
                <span className="spacer" />
                {onRecallQueued && !sending ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="msg__queue-btn"
                        data-queue-action="recall"
                        onClick={() => onRecallQueued(item.id)}
                    >
                        {t("chat.queueRecall")}
                    </Button>
                ) : null}
                {onSetSteerAll && !sending ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        className={cn("msg__queue-btn", steerAll && "is-active")}
                        aria-pressed={steerAll}
                        title={t("chat.queueSteerAll")}
                        data-queue-action="steer"
                        onClick={() => onSetSteerAll(!steerAll)}
                    >
                        {t("chat.queueInline")}
                    </Button>
                ) : null}
                {onRemoveQueued && !sending ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        className="msg__queue-btn is-danger"
                        aria-label={t("chat.removeQueued")}
                        title={t("chat.removeQueued")}
                        data-queue-action="remove"
                        onClick={() => onRemoveQueued(item.id)}
                    >
                        <Icon name="x" size={12} />
                    </Button>
                ) : null}
            </div>
        </article>
    );
}
