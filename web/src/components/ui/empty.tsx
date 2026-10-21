import * as React from "react";

import { cn } from "@/lib/utils";

export interface EmptyProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
    icon?: React.ReactNode;
    title?: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
}

export function Empty({ icon, title, description, action, className, children, ...props }: EmptyProps) {
    return (
        <div className={cn("empty", className)} {...props}>
            {icon}
            {title ? <div className="t">{title}</div> : null}
            {description ? <p className="muted">{description}</p> : null}
            {children}
            {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
        </div>
    );
}
