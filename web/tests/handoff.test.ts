import { describe, expect, it, vi } from "vitest";

import { setDeviceToken, TOKEN_STORAGE_KEY } from "@/lib/api";
import { consumeHandoff, readHandoff } from "@/lib/handoff";

/** 23 characters, valid base64url alphabet. */
const TOKEN = "AbC-dEf_GhI-jKl_MnO-123";
const ENCODED_TOKEN = "AbC%2DdEf_GhI%2DjKl_MnO%2D123";

function locationWith(hash: string, pathname = "/workspaces", search = "") {
    return { hash, pathname, search };
}

function historySpy() {
    return { replaceState: vi.fn() };
}

describe("readHandoff", () => {
    it("accepts the short `#t=` form", () => {
        expect(readHandoff(`#t=${TOKEN}`)).toBe(TOKEN);
    });

    it("accepts the long `#token=` form", () => {
        expect(readHandoff(`#token=${TOKEN}`)).toBe(TOKEN);
    });

    it("decodes URL-encoded token characters", () => {
        expect(readHandoff(`#t=${ENCODED_TOKEN}`)).toBe(TOKEN);
        expect(readHandoff(`#token=${encodeURIComponent("a".repeat(20))}`)).toBe("a".repeat(20));
    });

    it("rejects anything that is not a valid handoff", () => {
        for (const hash of [
            "",
            "#",
            "#t=",
            "#t=tooshort",
            `#t=${"a".repeat(19)}`,
            "#token=tooshort",
            `#x=${TOKEN}`,
            `#t=${TOKEN}!`,
            `#t=${TOKEN}&next=/workspaces`,
            `#token=${encodeURIComponent(`Bearer ${TOKEN}`)}`,
            "#t=%E0%A4%A",
            "#pair/ABCD1234",
        ]) {
            expect(readHandoff(hash), hash).toBeNull();
        }
        expect(readHandoff(`#t=${"a".repeat(20)}`)).toBe("a".repeat(20));
    });
});

describe("consumeHandoff", () => {
    it("stores the token and strips the hash exactly once", () => {
        const history = historySpy();
        const setToken = vi.fn();

        expect(consumeHandoff(locationWith(`#t=${TOKEN}`), history, setToken)).toBe(TOKEN);
        expect(setToken).toHaveBeenCalledExactlyOnceWith(TOKEN);
        expect(history.replaceState).toHaveBeenCalledTimes(1);
        expect(history.replaceState).toHaveBeenCalledWith(null, "", "/workspaces");
    });

    it("keeps the query string when stripping the hash", () => {
        const history = historySpy();

        consumeHandoff(
            locationWith(`#token=${TOKEN}`, "/workspace/ws-1", "?next=%2Fchat%2F01a1&tab=todo"),
            history,
            vi.fn(),
        );
        expect(history.replaceState).toHaveBeenCalledWith(
            null,
            "",
            "/workspace/ws-1?next=%2Fchat%2F01a1&tab=todo",
        );
    });

    it("no-ops without a handoff hash (no history write, no token write)", () => {
        for (const hash of ["", "#", "#t=tooshort", "#/pair/ABCD1234"]) {
            const history = historySpy();
            const setToken = vi.fn();
            expect(consumeHandoff(locationWith(hash, "/workspaces", "?tab=devices"), history, setToken)).toBeNull();
            expect(history.replaceState, hash).not.toHaveBeenCalled();
            expect(setToken, hash).not.toHaveBeenCalled();
        }
    });

    it("works against the real location/history and the shared token storage", () => {
        window.history.replaceState(null, "", `/workspaces?tab=devices#t=${TOKEN}`);
        const replaceState = vi.spyOn(window.history, "replaceState");

        expect(consumeHandoff(window.location, window.history, setDeviceToken)).toBe(TOKEN);

        expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(`Bearer ${TOKEN}`);
        expect(window.location.hash).toBe("");
        expect(`${window.location.pathname}${window.location.search}`).toBe("/workspaces?tab=devices");
        expect(replaceState).toHaveBeenCalledTimes(1);
    });

    it("leaves a broken link visibly broken", () => {
        window.history.replaceState(null, "", "/workspaces#t=tooshort");
        const setToken = vi.fn();

        expect(consumeHandoff(window.location, window.history, setToken)).toBeNull();
        expect(setToken).not.toHaveBeenCalled();
        expect(window.location.hash).toBe("#t=tooshort");
    });
});
