import { describe, expect, it } from "vitest";

import { PairRateLimiter } from "../../src/daemon/rate-limit.js";

/** A limiter whose clock the test drives, so windows slide without sleeping. */
function limiter(rules = { perClient: { limit: 3, windowMs: 1_000 }, global: { limit: 10, windowMs: 10_000 } }) {
    let now = 1_000;
    const instance = new PairRateLimiter(rules, { now: () => now });
    return { instance, advance: (ms: number) => (now += ms) };
}

describe("PairRateLimiter", () => {
    it("allows the budget and refuses the next attempt", () => {
        const { instance } = limiter();
        expect(instance.check("1.2.3.4").allowed).toBe(true);
        expect(instance.check("1.2.3.4").allowed).toBe(true);
        expect(instance.check("1.2.3.4").allowed).toBe(true);

        const blocked = instance.check("1.2.3.4");
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
        expect(blocked.retryAfterMs).toBeLessThanOrEqual(1_000);
    });

    it("recovers once the window slides", () => {
        const { instance, advance } = limiter();
        for (let attempt = 0; attempt < 3; attempt += 1) instance.check("1.2.3.4");
        expect(instance.check("1.2.3.4").allowed).toBe(false);

        advance(1_001);
        expect(instance.check("1.2.3.4").allowed).toBe(true);
    });

    it("keeps per-client budgets separate", () => {
        const { instance } = limiter();
        for (let attempt = 0; attempt < 3; attempt += 1) instance.check("1.2.3.4");
        expect(instance.check("1.2.3.4").allowed).toBe(false);
        expect(instance.check("5.6.7.8").allowed).toBe(true);
    });

    it("applies the global budget across clients", () => {
        const { instance } = limiter({ perClient: { limit: 5, windowMs: 1_000 }, global: { limit: 3, windowMs: 10_000 } });
        expect(instance.check("a").allowed).toBe(true);
        expect(instance.check("b").allowed).toBe(true);
        expect(instance.check("c").allowed).toBe(true);
        // A brand-new client is still refused: the global window is full.
        const blocked = instance.check("d");
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfterMs).toBeLessThanOrEqual(10_000);
    });

    it("forgets every window on reset", () => {
        const { instance } = limiter();
        for (let attempt = 0; attempt < 3; attempt += 1) instance.check("1.2.3.4");
        expect(instance.check("1.2.3.4").allowed).toBe(false);
        instance.reset();
        expect(instance.check("1.2.3.4").allowed).toBe(true);
    });

    it("treats an empty client key as one bucket", () => {
        const { instance } = limiter();
        for (let attempt = 0; attempt < 3; attempt += 1) instance.check("");
        expect(instance.check("unknown").allowed).toBe(false);
    });
});
