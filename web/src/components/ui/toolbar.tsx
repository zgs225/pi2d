import * as React from "react";

import { cn } from "@/lib/utils";

export function Toolbar({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("toolbar", className)} role="toolbar" {...props} />;
}
