import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

export const badgeVariants = cva("badge", {
    variants: {
        tone: {
            default: "",
            ok: "badge--ok",
            warn: "badge--warn",
            err: "badge--err",
            info: "badge--info",
        },
    },
    defaultVariants: {
        tone: "default",
    },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
    return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
