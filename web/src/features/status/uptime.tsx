import { useEffect, useMemo, useReducer } from "react";

import { formatUptime } from "@/features/status/server";

/**
 * Seconds elapsed since `baseAtMs`, clamped at zero.
 *
 * A duration, not a timestamp: the daemon only reports a snapshot
 * (`hostUptimeSec` on the polled `/resources`, `hostUptimeMs` on the rarely
 * refetched `/info`), so the counter has to advance locally.
 */
export function uptimeSecondsFrom(baseAtMs: number, now: number): number {
    return Math.max(0, Math.floor((now - baseAtMs) / 1000));
}

/** Epoch ms the counted duration started at, or `null` for an unusable value. */
export function uptimeAnchor(ms: number | null | undefined, now = Date.now()): number | null {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
    return now - ms;
}

export interface LiveUptimeProps {
    /** Reported uptime in milliseconds; `null`/`undefined` renders an em dash. */
    ms: number | null | undefined;
    className?: string;
}

/**
 * Ticking uptime label.
 *
 * `formatUptime` bottoms out at minutes, so a 30 s tick is enough. The anchor is
 * memoised on `ms` alone: re-renders (and the 3 s `/resources` poll reporting the
 * same second) never rewind or fast-forward the counter, while a genuinely newer
 * sample re-anchors it.
 */
export function LiveUptime({ ms, className }: LiveUptimeProps) {
    const [, tick] = useReducer((n: number) => n + 1, 0);
    const anchor = useMemo(() => uptimeAnchor(ms), [ms]);

    useEffect(() => {
        if (anchor === null) return;
        const timer = setInterval(tick, 30_000);
        return () => clearInterval(timer);
    }, [anchor]);

    if (anchor === null) return <span className={className}>—</span>;
    return <span className={className}>{formatUptime(uptimeSecondsFrom(anchor, Date.now()))}</span>;
}
