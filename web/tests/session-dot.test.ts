import { describe, expect, it } from "vitest";

import type { SessionFlags, SessionState } from "@protocol/types";
import {
    childSessionDot,
    emptySessionState,
    sessionDot,
    sessionStatusKey,
    subagentDot,
} from "@/features/chat/session-state";

type SessionOverrides = Omit<Partial<SessionState>, "flags"> & {
    flags?: Partial<SessionFlags>;
};

function makeSession(overrides: SessionOverrides = {}): SessionState {
    return {
        ...emptySessionState({ sessionId: overrides.sessionId ?? "s1", workspaceId: "w1" }),
        ...overrides,
        flags: {
            attention: false,
            done: false,
            error: false,
            ...(overrides.flags ?? {}),
        },
    };
}

function makeChild(overrides: SessionOverrides = {}): SessionState {
    return makeSession({ parentId: "parent-1", ...overrides });
}

function makeSubagent(
    overrides: Partial<SessionState["subagents"][number]> = {},
): SessionState["subagents"][number] {
    return {
        id: "sub-1",
        status: "active",
        ...overrides,
    };
}

describe("sessionDot (parent rows)", () => {
    describe("base status matrix", () => {
        it.each([
            {
                name: "exited -> dead",
                state: makeSession({ status: "exited" }),
                expected: { status: "dead" },
            },
            {
                name: "error -> err",
                state: makeSession({ flags: { error: true } }),
                expected: { status: "err" },
            },
            {
                name: "attention flag -> attention",
                state: makeSession({ flags: { attention: true } }),
                expected: { status: "attention" },
            },
            {
                name: "attention array non-empty -> attention",
                state: makeSession({ attention: [{ id: "q1" } as any] }),
                expected: { status: "attention" },
            },
            {
                name: "done -> ok",
                state: makeSession({ flags: { done: true } }),
                expected: { status: "ok" },
            },
            {
                name: "busy -> busy",
                state: makeSession({ status: "busy" }),
                expected: { status: "busy" },
            },
            {
                name: "compacting -> compacting",
                state: makeSession({ status: "compacting" }),
                expected: { status: "compacting" },
            },
            {
                name: "interrupted -> dead",
                state: makeSession({ status: "interrupted" }),
                expected: { status: "dead" },
            },
            {
                name: "starting -> idle",
                state: makeSession({ status: "starting" }),
                expected: { status: "idle" },
            },
            {
                name: "idle -> idle",
                state: makeSession({ status: "idle" }),
                expected: { status: "idle" },
            },
        ])("$name", ({ state, expected }) => {
            expect(sessionDot(state)).toEqual(expected);
        });
    });

    describe("priority collisions (bug fixes: exited > error > attention > done > busy)", () => {
        it("error beats attention (flags.error outranks flags.attention)", () => {
            const state = makeSession({
                flags: { error: true, attention: true },
            });
            expect(sessionDot(state)).toEqual({ status: "err" });
        });

        it("error beats attention (flags.error outranks populated attention array)", () => {
            const state = makeSession({
                flags: { error: true },
                attention: [{ id: "q1" } as any],
            });
            expect(sessionDot(state)).toEqual({ status: "err" });
        });

        it("exited beats error (status: exited outranks flags.error)", () => {
            const state = makeSession({
                status: "exited",
                flags: { error: true },
            });
            expect(sessionDot(state)).toEqual({ status: "dead" });
        });

        it("attention beats done (flags.attention outranks flags.done)", () => {
            const state = makeSession({
                flags: { attention: true, done: true },
            });
            expect(sessionDot(state)).toEqual({ status: "attention" });
        });

        it("attention beats done (populated attention array outranks flags.done)", () => {
            const state = makeSession({
                flags: { done: true },
                attention: [{ id: "q1" } as any],
            });
            expect(sessionDot(state)).toEqual({ status: "attention" });
        });

        it("done beats busy (flags.done outranks status: busy)", () => {
            const state = makeSession({
                status: "busy",
                flags: { done: true },
            });
            expect(sessionDot(state)).toEqual({ status: "ok" });
        });

        it("exited beats attention (status: exited outranks flags.attention and attention array)", () => {
            const state = makeSession({
                status: "exited",
                flags: { attention: true },
                attention: [{ id: "q1" } as any],
            });
            expect(sessionDot(state)).toEqual({ status: "dead" });
        });

        it("error beats done (flags.error outranks flags.done)", () => {
            const state = makeSession({
                flags: { error: true, done: true },
            });
            expect(sessionDot(state)).toEqual({ status: "err" });
        });

        it("attention beats busy (flags.attention outranks status: busy)", () => {
            const state = makeSession({
                status: "busy",
                flags: { attention: true },
            });
            expect(sessionDot(state)).toEqual({ status: "attention" });
        });
    });

    describe("viewed overlay (you are here)", () => {
        it.each([
            {
                name: "idle -> current",
                state: makeSession({ status: "idle" }),
                expected: { status: "idle", current: true },
            },
            {
                name: "busy -> current (busy)",
                state: makeSession({ status: "busy" }),
                expected: { status: "busy", current: true },
            },
            {
                name: "compacting -> current with status flipped to busy",
                state: makeSession({ status: "compacting" }),
                expected: { status: "busy", current: true },
            },
        ])("$name", ({ state, expected }) => {
            expect(sessionDot(state, { viewed: true })).toEqual(expected);
        });

        describe("no overlay when notification flags are set", () => {
            it("suppresses current overlay when error is set", () => {
                const state = makeSession({ status: "idle", flags: { error: true } });
                expect(sessionDot(state, { viewed: true })).toEqual({ status: "err" });
            });

            it("suppresses current overlay when done is set", () => {
                const state = makeSession({ status: "idle", flags: { done: true } });
                expect(sessionDot(state, { viewed: true })).toEqual({ status: "ok" });
            });

            it("suppresses current overlay when flags.attention is set", () => {
                const state = makeSession({ status: "idle", flags: { attention: true } });
                expect(sessionDot(state, { viewed: true })).toEqual({ status: "attention" });
            });

            it("suppresses current overlay when attention array is non-empty", () => {
                const state = makeSession({ status: "idle", attention: [{ id: "q1" } as any] });
                expect(sessionDot(state, { viewed: true })).toEqual({ status: "attention" });
            });
        });

        describe("no overlay when session is exited or interrupted", () => {
            it("suppresses current overlay when status is exited", () => {
                const state = makeSession({ status: "exited" });
                expect(sessionDot(state, { viewed: true })).toEqual({ status: "dead" });
            });

            it("suppresses current overlay when status is interrupted", () => {
                const state = makeSession({ status: "interrupted" });
                expect(sessionDot(state, { viewed: true })).toEqual({ status: "dead" });
            });
        });

        describe("no overlay when viewed is false or omitted", () => {
            it("does not apply current when viewed: false on idle", () => {
                const state = makeSession({ status: "idle" });
                expect(sessionDot(state, { viewed: false })).toEqual({ status: "idle" });
            });

            it("does not apply current when viewed: false on busy", () => {
                const state = makeSession({ status: "busy" });
                expect(sessionDot(state, { viewed: false })).toEqual({ status: "busy" });
            });

            it("does not apply current or flip status when viewed: false on compacting", () => {
                const state = makeSession({ status: "compacting" });
                expect(sessionDot(state, { viewed: false })).toEqual({ status: "compacting" });
            });

            it("does not apply current when opts is omitted", () => {
                const state = makeSession({ status: "idle" });
                expect(sessionDot(state)).toEqual({ status: "idle" });
            });
        });
    });
});

describe("childSessionDot (sub-session / tree depth > 0)", () => {
    describe("base status matrix", () => {
        it.each([
            {
                name: "exited -> exited (hollow ring)",
                state: makeChild({ status: "exited" }),
                opts: undefined,
                expected: { status: "exited" },
            },
            {
                name: "interrupted -> dead",
                state: makeChild({ status: "interrupted" }),
                opts: undefined,
                expected: { status: "dead" },
            },
            {
                name: "error with viewed -> { status: 'err', steady: true }",
                state: makeChild({ flags: { error: true } }),
                opts: { viewed: true },
                expected: { status: "err", steady: true },
            },
            {
                name: "error without viewed (viewed: false) -> { status: 'err', steady: false } (blinking)",
                state: makeChild({ flags: { error: true } }),
                opts: { viewed: false },
                expected: { status: "err", steady: false },
            },
            {
                name: "error without viewed (opts omitted) -> { status: 'err', steady: false } (blinking)",
                state: makeChild({ flags: { error: true } }),
                opts: undefined,
                expected: { status: "err", steady: false },
            },
            {
                name: "busy -> busy",
                state: makeChild({ status: "busy" }),
                opts: undefined,
                expected: { status: "busy" },
            },
            {
                name: "compacting -> busy (NOT compacting)",
                state: makeChild({ status: "compacting" }),
                opts: undefined,
                expected: { status: "busy" },
            },
            {
                name: "idle -> idle",
                state: makeChild({ status: "idle" }),
                opts: undefined,
                expected: { status: "idle" },
            },
        ])("$name", ({ state, opts, expected }) => {
            expect(childSessionDot(state, opts)).toEqual(expected);
        });
    });

    describe("child never returns ok or attention", () => {
        it("returns idle instead of ok when flags.done is set on idle child", () => {
            const state = makeChild({ status: "idle", flags: { done: true } });
            const dot = childSessionDot(state);
            expect(dot.status).not.toBe("ok");
            expect(dot.status).toBe("idle");
        });

        it("returns busy instead of ok when flags.done is set on busy child", () => {
            const state = makeChild({ status: "busy", flags: { done: true } });
            const dot = childSessionDot(state);
            expect(dot.status).not.toBe("ok");
            expect(dot.status).toBe("busy");
        });

        it("returns idle instead of attention when flags.attention is set on idle child", () => {
            const state = makeChild({ status: "idle", flags: { attention: true } });
            const dot = childSessionDot(state);
            expect(dot.status).not.toBe("attention");
            expect(dot.status).toBe("idle");
        });

        it("returns idle instead of attention when attention array is populated on idle child", () => {
            const state = makeChild({
                status: "idle",
                attention: [{ id: "q1" } as any],
            });
            const dot = childSessionDot(state);
            expect(dot.status).not.toBe("attention");
            expect(dot.status).toBe("idle");
        });

        it("returns busy instead of attention when flags.attention is set on busy child", () => {
            const state = makeChild({
                status: "busy",
                flags: { attention: true },
                attention: [{ id: "q1" } as any],
            });
            const dot = childSessionDot(state);
            expect(dot.status).not.toBe("attention");
            expect(dot.status).toBe("busy");
        });

        it("does not return ok or current when flags.done is set with viewed: true", () => {
            const state = makeChild({ status: "idle", flags: { done: true } });
            expect(childSessionDot(state, { viewed: true })).toEqual({ status: "idle" });
        });

        it("does not return attention or current when flags.attention is set with viewed: true", () => {
            const state = makeChild({ status: "idle", flags: { attention: true } });
            expect(childSessionDot(state, { viewed: true })).toEqual({ status: "idle" });
        });
    });

    describe("viewed overlay on child rows", () => {
        it("applies current overlay to idle child when viewed", () => {
            const state = makeChild({ status: "idle" });
            expect(childSessionDot(state, { viewed: true })).toEqual({
                status: "idle",
                current: true,
            });
        });

        it("applies current overlay to busy child when viewed", () => {
            const state = makeChild({ status: "busy" });
            expect(childSessionDot(state, { viewed: true })).toEqual({
                status: "busy",
                current: true,
            });
        });

        it("applies current overlay to compacting child with status flipped to busy", () => {
            const state = makeChild({ status: "compacting" });
            expect(childSessionDot(state, { viewed: true })).toEqual({
                status: "busy",
                current: true,
            });
        });

        it("does not apply current overlay to exited child", () => {
            const state = makeChild({ status: "exited" });
            expect(childSessionDot(state, { viewed: true })).toEqual({
                status: "exited",
            });
        });

        it("does not apply current overlay to interrupted child", () => {
            const state = makeChild({ status: "interrupted" });
            expect(childSessionDot(state, { viewed: true })).toEqual({
                status: "dead",
            });
        });
    });
});

describe("subagentDot (manifest-only subagent tree rows)", () => {
    it.each([
        {
            name: "active -> busy",
            subagent: makeSubagent({ status: "active" }),
            opts: undefined,
            expected: { status: "busy" },
        },
        {
            name: "completed -> exited",
            subagent: makeSubagent({ status: "completed" }),
            opts: undefined,
            expected: { status: "exited" },
        },
        {
            name: "dormant -> exited",
            subagent: makeSubagent({ status: "dormant" }),
            opts: undefined,
            expected: { status: "exited" },
        },
        {
            name: "failed with viewed -> steady err",
            subagent: makeSubagent({ status: "failed" }),
            opts: { viewed: true },
            expected: { status: "err", steady: true },
        },
        {
            name: "failed without viewed (viewed: false) -> blinking err",
            subagent: makeSubagent({ status: "failed" }),
            opts: { viewed: false },
            expected: { status: "err", steady: false },
        },
        {
            name: "failed without viewed (opts omitted) -> blinking err",
            subagent: makeSubagent({ status: "failed" }),
            opts: undefined,
            expected: { status: "err", steady: false },
        },
        {
            name: "interrupted -> dead",
            subagent: makeSubagent({ status: "interrupted" }),
            opts: undefined,
            expected: { status: "dead" },
        },
        {
            name: "unknown status -> idle",
            subagent: makeSubagent({ status: "unknown" as any }),
            opts: undefined,
            expected: { status: "idle" },
        },
    ])("$name", ({ subagent, opts, expected }) => {
        expect(subagentDot(subagent, opts)).toEqual(expected);
    });
});

describe("sessionStatusKey (stays distinct from dot)", () => {
    it("returns 'interrupted' for interrupted session while dot returns 'dead'", () => {
        const state = makeSession({ status: "interrupted" });
        expect(sessionStatusKey(state)).toBe("interrupted");
        expect(sessionDot(state)).toEqual({ status: "dead" });
    });

    it("returns 'attention' when flags.attention is true while dot returns 'attention'", () => {
        const state = makeSession({ flags: { attention: true } });
        expect(sessionStatusKey(state)).toBe("attention");
        expect(sessionDot(state)).toEqual({ status: "attention" });
    });

    it("returns 'attention' when attention array has items while dot returns 'attention'", () => {
        const state = makeSession({ attention: [{ id: "q1" } as any] });
        expect(sessionStatusKey(state)).toBe("attention");
        expect(sessionDot(state)).toEqual({ status: "attention" });
    });

    it("does not collapse interrupted into attention", () => {
        const interrupted = makeSession({ status: "interrupted" });
        const attention = makeSession({ flags: { attention: true } });
        expect(sessionStatusKey(interrupted)).not.toBe(sessionStatusKey(attention));
    });

    it.each([
        { status: "busy" as const, expected: "busy" },
        { status: "starting" as const, expected: "busy" },
        { status: "compacting" as const, expected: "compacting" },
        { status: "exited" as const, expected: "exited" },
        { status: "idle" as const, expected: "idle" },
    ])("maps status $status to key '$expected'", ({ status, expected }) => {
        const state = makeSession({ status });
        expect(sessionStatusKey(state)).toBe(expected);
    });

    it("maps flags.error to 'error'", () => {
        const state = makeSession({ flags: { error: true } });
        expect(sessionStatusKey(state)).toBe("error");
    });

    it("maps flags.done to 'done'", () => {
        const state = makeSession({ flags: { done: true } });
        expect(sessionStatusKey(state)).toBe("done");
    });
});
