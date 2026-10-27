import { useEffect, useState } from "react";

/**
 * pi2.nvim's auto-title spinner (`lua/pi/ui/sessions.lua`): 10 braille frames
 * ticked every 120 ms and rendered as a *prefix* before the name — never in
 * place of it. It only runs while the backend generates a title; the row's own
 * text stays static (pi2.nvim animates nothing else in `:PiSessions`).
 *
 * `prefers-reduced-motion: reduce` freezes it on the first frame: the state is
 * still visible, only the motion stops.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;

export interface SessionTitleSpinnerProps {
    /** Hidden from assistive tech: the row's name already carries the state. */
    className?: string;
}

export function SessionTitleSpinner({ className = "t-spinner" }: SessionTitleSpinnerProps) {
    const [frame, setFrame] = useState(0);

    useEffect(() => {
        if (typeof window === "undefined") return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        const timer = window.setInterval(() => {
            setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
        }, SPINNER_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, []);

    return (
        <span className={className} aria-hidden="true">
            {SPINNER_FRAMES[frame]}
        </span>
    );
}
