import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LiveUptime, uptimeAnchor, uptimeSecondsFrom } from "@/features/status/uptime";

afterEach(() => {
    vi.useRealTimers();
});

describe("uptime anchoring", () => {
    it("anchors a reported duration at the matching epoch instant", () => {
        expect(uptimeAnchor(5_000, 10_000)).toBe(5_000);
        expect(uptimeAnchor(3 * 86_400_000, 1_000)).toBe(1_000 - 3 * 86_400_000);
    });

    it("rejects values a clock cannot start from", () => {
        expect(uptimeAnchor(null)).toBeNull();
        expect(uptimeAnchor(undefined)).toBeNull();
        expect(uptimeAnchor(Number.NaN)).toBeNull();
        expect(uptimeAnchor(Number.POSITIVE_INFINITY)).toBeNull();
        // A negative duration would render as a rewind, not as uptime.
        expect(uptimeAnchor(-1)).toBeNull();
    });

    it("counts forward and never below zero", () => {
        expect(uptimeSecondsFrom(1_000, 62_000)).toBe(61);
        expect(uptimeSecondsFrom(1_000, 1_000)).toBe(0);
        expect(uptimeSecondsFrom(1_000, 0)).toBe(0);
    });
});

describe("LiveUptime", () => {
    it("renders an em dash when the daemon reports nothing", () => {
        const { container } = render(<LiveUptime ms={null} />);
        expect(container.textContent).toBe("—");
    });

    it("ticks without needing a fresh /info sample", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

        // `/info` was only fetched once; the label must keep counting locally.
        const { container } = render(<LiveUptime ms={5 * 60_000} />);
        expect(container.textContent).toBe("0h 5m");

        act(() => {
            vi.advanceTimersByTime(60_000);
        });
        expect(container.textContent).toBe("0h 6m");
    });
});
