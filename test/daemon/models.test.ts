import { describe, expect, it, vi } from "vitest";
import { resolveModels, type ModelsCandidate } from "../../src/daemon/models.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
    workspaceId: string,
    opts: Partial<Omit<ModelsCandidate, "workspaceId">> = {},
): ModelsCandidate {
    return {
        workspaceId,
        status: opts.status ?? "ready",
        sessions: opts.sessions ?? 1,
        startedAt: opts.startedAt ?? 1000,
    };
}

function okQuery(providers: unknown[] = [{ id: "openai" }]) {
    return vi.fn((_ws: string) =>
        Promise.resolve({ providers, pending: false }),
    );
}

function pendingQuery() {
    return vi.fn((_ws: string) =>
        Promise.resolve({ providers: [], pending: true }),
    );
}

function rejectingQuery(msg = "connection refused") {
    return vi.fn((_ws: string) => Promise.reject(new Error(msg)));
}

function hangingQuery() {
    return vi.fn((_ws: string) => new Promise<Record<string, unknown>>(() => undefined));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveModels", () => {
    // 1. Preferred-first ordering
    it("queries the preferred workspace first", async () => {
        const callOrder: string[] = [];
        const query = vi.fn((ws: string) => {
            callOrder.push(ws);
            // Only "ws-b" returns a real answer so we can verify ordering
            if (ws === "ws-b") return Promise.resolve({ providers: [{ id: "openai" }], pending: false });
            return Promise.resolve({ providers: [], pending: true });
        });

        const candidates = [
            makeCandidate("ws-a", { sessions: 5, startedAt: 2000 }),
            makeCandidate("ws-b", { sessions: 1, startedAt: 1000 }),
        ];

        const result = await resolveModels({
            candidates,
            preferredWorkspaceId: "ws-b",
            query,
        });

        expect(callOrder[0]).toBe("ws-b");
        expect(result.pending).toBe(false);
        expect(result.workspaceId).toBe("ws-b");
    });

    // 2. Sessions desc then startedAt desc when no preferred
    it("orders by sessions desc, then startedAt desc when no preferred", async () => {
        const callOrder: string[] = [];
        const query = vi.fn((ws: string) => {
            callOrder.push(ws);
            return Promise.resolve({ providers: [], pending: true });
        });

        const candidates = [
            makeCandidate("ws-low-old", { sessions: 1, startedAt: 500 }),
            makeCandidate("ws-low-new", { sessions: 1, startedAt: 2000 }),
            makeCandidate("ws-high", { sessions: 10, startedAt: 1000 }),
        ];

        await resolveModels({ candidates, query });

        expect(callOrder).toEqual(["ws-high", "ws-low-new", "ws-low-old"]);
    });

    // 3. Non-ready candidates are never queried
    it("never queries non-ready candidates", async () => {
        const query = vi.fn((_ws: string) =>
            Promise.resolve({ providers: [{ id: "x" }], pending: false }),
        );

        const candidates = [
            makeCandidate("ws-starting", { status: "starting" }),
            makeCandidate("ws-stopped", { status: "stopped" }),
            makeCandidate("ws-ready", { status: "ready" }),
        ];

        const result = await resolveModels({ candidates, query });

        expect(query).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith("ws-ready");
        expect(result.pending).toBe(false);
        expect(result.workspaceId).toBe("ws-ready");
    });

    // 4. Empty candidate list → no-instance
    it("returns no-instance when candidate list is empty", async () => {
        const query = vi.fn();

        const result = await resolveModels({
            candidates: [],
            preferredWorkspaceId: "ws-x",
            query,
        });

        expect(query).not.toHaveBeenCalled();
        expect(result).toEqual({
            providers: [],
            pending: true,
            workspaceId: "ws-x",
            pendingReason: "no-instance",
            attempted: [],
        });
    });

    // 5. All ready + pending with sessions → fetching
    it("returns fetching when all candidates are pending and have sessions", async () => {
        const query = pendingQuery();
        const candidates = [
            makeCandidate("ws-a", { sessions: 2 }),
            makeCandidate("ws-b", { sessions: 3 }),
        ];

        const result = await resolveModels({ candidates, query });

        expect(result.pending).toBe(true);
        expect(result.pendingReason).toBe("fetching");
        expect(result.attempted).toHaveLength(2);
    });

    // 6. All ready + pending with zero sessions → no-live-session
    it("returns no-live-session when all candidates have zero sessions", async () => {
        const query = pendingQuery();
        const candidates = [
            makeCandidate("ws-a", { sessions: 0 }),
            makeCandidate("ws-b", { sessions: 0 }),
        ];

        const result = await resolveModels({ candidates, query });

        expect(result.pending).toBe(true);
        expect(result.pendingReason).toBe("no-live-session");
        expect(result.attempted).toHaveLength(2);
    });

    // 7. Rejecting candidate falls through and is listed in attempted
    it("falls through a rejecting candidate and records it in attempted", async () => {
        const query = vi.fn((ws: string) => {
            if (ws === "ws-bad") return Promise.reject(new Error("kaboom"));
            return Promise.resolve({ providers: [{ id: "anthropic" }], pending: false });
        });

        const candidates = [
            makeCandidate("ws-bad", { sessions: 5, startedAt: 2000 }),
            makeCandidate("ws-good", { sessions: 1, startedAt: 1000 }),
        ];

        const result = await resolveModels({ candidates, query });

        expect(result.pending).toBe(false);
        expect(result.workspaceId).toBe("ws-good");
        expect(result.attempted).toContain("ws-bad");
        expect(result.attempted).not.toContain("ws-good");
    });

    // 8. Hanging candidate times out and falls through
    it("times out a hanging candidate and falls through to the next", async () => {
        const query = vi.fn((ws: string) => {
            if (ws === "ws-hang") return hangingQuery()(ws);
            return Promise.resolve({ providers: [{ id: "gemini" }], pending: false });
        });

        const candidates = [
            makeCandidate("ws-hang", { sessions: 2, startedAt: 2000 }),
            makeCandidate("ws-ok", { sessions: 1, startedAt: 1000 }),
        ];

        const result = await resolveModels({
            candidates,
            query,
            timeoutMs: 30, // very small — should fire quickly
        });

        expect(result.pending).toBe(false);
        expect(result.workspaceId).toBe("ws-ok");
        expect(result.attempted).toContain("ws-hang");
    }, 3000);

    it("falls through when a candidate query throws synchronously", async () => {
        const query = vi.fn((ws: string) => {
            if (ws === "ws-bad") throw new Error("synchronous failure");
            return Promise.resolve({ providers: [{ id: "fallback" }], pending: false });
        });

        const result = await resolveModels({
            candidates: [makeCandidate("ws-bad", { sessions: 2 }), makeCandidate("ws-good", { sessions: 1 })],
            query,
        });

        expect(result.workspaceId).toBe("ws-good");
        expect(result.attempted).toEqual(["ws-bad"]);
    });

    // 9. First non-pending non-empty answer wins; later candidates are not queried
    it("stops at the first successful answer and does not query later candidates", async () => {
        const query = vi.fn((ws: string) => {
            if (ws === "ws-a") return Promise.resolve({ providers: [{ id: "openai" }], pending: false });
            return Promise.resolve({ providers: [{ id: "should-not-appear" }], pending: false });
        });

        const candidates = [
            makeCandidate("ws-a", { sessions: 2 }),
            makeCandidate("ws-b", { sessions: 1 }),
        ];

        const result = await resolveModels({ candidates, query });

        expect(query).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledWith("ws-a");
        expect(result.providers).toEqual([{ id: "openai" }]);
        expect(result.workspaceId).toBe("ws-a");
    });

    // 10. Provider order inside the winning ack is preserved
    it("preserves provider order from the winning ack", async () => {
        const providers = [{ id: "z" }, { id: "a" }, { id: "m" }];
        const query = okQuery(providers);

        const result = await resolveModels({
            candidates: [makeCandidate("ws-1")],
            query,
        });

        expect(result.providers).toEqual(providers);
    });

    // Extra: preferred workspace that is not ready is ignored (falls to ready pool)
    it("ignores a preferred workspace that is not ready", async () => {
        const query = okQuery();

        const candidates = [
            makeCandidate("ws-preferred", { status: "starting" }),
            makeCandidate("ws-ready", { status: "ready" }),
        ];

        const result = await resolveModels({
            candidates,
            preferredWorkspaceId: "ws-preferred",
            query,
        });

        expect(query).not.toHaveBeenCalledWith("ws-preferred");
        expect(query).toHaveBeenCalledWith("ws-ready");
        expect(result.pending).toBe(false);
    });

    // Extra: log callback is called on failure
    it("calls the log callback when a candidate fails", async () => {
        const logs: { event: string; detail: Record<string, unknown> }[] = [];
        const log = vi.fn((event: string, detail: Record<string, unknown>) => {
            logs.push({ event, detail });
        });

        const query = rejectingQuery("boom");
        const candidates = [makeCandidate("ws-fail")];

        await resolveModels({ candidates, query, log });

        expect(log).toHaveBeenCalledOnce();
        expect(logs[0]!.event).toBe("models.candidate_failed");
        expect(logs[0]!.detail["workspaceId"]).toBe("ws-fail");
    });

    // Extra: no-instance returns null workspaceId when no preferred given
    it("returns null workspaceId when no candidates and no preferred", async () => {
        const result = await resolveModels({ candidates: [], query: vi.fn() });
        expect(result.workspaceId).toBeNull();
        expect(result.pendingReason).toBe("no-instance");
    });

    // Extra: attempted list in fallback resolution uses first attempted ws
    it("uses the first attempted workspace as workspaceId in the fallback", async () => {
        const query = pendingQuery();
        const candidates = [
            makeCandidate("ws-first", { sessions: 3, startedAt: 2000 }),
            makeCandidate("ws-second", { sessions: 1, startedAt: 1000 }),
        ];

        const result = await resolveModels({ candidates, query });

        expect(result.workspaceId).toBe("ws-first");
        expect(result.attempted).toEqual(["ws-first", "ws-second"]);
    });
});
