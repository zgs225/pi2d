import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { ApiError, errorI18nKey } from "@/lib/api";

import { ensureInstance, InstanceStartError } from "./commands";

export interface NewWorkspaceInput {
    cwd: string;
    name?: string;
}

export interface NewWorkspaceDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (input: NewWorkspaceInput) => Promise<void>;
    /** Runs after a successful retry of `instance.ensure`; the page finishes the open. */
    onRetryOpen?: (workspaceId: string) => void | Promise<void>;
}

/** Longest daemon message echoed back: they are debug strings, not UI copy. */
const MAX_DETAIL = 200;

/**
 * A path the daemon accepts as typed: absolute, or `~` / `~/…` (it expands the
 * home directory itself — `~user/…` is deliberately the daemon's call, not ours).
 */
export function isAbsoluteOrHomePath(value: string): boolean {
    const trimmed = value.trim();
    return trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/");
}

/** Shorten a daemon message; never echo a JSON blob back at the user. */
export function humanDetail(message: string | undefined): string | undefined {
    const text = message?.trim();
    if (!text) return undefined;
    if (text.startsWith("{") || text.startsWith("[")) return undefined;
    return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

interface FailureText {
    message: string;
    /** Extra daemon text, rendered monospace and wrapped. */
    detail?: string;
    /** The message itself embeds a reason, so it needs the monospace/wrap treatment. */
    reasonStyle?: boolean;
}

function reasonFrom(error: ApiError): string | undefined {
    const fromDetails = error.details?.["reason"];
    const raw = typeof fromDetails === "string" ? fromDetails : error.message;
    return humanDetail(raw);
}

/**
 * Turn an open failure into something specific: code → status → daemon message.
 * The user must learn *why* nothing happened, not read `E_FORBIDDEN`.
 */
export function describeOpenFailure(error: unknown, t: TFunction): FailureText {
    if (!(error instanceof ApiError)) {
        const detail = humanDetail(error instanceof Error ? error.message : undefined);
        return { message: t("workspaces.addFailed"), ...(detail ? { detail } : {}) };
    }

    const message = error.message ?? "";
    const lower = message.toLowerCase();

    if (error.status === 404 || error.code === "E_NOT_FOUND") {
        return { message: t("workspaces.errNotFound") };
    }

    if (error.status === 403 || error.code === "E_FORBIDDEN") {
        if (lower.includes("root")) return { message: t("workspaces.errOutsideRoots") };
        if (lower.includes("readable") || lower.includes("writable") || lower.includes("access")) {
            return { message: t("workspaces.errPermission") };
        }
        return { message: t(errorI18nKey(error.code)) };
    }

    if (error.status === 400 || error.code === "E_BAD_REQUEST") {
        if (lower.includes("absolute") || lower.includes("~")) return { message: t("workspaces.errNotAbsolute") };
        return { message: t("workspaces.errBadPath") };
    }

    if (error.code === "E_INSTANCE_STARTING" || error.code === "E_INSTANCE_UNAVAILABLE") {
        const reason = reasonFrom(error) ?? t("workspaces.errInstanceUnknown");
        return { message: t("workspaces.errInstanceFailed", { reason }), reasonStyle: true };
    }

    const detail = humanDetail(message);
    return { message: t(errorI18nKey(error.code)), ...(detail ? { detail } : {}) };
}

/**
 * Path is required, display name optional; validation is inline, not a toast.
 * A failed open keeps the dialog open with the concrete reason, and a failure
 * that happened after `workspace.add` offers a retry of `instance.ensure` only.
 */
export function NewWorkspaceDialog({ open, onOpenChange, onCreate, onRetryOpen }: NewWorkspaceDialogProps) {
    const { t } = useTranslation();
    const [cwd, setCwd] = useState("");
    const [name, setName] = useState("");
    const [pathError, setPathError] = useState<string | null>(null);
    const [failure, setFailure] = useState<FailureText | null>(null);
    const [retryId, setRetryId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setCwd("");
        setName("");
        setPathError(null);
        setFailure(null);
        setRetryId(null);
        setBusy(false);
    }, [open]);

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        const trimmed = cwd.trim();
        if (!trimmed) {
            setPathError(t("workspaces.pathRequired"));
            setFailure(null);
            return;
        }
        if (!isAbsoluteOrHomePath(trimmed)) {
            setPathError(t("workspaces.errNotAbsolute"));
            setFailure(null);
            return;
        }
        setPathError(null);
        setFailure(null);
        setRetryId(null);
        setBusy(true);
        try {
            await onCreate({ cwd: trimmed, ...(name.trim() ? { name: name.trim() } : {}) });
            onOpenChange(false);
        } catch (error) {
            if (error instanceof InstanceStartError) {
                setRetryId(error.workspaceId);
                setFailure(describeOpenFailure(error.detail, t));
            } else {
                setFailure(describeOpenFailure(error, t));
            }
        } finally {
            setBusy(false);
        }
    }

    /** Re-run only `instance.ensure` for the workspace that was already created. */
    async function retry() {
        if (!retryId || busy) return;
        setBusy(true);
        setFailure(null);
        try {
            await ensureInstance(retryId);
            await onRetryOpen?.(retryId);
            onOpenChange(false);
        } catch (error) {
            setFailure(describeOpenFailure(error, t));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            title={t("workspaces.newTitle")}
            footer={
                <>
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                        {t("common.cancel")}
                    </Button>
                    {retryId ? (
                        <Button variant="ghost" onClick={() => void retry()} disabled={busy} data-testid="workspace-retry-instance">
                            {t("workspaces.retry")}
                        </Button>
                    ) : null}
                    <Button variant="primary" type="submit" form="new-workspace-form" disabled={busy}>
                        {busy ? t("workspaces.creating") : t("common.open")}
                    </Button>
                </>
            }
        >
            <form id="new-workspace-form" className="ws-form" noValidate onSubmit={(event) => void submit(event)}>
                <Field label={t("workspaces.path")} htmlFor="new-workspace-path" hint={t("workspaces.pathHint")} error={pathError}>
                    <Input
                        id="new-workspace-path"
                        autoFocus
                        autoComplete="off"
                        placeholder="~/Workspace/Misc/my-project"
                        aria-label={t("workspaces.cwdAria")}
                        value={cwd}
                        onChange={(event) => {
                            setCwd(event.target.value);
                            if (pathError) setPathError(null);
                        }}
                    />
                </Field>
                <Field label={t("workspaces.displayName")} htmlFor="new-workspace-name" hint={t("workspaces.nameHint")}>
                    <Input
                        id="new-workspace-name"
                        autoComplete="off"
                        placeholder={t("workspaces.defaultNamePlaceholder")}
                        aria-label={t("workspaces.displayName")}
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                </Field>
                <div className="ws-modal-example mono" aria-hidden="true">
                    ~/Workspace/Misc/my-project
                </div>
                {failure ? (
                    <div
                        className={failure.reasonStyle ? "ws-form__error ws-form__error--reason" : "ws-form__error"}
                        role="alert"
                        data-testid="workspace-form-error"
                    >
                        <Icon name="alert" />
                        <span className="ws-form__message">{failure.message}</span>
                        {failure.detail ? (
                            <span className="ws-form__detail mono" title={failure.detail}>
                                {failure.detail}
                            </span>
                        ) : null}
                    </div>
                ) : null}
            </form>
        </Modal>
    );
}
