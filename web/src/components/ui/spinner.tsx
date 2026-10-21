import { cn } from "@/lib/utils";

export function Spinner({ className, label }: { className?: string; label?: string }) {
    return <span className={cn("spinner", className)} role="status" aria-label={label} />;
}
