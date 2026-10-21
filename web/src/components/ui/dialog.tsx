import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface ModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
    footer?: React.ReactNode;
    /** `wide` is the content overlay (≥60vw) used for subagent conversations. */
    size?: "default" | "wide";
    className?: string;
    contentClassName?: string;
}

/** Radix dialog styled as the base.css `.modal-backdrop > .modal` (bottom sheet <600px). */
export function Modal({
    open,
    onOpenChange,
    title,
    description,
    children,
    footer,
    size = "default",
    className,
    contentClassName,
}: ModalProps) {
    const { t } = useTranslation();
    return (
        <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <DialogPrimitive.Portal>
                {/*
                 * The content is a child of the backdrop: the backdrop is
                 * `position: fixed; z-index: 60`, so a sibling rendered after it
                 * still paints underneath and swallows every pointer event
                 * ("modal-backdrop intercepts pointer events"). Nesting keeps the
                 * flex centering and puts the panel above the scrim.
                 */}
                <DialogPrimitive.Overlay className={cn("modal-backdrop", className)}>
                    <DialogPrimitive.Content
                        className={cn("modal", "modal-content", size === "wide" && "modal--wide", contentClassName)}
                    >
                    <DialogPrimitive.Title asChild>
                        <h3>
                            <span>{title}</span>
                            <DialogPrimitive.Close asChild>
                                <button type="button" className="btn btn--ghost btn--sm" aria-label={t("common.close")}>
                                    <X size={16} aria-hidden="true" />
                                </button>
                            </DialogPrimitive.Close>
                        </h3>
                    </DialogPrimitive.Title>
                    {description ? (
                        <DialogPrimitive.Description className="muted">{description}</DialogPrimitive.Description>
                    ) : null}
                    {children}
                    {footer ? <div className="modal-actions">{footer}</div> : null}
                    </DialogPrimitive.Content>
                </DialogPrimitive.Overlay>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
