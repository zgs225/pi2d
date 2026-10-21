import { cn } from "@/lib/utils";

export interface ProgressProps {
    value: number;
    max?: number;
    tone?: "default" | "warn" | "err";
    size?: "default" | "lg";
    className?: string;
    label?: string;
}

export function Progress({ value, max = 100, tone = "default", size = "default", className, label }: ProgressProps) {
    const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    return (
        <div
            className={cn("progress", tone === "warn" && "progress--warn", tone === "err" && "progress--err", size === "lg" && "progress--lg", className)}
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={label}
        >
            <i style={{ width: `${pct}%` }} />
        </div>
    );
}
