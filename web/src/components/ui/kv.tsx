import * as React from "react";

import { cn } from "@/lib/utils";

export interface KVProps {
    label: React.ReactNode;
    children?: React.ReactNode;
    /** Render the value with the mono font. */
    mono?: boolean;
    className?: string;
    valueClassName?: string;
}

/** Key/value row from base.css (`.kv > k + v`); rendered with spans for valid JSX. */
export function KV({ label, children, mono, className, valueClassName }: KVProps) {
    return (
        <div className={cn("kv", className)}>
            <span className="kv-key">{label}</span>
            <span className={cn("kv-val", mono && "mono", valueClassName)}>{children}</span>
        </div>
    );
}

export function KVList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("kv-list", className)} {...props} />;
}
