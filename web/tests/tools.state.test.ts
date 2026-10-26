import { describe, expect, it } from "vitest";

import { STATE_ALIAS, STATE_KEY, isFailure, isRunning, isSoft, stateOf } from "@/features/chat/tools/state";
import type { ToolState } from "@/features/chat/tools/types";

/** Alias → canonical state matrix (contract §3, `core.js:68-104`). */
const ALIASES: [string, ToolState][] = [
    ["running", "running"],
    ["spinning", "running"],
    ["in_progress", "running"],
    ["in-progress", "running"],
    ["pending", "queued"],
    ["queued", "queued"],
    ["done", "done"],
    ["completed", "done"],
    ["success", "done"],
    ["ok", "done"],
    ["failed", "failed"],
    ["error", "failed"],
    ["err", "failed"],
    ["timeout", "timeout"],
    ["timed_out", "timeout"],
    ["interrupted", "interrupted"],
    ["aborted", "interrupted"],
    ["rejected", "rejected"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    ["stopped", "cancelled"],
];

describe("stateOf", () => {
    it("normalizes all 21 aliases", () => {
        for (const [alias, state] of ALIASES) {
            expect(stateOf({ state: alias }), alias).toBe(state);
            expect(STATE_ALIAS[alias], alias).toBe(state);
        }
    });

    it("normalizes case and surrounding whitespace", () => {
        expect(stateOf({ state: " RUNNING " })).toBe("running");
        expect(stateOf({ state: "Cancelled" })).toBe("cancelled");
    });

    it("never turns an unknown or empty state into a spinner — it lands on done", () => {
        for (const raw of ["", "weird", "in_flux", "PAUSED", null, undefined]) {
            expect(stateOf({ state: raw ?? undefined }), String(raw)).toBe("done");
        }
        expect(stateOf(null)).toBe("done");
        expect(stateOf(undefined)).toBe("done");
        expect(stateOf("")).toBe("done");
        expect(stateOf("exploded")).toBe("done");
    });

    it("accepts a bare state string as well as an object", () => {
        expect(stateOf("failed")).toBe("failed");
        expect(stateOf("pending")).toBe("queued");
    });
});

describe("state predicates", () => {
    const MATRIX: [ToolState, boolean, boolean, boolean][] = [
        // state, isFailure, isRunning, isSoft
        ["failed", true, false, false],
        ["timeout", true, false, false],
        ["running", false, true, false],
        ["queued", false, false, false],
        ["done", false, false, false],
        ["interrupted", false, false, true],
        ["rejected", false, false, true],
        ["cancelled", false, false, true],
    ];

    it("matches the failure / running / soft matrix", () => {
        for (const [state, failure, running, soft] of MATRIX) {
            expect(isFailure(state), state).toBe(failure);
            expect(isRunning(state), state).toBe(running);
            expect(isSoft(state), state).toBe(soft);
        }
    });

    it("maps every state to an aria key", () => {
        const keys = Object.values(STATE_KEY);
        expect(keys).toHaveLength(8);
        for (const key of keys) expect(key).toMatch(/^(state|chat\.meta)\./);
        expect(STATE_KEY.running).toBe("state.running");
        expect(STATE_KEY.queued).toBe("state.queued");
        expect(STATE_KEY.cancelled).toBe("state.stopped");
    });
});
