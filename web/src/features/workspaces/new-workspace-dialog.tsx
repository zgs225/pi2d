import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { ApiError, errorI18nKey } from "@/lib/api";

export interface NewWorkspaceInput {
    cwd: string;
    name?: string;
}

export interface NewWorkspaceDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (input: NewWorkspaceInput) => Promise<void>;
}

/** Path is required, display name optional; validation is inline, not a toast. */
export function NewWorkspaceDialog({ open, onOpenChange, onCreate }: NewWorkspaceDialogProps) {
    const { t } = useTranslation();
    const [cwd, setCwd] = useState("");
    const [name, setName] = useState("");
    const [pathError, setPathError] = useState<string | null>(null);
    const [formError, setFormError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setCwd("");
        setName("");
        setPathError(null);
        setFormError(null);
        setBusy(false);
    }, [open]);

    async function submit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (busy) return;
        const trimmed = cwd.trim();
        if (!trimmed) {
            setPathError(t("workspaces.pathRequired"));
            setFormError(null);
            return;
        }
        setPathError(null);
        setFormError(null);
        setBusy(true);
        try {
            await onCreate({ cwd: trimmed, ...(name.trim() ? { name: name.trim() } : {}) });
            onOpenChange(false);
        } catch (error) {
            const key = error instanceof ApiError ? errorI18nKey(error.code) : "workspaces.addFailed";
            setFormError(t(key));
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
                {formError ? (
                    <div className="ws-form__error" role="alert">
                        <Icon name="alert" />
                        <span>{formError}</span>
                    </div>
                ) : null}
            </form>
        </Modal>
    );
}
