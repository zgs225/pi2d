import * as React from "react";

import { cn } from "@/lib/utils";

export function Chip({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
    return <span className={cn("chip", className)} {...props} />;
}
