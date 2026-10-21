import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

export const buttonVariants = cva("btn", {
    variants: {
        variant: {
            default: "",
            primary: "btn--primary",
            ghost: "btn--ghost",
            danger: "btn--danger",
        },
        size: {
            default: "",
            sm: "btn--sm",
            icon: "btn--icon",
        },
    },
    defaultVariants: {
        variant: "default",
        size: "default",
    },
});

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
        VariantProps<typeof buttonVariants> {
    asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { className, variant, size, asChild = false, type, ...props },
    ref,
) {
    const Comp = asChild ? Slot : "button";
    return (
        <Comp
            ref={ref}
            className={cn(buttonVariants({ variant, size }), className)}
            {...(!asChild ? { type: type ?? "button" } : {})}
            {...props}
        />
    );
});
