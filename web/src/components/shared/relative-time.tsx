import { useEffect, useReducer } from "react";
import { useTranslation } from "react-i18next";

import { currentLanguage, localeFor } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Translator = (key: string, params?: Record<string, unknown>) => string;

/** Relative time exactly as `App.fmt.rel` (just now / N minutes / N hours / N days). */
export function formatRelative(ts: number, t: Translator, now = Date.now()): string {
    const seconds = Math.max(0, (now - ts) / 1000);
    if (seconds < 60) return t("time.justNow");
    if (seconds < 3600) return t("time.minutesAgo", { n: Math.floor(seconds / 60) });
    if (seconds < 86400) return t("time.hoursAgo", { n: Math.floor(seconds / 3600) });
    return t("time.daysAgo", { n: Math.floor(seconds / 86400) });
}

export interface RelativeTimeProps {
    ts: number | null | undefined;
    className?: string;
    /** Refresh once a minute (default true). */
    live?: boolean;
}

export function RelativeTime({ ts, className, live = true }: RelativeTimeProps) {
    const { t } = useTranslation();
    const [, tick] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        if (!live) return;
        const timer = setInterval(tick, 30_000);
        return () => clearInterval(timer);
    }, [live]);

    if (ts == null || !Number.isFinite(ts)) return <span className={cn("muted", className)}>—</span>;

    return (
        <time
            className={className}
            dateTime={new Date(ts).toISOString()}
            title={new Date(ts).toLocaleString(localeFor(currentLanguage()))}
        >
            {formatRelative(ts, t)}
        </time>
    );
}
