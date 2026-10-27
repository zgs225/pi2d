import { cn } from "@/lib/utils";

/** Status-dot vocabulary from the design's `:PiSessions` state matrix. */
export type DotStatus = "busy" | "compacting" | "idle" | "ok" | "err" | "attention" | "exited" | "dead";

export const DOT_CLASS: Record<DotStatus, string> = {
    busy: "dot--busy",
    compacting: "dot--compacting",
    idle: "dot--idle",
    ok: "dot--ok",
    err: "dot--err",
    attention: "dot--attention",
    exited: "dot--exited",
    dead: "dot--dead",
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

export interface StatusDotProps {
    status: DotStatus;
    title?: string;
    className?: string;
    /** Pin the dot solid (no blink) — nvim's "focused child error is steady red". */
    steady?: boolean;
    /** "You are here" overlay (nvim `PiSessionsListCurrent`, agent blue). */
    current?: boolean;
    /** Decorative by default; pass a title to expose the state to assistive tech. */
    "aria-hidden"?: boolean;
}

export function StatusDot({ status, title, className, steady, current, ...rest }: StatusDotProps) {
    return (
        <span
            className={cn("dot", DOT_CLASS[status], steady && "dot--steady", current && "dot--current", className)}
            title={title}
            aria-label={title}
            aria-hidden={title ? undefined : true}
            {...rest}
        />
    );
}
