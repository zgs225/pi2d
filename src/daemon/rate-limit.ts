/**
 * Sliding-window rate limiting for the public pairing endpoint.
 *
 * A pairing code is short enough to type and long enough that guessing it is
 * hopeless *only* if the guesser cannot try millions of them. Redeem is
 * unauthenticated by design (the code is the capability), so the endpoint that
 * accepts it needs its own budget: a per-client window for a single noisy
 * device, and a global window so a botnet cannot spread the attempts.
 *
 * `now` is injectable, which is how the tests advance time without sleeping.
 */

export interface RateLimitRule {
    /** Attempts allowed inside the window. */
    limit: number;
    windowMs: number;
}

export interface RateLimitDecision {
    allowed: boolean;
    /** Only meaningful when `allowed` is false. */
    retryAfterMs: number;
}

export interface PairRateLimitRules {
    perClient: RateLimitRule;
    global: RateLimitRule;
}

/** 5 attempts a minute from one address, 50 an hour overall. */
export const DEFAULT_PAIR_RATE_LIMITS: PairRateLimitRules = {
    perClient: { limit: 5, windowMs: 60_000 },
    global: { limit: 50, windowMs: 60 * 60_000 },
};

/** Drops entries older than the window so a long-lived daemon does not grow. */
function prune(timestamps: number[], now: number, windowMs: number): number[] {
    const cutoff = now - windowMs;
    let index = 0;
    while (index < timestamps.length && (timestamps[index] ?? 0) <= cutoff) index += 1;
    return index === 0 ? timestamps : timestamps.slice(index);
}

export class PairRateLimiter {
    private readonly rules: PairRateLimitRules;
    private readonly now: () => number;
    private readonly clients = new Map<string, number[]>();
    private global: number[] = [];

    constructor(rules: PairRateLimitRules = DEFAULT_PAIR_RATE_LIMITS, options: { now?: () => number } = {}) {
        this.rules = rules;
        this.now = options.now ?? Date.now;
    }

    /**
     * Count one attempt. Rejected attempts do not consume budget beyond the
     * rejection itself, so a locked-out client recovers as soon as the window
     * slides rather than being pushed further out on every retry.
     */
    check(clientKey: string): RateLimitDecision {
        const now = this.now();
        this.global = prune(this.global, now, this.rules.global.windowMs);
        const key = clientKey === "" ? "unknown" : clientKey;
        const perClient = prune(this.clients.get(key) ?? [], now, this.rules.perClient.windowMs);

        const globalFull = this.global.length >= this.rules.global.limit;
        const clientFull = perClient.length >= this.rules.perClient.limit;
        if (globalFull || clientFull) {
            this.clients.set(key, perClient);
            const window = globalFull ? this.rules.global : this.rules.perClient;
            const oldest = (globalFull ? this.global : perClient)[0] ?? now;
            return { allowed: false, retryAfterMs: Math.max(0, oldest + window.windowMs - now) };
        }

        perClient.push(now);
        this.global.push(now);
        this.clients.set(key, perClient);
        return { allowed: true, retryAfterMs: 0 };
    }

    /** Test/ops hook: forget every window. */
    reset(): void {
        this.clients.clear();
        this.global = [];
    }
}
