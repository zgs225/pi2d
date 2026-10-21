import type { AttentionItem, SessionState } from "@protocol/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { diffFilesFromPayload } from "./diff";
import { DiffView } from "./diff-view";

export interface AttentionDialogProps {
    session: SessionState;
    onRespond: (item: AttentionItem, response: unknown) => void;
    /** Fired when the request vanished because another client answered it. */
    onRemoteResolved: (requestId: string) => void;
}

function diffResponse(result: "Accepted" | "Rejected", path?: string): string {
    return JSON.stringify({ result, ...(path ? { path } : {}) });
}

/**
 * Blocking extension attention request.
 *
 * One dialog per session: title/options/countdown, or the pre-execution diff
 * review variant. A request resolved by another client disappears from
 * `session.attention` (reducer) and we close immediately + toast.
 */
export function AttentionDialog({ session, onRespond, onRemoteResolved }: AttentionDialogProps) {
    const { t } = useTranslation();
    const [current, setCurrent] = useState<AttentionItem | null>(null);
    const [remaining, setRemaining] = useState<number | null>(null);
    const responded = useRef(false);
    const dismissed = useRef<string | null>(null);
    const timedOut = useRef<Set<string>>(new Set());

    useEffect(() => {
        const next = session.attention[0] ?? null;
        if (next && dismissed.current === next.requestId) return;
        if (next) {
            if (!current || current.requestId !== next.requestId) {
                responded.current = false;
                setCurrent(next);
            }
            return;
        }
        if (current) {
            if (!responded.current) onRemoteResolved(current.requestId);
            responded.current = false;
            dismissed.current = null;
            setCurrent(null);
        }
    }, [session.attention, current, onRemoteResolved]);

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
            if (left <= 0 && !timedOut.current.has(item.requestId)) {
                timedOut.current.add(item.requestId);
                responded.current = true;
                dismissed.current = item.requestId;
                setCurrent(null);
                toast.error(t("chat.attentionTimedOut"));
            }
        };
        tick();
        const timer = setInterval(tick, 500);
        return () => clearInterval(timer);
    }, [current, t]);

    const files = useMemo(() => diffFilesFromPayload(current?.payload), [current]);
    const isDiff = current?.method === "diff" || files.length > 0;

    function respond(response: unknown, message: string, kind: "success" | "error" | "info" = "success") {
        if (!current) return;
        responded.current = true;
        onRespond(current, response);
        if (kind === "error") toast.error(message);
        else if (kind === "info") toast.info(message);
        else toast.success(message);
    }

    const options = current?.options?.length
        ? current.options
        : current?.method === "confirm"
          ? [
                { id: "confirm", label: t("chat.allowOnce") },
                { id: "deny", label: t("chat.deny") },
            ]
          : [
                { id: "allow-once", label: t("chat.allowOnce") },
                { id: "always", label: t("chat.always") },
                { id: "deny", label: t("chat.deny") },
            ];

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
                                            diffResponse(decision === "accept" ? "Accepted" : "Rejected", path),
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
                                    onClick={() => {
                                        const ok = option.id !== "deny";
                                        respond(
                                            option.id,
                                            option.id === "deny"
                                                ? t("chat.denied")
                                                : option.id === "always"
                                                  ? t("chat.alwaysAllowed")
                                                  : t("chat.allowedOnce"),
                                            ok ? "success" : "error",
                                        );
                                    }}
                                >
                                    {option.label}
                                </Button>
                            ))}
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
