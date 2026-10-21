import * as React from "react";

import { cn } from "@/lib/utils";

export interface SegOption<T extends string> {
    value: T;
    label: React.ReactNode;
}

export interface SegProps<T extends string> {
    value: T;
    options: readonly SegOption<T>[];
    onChange: (value: T) => void;
    ariaLabel?: string;
    className?: string;
}

/** Segmented control (base.css `.seg > button.active`). */
export function Seg<T extends string>({ value, options, onChange, ariaLabel, className }: SegProps<T>) {
    return (
        <div className={cn("seg", className)} role="group" aria-label={ariaLabel}>
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    className={option.value === value ? "active" : undefined}
                    aria-pressed={option.value === value}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </button>
            ))}
        </div>
    );
}
