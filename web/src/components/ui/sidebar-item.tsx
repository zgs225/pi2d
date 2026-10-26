import { Slot } from "@radix-ui/react-slot";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface SidebarItemProps extends React.HTMLAttributes<HTMLElement> {
    active?: boolean;
    /**
     * Icon-only compact row (sidebar / rail): 44×44 hit area, 20px icon, and a
     * pure-CSS `.has-tip[data-tip]` tooltip instead of a text label.
     */
    compact?: boolean;
    /** Tooltip text; also becomes the accessible name in compact mode. */
    tip?: string;
    asChild?: boolean;
}

/**
 * Sidebar / rail navigation row. Compose the link or button as a child
 * (`asChild`) so router links keep their own props and prefetching.
 */
export function SidebarItem({
    active = false,
    compact = false,
    tip,
    asChild = false,
    className,
    children,
    ...props
}: SidebarItemProps) {
    const Comp = asChild ? Slot : "a";
    return (
        <Comp
            className={cn("nav-item", compact && "has-tip", active && "active", className)}
            aria-current={active ? "page" : undefined}
            aria-label={compact ? tip : undefined}
            data-tip={compact ? tip : undefined}
            {...props}
        >
            {children}
        </Comp>
    );
}
