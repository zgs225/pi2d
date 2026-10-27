import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BLINK_MS, blinkTick, resetBlinkClock, startBlinkClock } from "@/lib/blink";

describe("blink clock", () => {
    const originalMatchMedia = window.matchMedia;

    beforeEach(() => {
        vi.useFakeTimers();
        resetBlinkClock();
    });

    afterEach(() => {
        resetBlinkClock();
        window.matchMedia = originalMatchMedia;
        vi.restoreAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it("applies 'on'/'on' synchronously on subscribe and transitions phases in lockstep", () => {
        const unsub = startBlinkClock();

        // Synchronously applied on subscribe at tick 0 (no flash of dim).
        expect(blinkTick()).toBe(0);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("on");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("on");

        // After 500ms: fast -> "dim", slow stays "on".
        vi.advanceTimersByTime(BLINK_MS);
        expect(blinkTick()).toBe(1);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("dim");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("on");

        // After 1000ms: fast -> "on", slow -> "dim".
        vi.advanceTimersByTime(BLINK_MS);
        expect(blinkTick()).toBe(2);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("on");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("dim");

        // After 1500ms: both "dim".
        vi.advanceTimersByTime(BLINK_MS);
        expect(blinkTick()).toBe(3);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("dim");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("dim");

        // After 2000ms: cycle restarts at both "on".
        vi.advanceTimersByTime(BLINK_MS);
        expect(blinkTick()).toBe(4);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("on");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("on");

        // The two phases remain derived from ONE tick counter in lockstep.
        for (let i = 5; i <= 12; i++) {
            vi.advanceTimersByTime(BLINK_MS);
            expect(blinkTick()).toBe(i);
            const expectedFast = i % 2 === 0 ? "on" : "dim";
            const expectedSlow = Math.floor(i / 2) % 2 === 0 ? "on" : "dim";
            expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe(expectedFast);
            expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe(expectedSlow);
        }

        unsub();
    });

    it("ref-counts subscribers: two subscribers install ONE interval", () => {
        const setIntervalSpy = vi.spyOn(window, "setInterval");

        const unsub1 = startBlinkClock();
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        const unsub2 = startBlinkClock();
        // Second subscriber must reuse the existing interval.
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);

        // Unsubscribing one keeps it ticking.
        unsub1();
        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(BLINK_MS);
        expect(blinkTick()).toBe(1);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("dim");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("on");

        // The last unsubscribe clears the interval, removes attributes, and resets tick to 0.
        unsub2();
        expect(vi.getTimerCount()).toBe(0);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBeNull();
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBeNull();
        expect(blinkTick()).toBe(0);

        // Advancing time further produces no ticks.
        vi.advanceTimersByTime(BLINK_MS * 4);
        expect(blinkTick()).toBe(0);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBeNull();
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBeNull();
    });

    it("returns an idempotent unsubscribe function", () => {
        const unsub = startBlinkClock();
        expect(vi.getTimerCount()).toBe(1);

        // Multiple calls to the same unsubscribe handle do not decrement below zero or throw.
        unsub();
        expect(vi.getTimerCount()).toBe(0);
        expect(blinkTick()).toBe(0);

        unsub();
        expect(vi.getTimerCount()).toBe(0);
        expect(blinkTick()).toBe(0);

        unsub();
        expect(vi.getTimerCount()).toBe(0);
        expect(blinkTick()).toBe(0);

        // A subsequent subscription starts cleanly with a single interval.
        const unsubNew = startBlinkClock();
        expect(vi.getTimerCount()).toBe(1);
        expect(blinkTick()).toBe(0);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("on");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("on");

        unsubNew();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("pins both attributes to 'on' without installing an interval under prefers-reduced-motion: reduce", () => {
        const matchMediaMock = vi.fn().mockImplementation((query: string) => ({
            matches: query.includes("prefers-reduced-motion: reduce"),
            media: query,
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
        }));
        window.matchMedia = matchMediaMock;
        const setIntervalSpy = vi.spyOn(window, "setInterval");

        const unsub = startBlinkClock();

        expect(matchMediaMock).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
        // Both attributes pinned "on".
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("on");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("on");
        // No interval installed at all.
        expect(vi.getTimerCount()).toBe(0);
        expect(setIntervalSpy).not.toHaveBeenCalled();

        // Advancing time does not change attributes or tick.
        vi.advanceTimersByTime(BLINK_MS * 10);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("on");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("on");
        expect(blinkTick()).toBe(0);

        // Unsubscribe clears attributes.
        unsub();
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBeNull();
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBeNull();
        expect(blinkTick()).toBe(0);
    });

    it("resetBlinkClock stops timer, clears attributes, and resets tick to 0", () => {
        startBlinkClock();
        vi.advanceTimersByTime(BLINK_MS * 3);
        expect(blinkTick()).toBe(3);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBe("dim");
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBe("dim");

        resetBlinkClock();

        expect(vi.getTimerCount()).toBe(0);
        expect(document.documentElement.getAttribute("data-pi-blink-fast")).toBeNull();
        expect(document.documentElement.getAttribute("data-pi-blink-slow")).toBeNull();
        expect(blinkTick()).toBe(0);
    });
});
