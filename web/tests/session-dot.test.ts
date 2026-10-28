import { describe, expect, it } from "vitest";

import type { SessionFlags, SessionState } from "@protocol/types";
import {
    childSessionDot,
    emptySessionState,
    sessionDot,
    sessionStatusKey,
    subagentDot,
} from "@/features/chat/session-state";

/**
 * The dot contract, in one place.
 *
 * `DotView` is the *only* decision about whether a dot blinks and at which
 * rate: `blink: "fast"` → `.dot--blink-fast`, `blink: "slow"` →
 * `.dot--blink-slow`, omitted → solid. The renderer never infers the animation
 * from the colour class or from where the dot is mounted (`status-dot.tsx`,
 * `app.css`), so every row below asserts the *whole* view with `toEqual` —
 * an unexpected `blink` is a failure, and a stray `steady` key can never come
 * back unnoticed.
 *
 * Regression this pins: `done` (green) used to blink only inside `.tree-row`
 * because the animation was keyed on `html[data-pi-blink-fast="dim"]
 * .tree-row .dot--ok`, while `.dot--busy`/`.dot--err` blazed globally and
 * `dot--steady` could not stop `ok` at all.
 */

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
                name: "exited -> dead, solid (a dead process does not blink)",
                state: makeSession({ status: "exited" }),
                expected: { status: "dead" },
            },
            {
                name: "error -> err, blinking fast",
                state: makeSession({ flags: { error: true } }),
                expected: { status: "err", blink: "fast" },
            },
            {
                name: "attention flag -> attention, solid",
                state: makeSession({ flags: { attention: true } }),
                expected: { status: "attention" },
            },
            {
                name: "attention array non-empty -> attention, solid",
                state: makeSession({ attention: [{ id: "q1" } as any] }),
                expected: { status: "attention" },
            },
            {
                name: "done -> ok, blinking fast (the green that used to be tree-scoped)",
                state: makeSession({ flags: { done: true } }),
                expected: { status: "ok", blink: "fast" },
            },
            {
                name: "busy -> busy, blinking fast",
                state: makeSession({ status: "busy" }),
                expected: { status: "busy", blink: "fast" },
            },
            {
                name: "compacting -> compacting, blinking slow",
                state: makeSession({ status: "compacting" }),
                expected: { status: "compacting", blink: "slow" },
            },
            {
                name: "interrupted -> dead, solid",
                state: makeSession({ status: "interrupted" }),
                expected: { status: "dead" },
            },
            {
                name: "starting -> idle, solid",
                state: makeSession({ status: "starting" }),
                expected: { status: "idle" },
            },
            {
                name: "idle -> idle, solid",
                state: makeSession({ status: "idle" }),
                expected: { status: "idle" },
            },
        ])("$name", ({ state, expected }) => {
            expect(sessionDot(state)).toEqual(expected);
        });

        it("compacting blinks at the slow rate, never at the busy rate, unviewed", () => {
            expect(sessionDot(makeSession({ status: "compacting" }))).toEqual({
                status: "compacting",
                blink: "slow",
            });
            expect(sessionDot(makeSession({ status: "compacting" })).blink).not.toBe("fast");
        });

        it("exited and interrupted never blink (no acknowledgement path needed)", () => {
            expect(sessionDot(makeSession({ status: "exited" }))).toEqual({ status: "dead" });
            expect(sessionDot(makeSession({ status: "interrupted" }))).toEqual({ status: "dead" });
            for (const status of ["exited", "interrupted"] as const) {
                expect(sessionDot(makeSession({ status }))).not.toHaveProperty("blink");
            }
        });

        it("attention never blinks, from the flag or the request array", () => {
            expect(sessionDot(makeSession({ flags: { attention: true } }))).toEqual({ status: "attention" });
            expect(sessionDot(makeSession({ attention: [{ id: "q1" } as any] }))).toEqual({
                status: "attention",
            });
        });
    });

    describe("priority collisions (bug fixes: exited > error > attention > done > busy)", () => {
        it("error beats attention (flags.error outranks flags.attention)", () => {
            const state = makeSession({
                flags: { error: true, attention: true },
            });
            expect(sessionDot(state)).toEqual({ status: "err", blink: "fast" });
        });

        it("error beats attention (flags.error outranks populated attention array)", () => {
            const state = makeSession({
                flags: { error: true },
                attention: [{ id: "q1" } as any],
            });
            expect(sessionDot(state)).toEqual({ status: "err", blink: "fast" });
        });

        it("exited beats error (status: exited outranks flags.error)", () => {
            const state = makeSession({
                status: "exited",
                flags: { error: true },
            });
            expect(sessionDot(state)).toEqual({ status: "dead" });
        });

        it("interrupted is a dead process too (outranks error, attention and done)", () => {
            // The plugin has no `interrupted`: any "not running" row is `exited`
            // (sessions.lua:75-78), and `exited` sits at the top of dot_hl.
            expect(sessionDot(makeSession({ status: "interrupted", flags: { error: true } }))).toEqual({
                status: "dead",
            });
            expect(sessionDot(makeSession({ status: "interrupted", flags: { attention: true } }))).toEqual({
                status: "dead",
            });
            expect(sessionDot(makeSession({ status: "interrupted", flags: { done: true } }))).toEqual({
                status: "dead",
            });
            // …and it never wears the blue current marker either.
            expect(sessionDot(makeSession({ status: "interrupted" }), { viewed: true })).toEqual({ status: "dead" });
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
            expect(sessionDot(state)).toEqual({ status: "ok", blink: "fast" });
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
            expect(sessionDot(state)).toEqual({ status: "err", blink: "fast" });
        });

        it("attention beats busy (flags.attention outranks status: busy)", () => {
            const state = makeSession({
                status: "busy",
                flags: { attention: true },
            });
            expect(sessionDot(state)).toEqual({ status: "attention" });
        });

        it("a busy session keeps the fast rate (compacting never downgrades it)", () => {
            const state = makeSession({ status: "busy" });
            expect(sessionDot(state)).toEqual({ status: "busy", blink: "fast" });
        });
    });

    describe("viewed overlay (you are here)", () => {
        it.each([
            {
                name: "idle -> current, solid",
                state: makeSession({ status: "idle" }),
                expected: { status: "idle", current: true },
            },
            {
                name: "busy -> current (busy), blinking fast",
                state: makeSession({ status: "busy" }),
                expected: { status: "busy", blink: "fast", current: true },
            },
            {
                name: "compacting -> current with status flipped to busy, blinking fast (not slow)",
                state: makeSession({ status: "compacting" }),
                expected: { status: "busy", blink: "fast", current: true },
            },
        ])("$name", ({ state, expected }) => {
            expect(sessionDot(state, { viewed: true })).toEqual(expected);
        });

        it("focused compacting blinks at the busy rate under the marker", () => {
            const viewed = sessionDot(makeSession({ status: "compacting" }), { viewed: true });
            expect(viewed).toEqual({ status: "busy", blink: "fast", current: true });
            // The unfocused row keeps the slow rate: the rate follows the view.
            expect(sessionDot(makeSession({ status: "compacting" }))).toEqual({
                status: "compacting",
                blink: "slow",
            });
        });

        describe("no overlay when notification flags are set", () => {
            it("suppresses current overlay when error is set, but keeps the fast blink", () => {
                const state = makeSession({ status: "idle", flags: { error: true } });
                expect(sessionDot(state, { viewed: true })).toEqual({ status: "err", blink: "fast" });
            });

            it("suppresses current overlay when done is set, but keeps the fast blink", () => {
                const state = makeSession({ status: "idle", flags: { done: true } });
                expect(sessionDot(state, { viewed: true })).toEqual({ status: "ok", blink: "fast" });
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
                expect(sessionDot(state, { viewed: false })).toEqual({ status: "busy", blink: "fast" });
            });

            it("does not apply current or flip status when viewed: false on compacting", () => {
                const state = makeSession({ status: "compacting" });
                expect(sessionDot(state, { viewed: false })).toEqual({ status: "compacting", blink: "slow" });
            });

            it("does not apply current when opts is omitted", () => {
                const state = makeSession({ status: "idle" });
                expect(sessionDot(state)).toEqual({ status: "idle" });
            });
        });
    });

    describe("the view is the only animation decision (no `steady`, no colour-keyed blink)", () => {
        const samples: SessionState[] = [
            makeSession({ status: "idle" }),
            makeSession({ status: "busy" }),
            makeSession({ status: "compacting" }),
            makeSession({ status: "exited" }),
            makeSession({ status: "interrupted" }),
            makeSession({ status: "starting" }),
            makeSession({ flags: { error: true } }),
            makeSession({ flags: { done: true } }),
            makeSession({ flags: { attention: true } }),
        ];

        it.each(samples.map((state) => [state.status, state] as const))(
            "renders only status/blink/current keys for a %s session",
            (_status, state) => {
                for (const viewed of [false, true]) {
                    const view = sessionDot(state, { viewed });
                    const unexpected = Object.keys(view).filter(
                        (key) => !["status", "blink", "current"].includes(key),
                    );
                    expect(unexpected, `unexpected DotView keys on ${state.status}`).toEqual([]);
                    expect(view).not.toHaveProperty("steady");
                    if (view.blink !== undefined) expect(["fast", "slow"]).toContain(view.blink);
                }
            },
        );

        it("a dot without a blink is solid", () => {
            expect(sessionDot(makeSession({ status: "idle" })).blink).toBeUndefined();
            expect(sessionDot(makeSession({ status: "starting" })).blink).toBeUndefined();
            expect(sessionDot(makeSession({ flags: { attention: true } })).blink).toBeUndefined();
            expect(sessionDot(makeSession({ status: "exited" })).blink).toBeUndefined();
            expect(sessionDot(makeSession({ status: "interrupted" })).blink).toBeUndefined();
        });
    });
});

describe("childSessionDot (sub-session / tree depth > 0)", () => {
    describe("base status matrix", () => {
        it.each([
            {
                name: "exited -> exited (hollow ring), solid",
                state: makeChild({ status: "exited" }),
                opts: undefined,
                expected: { status: "exited" },
            },
            {
                name: "interrupted -> dead, solid",
                state: makeChild({ status: "interrupted" }),
                opts: undefined,
                expected: { status: "dead" },
            },
            {
                name: "error with viewed -> err, solid (acknowledged red)",
                state: makeChild({ flags: { error: true } }),
                opts: { viewed: true },
                expected: { status: "err" },
            },
            {
                name: "error with viewed: false -> err, blinking fast",
                state: makeChild({ flags: { error: true } }),
                opts: { viewed: false },
                expected: { status: "err", blink: "fast" },
            },
            {
                name: "error with opts omitted -> err, blinking fast",
                state: makeChild({ flags: { error: true } }),
                opts: undefined,
                expected: { status: "err", blink: "fast" },
            },
            {
                name: "busy -> busy, blinking fast",
                state: makeChild({ status: "busy" }),
                opts: undefined,
                expected: { status: "busy", blink: "fast" },
            },
            {
                name: "compacting -> busy (NOT compacting), blinking fast",
                state: makeChild({ status: "compacting" }),
                opts: undefined,
                expected: { status: "busy", blink: "fast" },
            },
            {
                name: "idle -> idle, solid",
                state: makeChild({ status: "idle" }),
                opts: undefined,
                expected: { status: "idle" },
            },
        ])("$name", ({ state, opts, expected }) => {
            expect(childSessionDot(state, opts)).toEqual(expected);
        });

        it("a viewed failed child is steady red while the unviewed one blinks", () => {
            const viewed = childSessionDot(makeChild({ flags: { error: true } }), { viewed: true });
            const unviewed = childSessionDot(makeChild({ flags: { error: true } }));
            expect(viewed).toEqual({ status: "err" });
            expect(unviewed).toEqual({ status: "err", blink: "fast" });
            expect(viewed).not.toHaveProperty("blink");
        });
    });

    describe("child never returns ok or attention", () => {
        it("returns idle instead of ok when flags.done is set on idle child", () => {
            const state = makeChild({ status: "idle", flags: { done: true } });
            expect(childSessionDot(state)).toEqual({ status: "idle" });
        });

        it("returns busy instead of ok when flags.done is set on busy child", () => {
            const state = makeChild({ status: "busy", flags: { done: true } });
            expect(childSessionDot(state)).toEqual({ status: "busy", blink: "fast" });
        });

        it("returns idle instead of attention when flags.attention is set on idle child", () => {
            const state = makeChild({ status: "idle", flags: { attention: true } });
            expect(childSessionDot(state)).toEqual({ status: "idle" });
        });

        it("returns idle instead of attention when attention array is populated on idle child", () => {
            const state = makeChild({
                status: "idle",
                attention: [{ id: "q1" } as any],
            });
            expect(childSessionDot(state)).toEqual({ status: "idle" });
        });

        it("returns busy instead of attention when flags.attention is set on busy child", () => {
            const state = makeChild({
                status: "busy",
                flags: { attention: true },
                attention: [{ id: "q1" } as any],
            });
            expect(childSessionDot(state)).toEqual({ status: "busy", blink: "fast" });
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
        it("applies current overlay to idle child when viewed (still solid)", () => {
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
                blink: "fast",
                current: true,
            });
        });

        it("applies current overlay to compacting child with status flipped to busy", () => {
            const state = makeChild({ status: "compacting" });
            expect(childSessionDot(state, { viewed: true })).toEqual({
                status: "busy",
                blink: "fast",
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

        it("does not apply current overlay to a failed child, and the error stays solid", () => {
            const state = makeChild({ flags: { error: true } });
            expect(childSessionDot(state, { viewed: true })).toEqual({ status: "err" });
        });
    });
});

describe("subagentDot (manifest-only subagent tree rows)", () => {
    it.each([
        {
            // A manifest-only entry has no live child (a live one renders as its
            // own session row), and nvim blinks only a live busy child: amber, solid.
            name: "active -> busy, solid",
            subagent: makeSubagent({ status: "active" }),
            opts: undefined,
            expected: { status: "busy" },
        },
        {
            name: "completed -> exited, solid",
            subagent: makeSubagent({ status: "completed" }),
            opts: undefined,
            expected: { status: "exited" },
        },
        {
            name: "dormant -> exited, solid",
            subagent: makeSubagent({ status: "dormant" }),
            opts: undefined,
            expected: { status: "exited" },
        },
        {
            name: "failed with viewed -> steady err",
            subagent: makeSubagent({ status: "failed" }),
            opts: { viewed: true },
            expected: { status: "err" },
        },
        {
            name: "failed with viewed: false -> blinking err",
            subagent: makeSubagent({ status: "failed" }),
            opts: { viewed: false },
            expected: { status: "err", blink: "fast" },
        },
        {
            name: "failed with opts omitted -> blinking err",
            subagent: makeSubagent({ status: "failed" }),
            opts: undefined,
            expected: { status: "err", blink: "fast" },
        },
        {
            name: "interrupted -> dead, solid",
            subagent: makeSubagent({ status: "interrupted" }),
            opts: undefined,
            expected: { status: "dead" },
        },
        {
            name: "unknown status -> idle, solid",
            subagent: makeSubagent({ status: "unknown" as any }),
            opts: undefined,
            expected: { status: "idle" },
        },
    ])("$name", ({ subagent, opts, expected }) => {
        expect(subagentDot(subagent, opts)).toEqual(expected);
    });

    it("a failed subagent stops blinking once it is the viewed child view", () => {
        const failed = makeSubagent({ status: "failed" });
        expect(subagentDot(failed, { viewed: true })).toEqual({ status: "err" });
        expect(subagentDot(failed)).toEqual({ status: "err", blink: "fast" });
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
