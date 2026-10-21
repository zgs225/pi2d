import * as React from "react";

import { cn } from "@/lib/utils";

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { hover?: boolean }>(
    function Card({ className, hover = false, ...props }, ref) {
        return <div ref={ref} className={cn("card", hover && "card--hover", className)} {...props} />;
    },
);

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("card__head", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("card__title", className)} {...props} />;
}

export function CardSub({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("card__sub", className)} {...props} />;
}

export const Panel = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(function Panel(
    { className, ...props },
    ref,
) {
    return <section ref={ref} className={cn("panel", className)} {...props} />;
});

export function PanelHead({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("panel__head", className)} {...props} />;
}

export function PanelBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("panel__body", className)} {...props} />;
}
