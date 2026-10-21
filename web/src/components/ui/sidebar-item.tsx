import { Slot } from "@radix-ui/react-slot";
import * as React from "react";

import { cn } from "@/lib/utils";

export interface SidebarItemProps extends React.HTMLAttributes<HTMLElement> {
    active?: boolean;
    asChild?: boolean;
}

/** Sidebar / rail / tabbar navigation row; compose the link or button as a child. */
export function SidebarItem({ active, asChild = false, className, children, ...props }: SidebarItemProps) {
    const Comp = asChild ? Slot : "a";
    return (
        <Comp className={cn("nav-item", active && "active", className)} aria-current={active ? "page" : undefined} {...props}>
            {children}
        </Comp>
    );
}
