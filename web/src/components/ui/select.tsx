import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = React.forwardRef<
    React.ComponentRef<typeof SelectPrimitive.Trigger>,
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(function SelectTrigger({ className, children, ...props }, ref) {
    return (
        <SelectPrimitive.Trigger ref={ref} className={cn("select select-trigger", className)} {...props}>
            {children}
            <SelectPrimitive.Icon asChild>
                <ChevronDown size={14} aria-hidden="true" />
            </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
    );
});

export const SelectContent = React.forwardRef<
    React.ComponentRef<typeof SelectPrimitive.Content>,
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = "popper", ...props }, ref) {
    return (
        <SelectPrimitive.Portal>
            <SelectPrimitive.Content
                ref={ref}
                position={position}
                sideOffset={4}
                className={cn("select-content", className)}
                {...props}
            >
                <SelectPrimitive.Viewport className="select-viewport">{children}</SelectPrimitive.Viewport>
            </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
    );
});

export const SelectItem = React.forwardRef<
    React.ComponentRef<typeof SelectPrimitive.Item>,
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
    return (
        <SelectPrimitive.Item ref={ref} className={cn("select-item", className)} {...props}>
            <span className="select-item__indicator">
                <SelectPrimitive.ItemIndicator>
                    <Check size={14} aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
            </span>
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        </SelectPrimitive.Item>
    );
});

export const SelectLabel = React.forwardRef<
    React.ComponentRef<typeof SelectPrimitive.Label>,
    React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(function SelectLabel({ className, ...props }, ref) {
    return <SelectPrimitive.Label ref={ref} className={cn("px-3 py-1 text-xs text-muted-foreground", className)} {...props} />;
});
