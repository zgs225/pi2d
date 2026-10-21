import { cn } from "@/lib/utils";

/** Status-dot vocabulary from the design's `:PiSessions` state matrix. */
export type DotStatus = "busy" | "compacting" | "idle" | "ok" | "err" | "attention" | "exited";

export const DOT_CLASS: Record<DotStatus, string> = {
    busy: "dot--busy",
    compacting: "dot--compacting",
    idle: "dot--idle",
    ok: "dot--ok",
    err: "dot--err",
    attention: "dot--attention",
    exited: "dot--exited",
};

export type ServerStatus = "online" | "degraded" | "offline";

/** Server / connection status mapping (online → ok, degraded → attention, else exited). */
export function serverDotClass(status: ServerStatus | string | null | undefined): string {
    if (status === "online") return DOT_CLASS.ok;
    if (status === "degraded" || status === "attention" || status === "compacting") return DOT_CLASS.attention;
    if (status === "offline" || status === "exited" || status === "unpaired") return DOT_CLASS.exited;
    if (status === "busy" || status === "connecting" || status === "pairing") return DOT_CLASS.busy;
    return DOT_CLASS.idle;
}

export type SubagentStatus = "active" | "completed" | "failed" | "interrupted" | "dormant";

export function subagentDotClass(status: SubagentStatus | string): string {
    switch (status) {
        case "active":
            return DOT_CLASS.busy;
        case "completed":
            return DOT_CLASS.ok;
        case "failed":
            return DOT_CLASS.err;
        case "interrupted":
            return DOT_CLASS.attention;
        case "dormant":
            return DOT_CLASS.exited;
        default:
            return DOT_CLASS.idle;
    }
}

export type SessionStatus = "starting" | "busy" | "compacting" | "idle" | "exited" | "interrupted" | "attention" | "done" | "error";

export function sessionDotClass(status: SessionStatus | string): string {
    switch (status) {
        case "busy":
        case "starting":
            return DOT_CLASS.busy;
        case "compacting":
            return DOT_CLASS.compacting;
        case "interrupted":
        case "attention":
            return DOT_CLASS.attention;
        case "done":
            return DOT_CLASS.ok;
        case "error":
            return DOT_CLASS.err;
        case "exited":
            return DOT_CLASS.exited;
        case "idle":
            return DOT_CLASS.idle;
        default:
            return DOT_CLASS.idle;
    }
}

export interface StatusDotProps {
    status: DotStatus;
    title?: string;
    className?: string;
    /** Decorative by default; pass a title to expose the state to assistive tech. */
    "aria-hidden"?: boolean;
}

export function StatusDot({ status, title, className, ...rest }: StatusDotProps) {
    return (
        <span
            className={cn("dot", DOT_CLASS[status], className)}
            title={title}
            aria-label={title}
            aria-hidden={title ? undefined : true}
            {...rest}
        />
    );
}
