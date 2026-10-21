import type { AttentionItem, SessionState } from "@protocol/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
    cancelResponse,
    confirmResponse,
    diffAnswer,
    selectResponse,
    type AttentionResponse,
} from "./commands";
import { diffFilesFromPayload } from "./diff";
import { DiffView } from "./diff-view";

export interface AttentionDialogProps {
    session: SessionState;
    onRespond: (item: AttentionItem, response: AttentionResponse | string) => void;
    /** Fired when the request vanished because another client answered it. */
    onRemoteResolved: (requestId: string) => void;
}

/**
 * Blocking extension attention request.
 *
 * One dialog per session: title/options/countdown from the server (nothing is
 * invented locally), or the pre-execution diff review variant. The dialog closes
 * when the plugin resolves the request — our own answer
 * (`pi2:attention_resolved` echoes the winner), another client's answer, or the
 * timeout it advertises.
 */
export function AttentionDialog({ session, onRespond, onRemoteResolved }: AttentionDialogProps) {
    const { t } = useTranslation();
    const [current, setCurrent] = useState<AttentionItem | null>(null);
    const [remaining, setRemaining] = useState<number | null>(null);
    /** Answered here, waiting for the plugin to confirm. */
    const answered = useRef(false);
    /** Timed out locally: the plugin cancels it too, so never show it again. */
    const settled = useRef<Set<string>>(new Set());
    /** The request currently on screen, to report a remote resolution once. */
    const shown = useRef<string | null>(null);

    useEffect(() => {
        const next = session.attention.find((item) => !settled.current.has(item.requestId)) ?? null;
        if (!next) {
            // `pi2:attention_resolved` (or a cancelled request) removed it.
            if (shown.current !== null && !answered.current) onRemoteResolved(shown.current);
            shown.current = null;
            answered.current = false;
            setCurrent(null);
            return;
        }
        if (shown.current !== next.requestId) {
            shown.current = next.requestId;
            answered.current = false;
        }
        setCurrent(next);
    }, [session.attention, onRemoteResolved]);

    useEffect(() => {
        const timeoutSec = current?.timeoutSec;
        if (!current || !timeoutSec) {
            setRemaining(null);
            return;
        }
        const item = current;
        const deadline = item.receivedAt + timeoutSec * 1_000;
        const tick = () => {
            const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
            setRemaining(left);
            if (left > 0 || settled.current.has(item.requestId)) return;
            settled.current.add(item.requestId);
            shown.current = null;
            answered.current = false;
            setCurrent(null);
            toast.error(t("chat.attentionTimedOut"));
        };
        tick();
        const timer = setInterval(tick, 500);
        return () => clearInterval(timer);
    }, [current, t]);

    const files = useMemo(() => diffFilesFromPayload(current?.payload), [current]);
    const isDiff = current?.method === "diff" || files.length > 0;

    /** Answer, optionally with a confirmation toast (diff decisions). */
    function respond(answer: AttentionResponse, message?: string, kind: "success" | "error" = "success") {
        if (!current) return;
        answered.current = true;
        onRespond(current, answer);
        if (!message) return;
        if (kind === "error") toast.error(message);
        else toast.success(message);
    }

    // `confirm` has no server-side option list; the plugin expects
    // `{confirmed}` and expresses a dismissal as `{cancelled}`.
    const confirmMode = current?.method === "confirm" && !current.options?.length;
    const options = current?.options?.length
        ? current.options
        : confirmMode
          ? [
                { id: "confirm", label: t("common.confirm") },
                { id: "cancel", label: t("common.cancel") },
            ]
          : [];

    function choose(id: string) {
        if (confirmMode) {
            respond(id === "confirm" ? confirmResponse(true) : cancelResponse());
            return;
        }
        respond(selectResponse(id));
    }

    return (
        <Modal
            open={Boolean(current)}
            onOpenChange={() => {
                /* blocking: answer (or let it time out) before closing */
            }}
            title={current?.title ?? t("chat.attentionTitle")}
        >
            {current ? (
                <div className="attn">
                    {current.message ? <p className="attn__q">{current.message}</p> : null}
                    {isDiff ? (
                        <>
                            <div className="muted">{t("chat.diffReview")}</div>
                            {files.length ? (
                                <DiffView
                                    files={files}
                                    onDecision={(decision, path) =>
                                        respond(
                                            diffAnswer(
                                                decision === "accept" ? "Accepted" : "Rejected",
                                                path,
                                            ),
                                            decision === "accept"
                                                ? t("chat.acceptedAll", { n: files.length })
                                                : t("chat.rejected", { path: path ?? "" }),
                                            decision === "accept" ? "success" : "error",
                                        )
                                    }
                                />
                            ) : (
                                <div className="muted">{t("chat.noChanges")}</div>
                            )}
                        </>
                    ) : (
                        <div className="attn__options">
                            {options.map((option, index) => (
                                <Button
                                    key={option.id}
                                    variant={index === 0 ? "primary" : option.id === "deny" ? "danger" : "ghost"}
                                    data-option-id={option.id}
                                    onClick={() => choose(option.id)}
                                >
                                    {option.label}
                                </Button>
                            ))}
                            {options.length ? null : (
                                <Button
                                    variant="ghost"
                                    data-option-id="cancel"
                                    onClick={() => respond(cancelResponse())}
                                >
                                    {t("common.cancel")}
                                </Button>
                            )}
                        </div>
                    )}
                    {current.timeoutSec ? (
                        <>
                            <Progress
                                value={remaining ?? current.timeoutSec}
                                max={current.timeoutSec}
                                tone="warn"
                            />
                            <div className="row attn__meta">
                                <span className="muted">{t("chat.attentionTimeout")}</span>
                                <span className={cn("mono", remaining !== null && remaining <= 5 && "attn__countdown--urgent")}>
                                    {remaining ?? current.timeoutSec}s
                                </span>
                                <div className="spacer" />
                                <Badge tone="warn">{current.method}</Badge>
                            </div>
                        </>
                    ) : (
                        <div className="row attn__meta">
                            <div className="spacer" />
                            <Badge tone="warn">{current.method}</Badge>
                        </div>
                    )}
                </div>
            ) : null}
        </Modal>
    );
}
