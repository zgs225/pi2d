import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/**
 * Open-dialog stack. Every mounted modal pushes its id and the capture-phase
 * Escape listener only acts on the topmost entry, so a stacked dialog (or the
 * command palette above it) closes exactly one layer per Escape.
 */
const modalStack: string[] = [];

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
    /** Element that receives focus when the dialog closes (the trigger). */
    returnFocusTo?: React.RefObject<HTMLElement | null>;
}

/**
 * Radix dialog styled as `base.css .modal-backdrop > .modal`:
 * `aria-labelledby`, initial focus on the title-bar close button, a Tab trap
 * (Radix FocusScope), capture-phase Escape for the topmost layer only, and
 * focus returned to the trigger. <600px it becomes a bottom sheet.
 */
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
    returnFocusTo,
}: ModalProps) {
    const { t } = useTranslation();
    const contentRef = React.useRef<HTMLDivElement>(null);
    const closeRef = React.useRef<HTMLButtonElement>(null);
    const titleId = React.useId();
    const onOpenChangeRef = React.useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;

    React.useEffect(() => {
        if (!open) return;
        const entry = titleId;
        modalStack.push(entry);
        const onKeyDownCapture = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            if (modalStack[modalStack.length - 1] !== entry) return;
            const content = contentRef.current;
            const active = document.activeElement;
            // Another overlay owns the focus (command palette): leave Escape to it.
            if (content && active && !content.contains(active) && active !== document.body) return;
            event.preventDefault();
            event.stopPropagation();
            onOpenChangeRef.current(false);
        };
        document.addEventListener("keydown", onKeyDownCapture, true);
        return () => {
            document.removeEventListener("keydown", onKeyDownCapture, true);
            const index = modalStack.lastIndexOf(entry);
            if (index !== -1) modalStack.splice(index, 1);
        };
    }, [open, titleId]);

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
                        ref={contentRef}
                        aria-labelledby={titleId}
                        className={cn("modal", "modal-content", size === "wide" && "modal--wide", contentClassName)}
                        onOpenAutoFocus={(event) => {
                            // Prototype parity: first focusable is the title-bar close button.
                            event.preventDefault();
                            closeRef.current?.focus();
                        }}
                        onCloseAutoFocus={(event) => {
                            if (!returnFocusTo?.current) return;
                            event.preventDefault();
                            returnFocusTo.current.focus();
                        }}
                    >
                        <DialogPrimitive.Title asChild>
                            <h3 id={titleId}>
                                <span>{title}</span>
                                <DialogPrimitive.Close asChild>
                                    <button
                                        ref={closeRef}
                                        type="button"
                                        className="icon-btn"
                                        aria-label={t("common.close")}
                                    >
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
