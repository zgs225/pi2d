import * as React from "react";
import { Drawer } from "vaul";

import { cn } from "@/lib/utils";

export const Sheet = Drawer.Root;
export const SheetTrigger = Drawer.Trigger;
export const SheetClose = Drawer.Close;
export const SheetTitle = Drawer.Title;
export const SheetDescription = Drawer.Description;

export interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof Drawer.Content> {
    showHandle?: boolean;
}

/** Mobile drawer (vaul), visually aligned with the design's `.sheet`. */
export function SheetContent({ className, children, showHandle = true, ...props }: SheetContentProps) {
    return (
        <Drawer.Portal>
            <Drawer.Overlay className="sheet-overlay" />
            <Drawer.Content className={cn("sheet-content", className)} {...props}>
                {showHandle ? <div className="sheet-handle" aria-hidden="true" /> : null}
                {children}
            </Drawer.Content>
        </Drawer.Portal>
    );
}

export function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("mb-4 flex flex-col gap-1", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("mt-5 flex justify-end gap-2", className)} {...props} />;
}
