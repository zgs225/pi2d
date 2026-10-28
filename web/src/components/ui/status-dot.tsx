import { cn } from "@/lib/utils";

/** Status-dot vocabulary from the design's `:PiSessions` state matrix. */
export type DotStatus = "busy" | "compacting" | "idle" | "ok" | "err" | "attention" | "exited" | "dead";

/**
 * Blink rate, in shared-clock phases (`web/src/lib/blink.ts`): `fast` follows
 * `data-pi-blink-fast` (500ms), `slow` follows `data-pi-blink-slow` (1000ms).
 */
export type BlinkRate = "fast" | "slow";

/**
 * Colour only. Whether a dot blinks is NOT encoded here: `dot--busy` is amber
 * whether it pulses (a running turn) or not (a startup `connecting` chip), so a
 * class-keyed dim rule cannot express the matrix. `blink` carries it instead.
 */
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

export const BLINK_CLASS: Record<BlinkRate, string> = {
    fast: "dot--blink-fast",
    slow: "dot--blink-slow",
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
    /**
     * Blink rate decided by the *view* that owns the dot (`DotView.blink`), never
     * by the DOM location or the colour class. Omitted/`null` = solid.
     */
    blink?: BlinkRate | null;
    title?: string;
    className?: string;
    /** "You are here" overlay (nvim `PiSessionsListCurrent`, agent blue). */
    current?: boolean;
    /** Decorative by default; pass a title to expose the state to assistive tech. */
    "aria-hidden"?: boolean;
}

export function StatusDot({ status, blink, title, className, current, ...rest }: StatusDotProps) {
    return (
        <span
            className={cn(
                "dot",
                DOT_CLASS[status],
                blink ? BLINK_CLASS[blink] : null,
                current && "dot--current",
                className,
            )}
            title={title}
            aria-label={title}
            aria-hidden={title ? undefined : true}
            {...rest}
        />
    );
}
