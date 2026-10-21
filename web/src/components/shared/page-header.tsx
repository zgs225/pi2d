import * as React from "react";
import { useEffect } from "react";

import { cn } from "@/lib/utils";

export interface PageHeaderProps {
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    /** Right-hand actions (buttons, links). */
    actions?: React.ReactNode;
    /** Optional extra row under the subtitle. */
    children?: React.ReactNode;
    size?: "default" | "lg";
    /** Title used for `document.title` when `title` is not a plain string. */
    docTitle?: string;
    className?: string;
}

/**
 * Shared page header from workspaces.html/status.html:
 * h1 + muted subtitle, actions on the right (wrapping under <600px).
 */
export function PageHeader({ title, subtitle, actions, children, size = "default", docTitle, className }: PageHeaderProps) {
    useEffect(() => {
        if (typeof document === "undefined") return;
        const label = docTitle ?? (typeof title === "string" ? title : "");
        document.title = label ? `${label} — pi2.nvim` : "pi2.nvim";
    }, [docTitle, title]);

    return (
        <header className={cn("page-head", size === "lg" && "page-head--lg", className)}>
            <div className="page-head__text">
                <h1 className="page-head__title">{title}</h1>
                {subtitle ? <p className="page-head__sub">{subtitle}</p> : null}
                {children}
            </div>
            {actions ? <div className="page-head__actions">{actions}</div> : null}
        </header>
    );
}
