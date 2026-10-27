import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
    cleanup();
    if (typeof localStorage !== "undefined") {
        localStorage.clear();
    }
    if (typeof document !== "undefined") {
        document.documentElement.removeAttribute("data-theme");
    }
});

if (typeof window !== "undefined") {
    // next-themes / responsive helpers expect these in jsdom.
    if (!window.matchMedia) {
        Object.defineProperty(window, "matchMedia", {
            writable: true,
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        });
    }

    // jsdom ships stubs that print "Not implemented: ..." errors to stderr.
    // Replace them with silent vi.fn() mocks.
    window.scrollTo = vi.fn();
}

if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.getContext = vi.fn();
}

if (!globalThis.ResizeObserver) {
    class ResizeObserverStub {
        observe() {}
        unobserve() {}
        disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
}

if (typeof Element !== "undefined") {
    Element.prototype.scrollIntoView = vi.fn();
}
