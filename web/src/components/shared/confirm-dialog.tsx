import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/dialog";

export interface ConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    description?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onConfirm: () => void | Promise<void>;
}

/** Destructive-action confirmation (base.css modal + two actions). */
export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmLabel,
    cancelLabel,
    danger = true,
    onConfirm,
}: ConfirmDialogProps) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);

    async function confirm() {
        if (busy) return;
        setBusy(true);
        try {
            await onConfirm();
            onOpenChange(false);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            title={title}
            footer={
                <>
                    <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                        {cancelLabel ?? t("common.cancel")}
                    </Button>
                    <Button variant={danger ? "danger" : "primary"} onClick={() => void confirm()} disabled={busy}>
                        {confirmLabel ?? t("common.confirm")}
                    </Button>
                </>
            }
        >
            {description ? <p className="muted">{description}</p> : null}
        </Modal>
    );
}
