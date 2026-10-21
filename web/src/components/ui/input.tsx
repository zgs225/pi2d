import * as React from "react";

import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(function Input(
    { className, type = "text", ...props },
    ref,
) {
    return <input ref={ref} type={type} className={cn("input", className)} {...props} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(function Textarea(
    { className, ...props },
    ref,
) {
    return <textarea ref={ref} className={cn("textarea", className)} {...props} />;
});

export interface FieldProps {
    label: React.ReactNode;
    htmlFor?: string;
    hint?: React.ReactNode;
    error?: React.ReactNode;
    className?: string;
    children: React.ReactNode;
}

/** Label + control + hint/error (base.css `.field`). */
export function Field({ label, htmlFor, hint, error, className, children }: FieldProps) {
    return (
        <div className={cn("field", error && "field--invalid", className)}>
            <label htmlFor={htmlFor}>{label}</label>
            {children}
            {error ? (
                <div className="hint is-err" role="alert">
                    {error}
                </div>
            ) : hint ? (
                <div className="hint">{hint}</div>
            ) : null}
        </div>
    );
}
