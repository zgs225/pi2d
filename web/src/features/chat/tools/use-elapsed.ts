/**
 * Shared 1-second ticker for `.tool__dur`.
 *
 * The prototype runs one global `setInterval` that walks
 * `.tool--running[data-started-at]` (core.js:406-420). In React the same thing is
 * cheaper as a per-row hook: the interval exists only while the row is running and
 * is cleaned up on unmount / state change, and rows that finish simply stop ticking.
 */
import { useEffect, useState } from "react";

import { durShort } from "./format";

/**
 * Elapsed time since `startedAt`, re-rendering once per second.
 * Returns `""` when the call is not running (or has no start time).
 */
export function useElapsed(startedAt: number | null | undefined, running: boolean): string {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!running || !startedAt) return;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [running, startedAt]);

    if (!running || !startedAt) return "";
    return durShort(now - startedAt);
}
