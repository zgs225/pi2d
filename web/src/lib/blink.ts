export const BLINK_MS = 500;

let subscribers = 0;
let timerId: number | null = null;
let tick = 0;

function updateDom(fast: "on" | "dim", slow: "on" | "dim"): void {
    if (typeof document === "undefined" || !document.documentElement) return;
    document.documentElement.setAttribute("data-pi-blink-fast", fast);
    document.documentElement.setAttribute("data-pi-blink-slow", slow);
}

function clearDom(): void {
    if (typeof document === "undefined" || !document.documentElement) return;
    document.documentElement.removeAttribute("data-pi-blink-fast");
    document.documentElement.removeAttribute("data-pi-blink-slow");
}

function syncDomForTick(t: number): void {
    const fast = t % 2 === 0 ? "on" : "dim";
    const slow = Math.floor(t / 2) % 2 === 0 ? "on" : "dim";
    updateDom(fast, slow);
}

export function blinkTick(): number {
    return tick;
}

export function startBlinkClock(): () => void {
    subscribers++;

    if (subscribers === 1) {
        tick = 0;

        const prefersReducedMotion =
            typeof window !== "undefined" &&
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        if (prefersReducedMotion) {
            updateDom("on", "on");
        } else {
            syncDomForTick(tick);
            if (typeof window !== "undefined") {
                timerId = window.setInterval(() => {
                    tick++;
                    syncDomForTick(tick);
                }, BLINK_MS);
            }
        }
    }

    let unsubscribed = false;
    return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        subscribers--;

        if (subscribers <= 0) {
            subscribers = 0;
            if (timerId !== null) {
                window.clearInterval(timerId);
                timerId = null;
            }
            tick = 0;
            clearDom();
        }
    };
}

export function resetBlinkClock(): void {
    subscribers = 0;
    if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
    }
    tick = 0;
    clearDom();
}
