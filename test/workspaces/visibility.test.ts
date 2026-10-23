import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { InstanceState } from "../../src/protocol/types.js";
import {
    classifyWorkspace,
    isTempPath,
    parseBooleanEnv,
    parseNonNegativeInt,
    tempRoots,
    type ClassifyWorkspaceInput,
} from "../../src/workspaces/index.js";
import { cleanup, makeSandbox } from "./helpers.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

function instanceState(workspaceId: string): InstanceState {
    return {
        workspaceId,
        instanceId: "i-1",
        status: "ready",
        nvimPid: 4242,
        pluginVersion: "1.8.0",
        hasUI: true,
        attachedClients: 1,
        listenAddr: null,
        startedAt: NOW,
    };
}

describe("classifyWorkspace", () => {
    // Synthetic, non-existent roots: the test must not depend on the host's
    // $HOME or on the mkdtemp sandbox (which itself lives under /tmp).
    const home = "/pi2-test-home";
    const other = "/pi2-test-other";
    const third = "/pi2-test-third";
    let sandbox: string;
    let temp: string;

    beforeEach(() => {
        sandbox = makeSandbox("pi2-daemon-visibility-");
        temp = join(sandbox, "temp");
        mkdirSync(temp, { recursive: true });
    });

    afterEach(() => cleanup(sandbox));

    /** Hermetic base row: no env leakage from the host, roots pinned to `home`. */
    function row(overrides: Partial<ClassifyWorkspaceInput> = {}): ClassifyWorkspaceInput {
        return {
            cwd: join(home, "code", "alpha"),
            exists: true,
            lastActiveAt: NOW - DAY,
            roots: [home],
            env: { TMPDIR: temp },
            now: NOW,
            ...overrides,
        };
    }

    it("defaults to a visible row with no reason", () => {
        expect(classifyWorkspace(row())).toEqual({ visibility: "default" });
    });

    it("precedence 1: hidden wins over every rescue", () => {
        const classified = classifyWorkspace(
            row({
                hidden: true,
                pinned: true,
                trusted: true,
                liveCount: 2,
                instance: instanceState("ws-1"),
                exists: false,
                cwd: join(temp, "scratch"),
            }),
        );
        expect(classified).toEqual({ visibility: "secondary", visibilityReason: "hidden" });
    });

    it("precedence 2: a live instance, pin or trust rescues temp/ghost/stale rows", () => {
        const tempGhostStale = {
            cwd: join(temp, "scratch", "deep"),
            exists: false,
            lastActiveAt: NOW - 365 * DAY,
            env: { TMPDIR: temp, PI2_WORKSPACE_STALE_DAYS: "7" },
        };
        expect(classifyWorkspace(row(tempGhostStale))).toMatchObject({
            visibility: "secondary",
            visibilityReason: "temp",
        });
        for (const rescue of [
            { instance: instanceState("ws-1") },
            { liveCount: 1 },
            { pinned: true },
            { trusted: true },
        ]) {
            expect(classifyWorkspace(row({ ...tempGhostStale, ...rescue })), JSON.stringify(rescue)).toEqual({
                visibility: "default",
            });
        }
    });

    it("precedence 3: temp paths hide by default, including trailing subpaths", () => {
        expect(classifyWorkspace(row({ cwd: temp }))).toEqual({ visibility: "secondary", visibilityReason: "temp" });
        expect(classifyWorkspace(row({ cwd: join(temp, "a", "b", "c") }))).toEqual({
            visibility: "secondary",
            visibilityReason: "temp",
        });
        // Built-in roots work without TMPDIR.
        expect(classifyWorkspace(row({ cwd: "/tmp/pi2-not-created", env: {} }))).toEqual({
            visibility: "secondary",
            visibilityReason: "temp",
        });
        expect(classifyWorkspace(row({ env: { TMPDIR: temp, PI2_WORKSPACE_HIDE_TEMP: "0" } }))).toEqual({
            visibility: "default",
        });
    });

    it("precedence 4: ghosts hide by default and beat outside-roots/stale", () => {
        const elsewhere = join(other, "gone");
        expect(classifyWorkspace(row({ cwd: elsewhere, exists: false }))).toEqual({
            visibility: "secondary",
            visibilityReason: "ghost",
        });
        expect(
            classifyWorkspace(
                row({
                    cwd: elsewhere,
                    exists: false,
                    lastActiveAt: NOW - 400 * DAY,
                    env: { TMPDIR: temp, PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS: "1", PI2_WORKSPACE_STALE_DAYS: "30" },
                }),
            ),
        ).toEqual({ visibility: "secondary", visibilityReason: "ghost" });
        expect(
            classifyWorkspace(row({ exists: false, env: { TMPDIR: temp, PI2_WORKSPACE_HIDE_GHOSTS: "0" } })),
        ).toEqual({ visibility: "default" });
    });

    it("precedence 5: outside-roots is opt-in and parses PI2_WORKSPACE_ROOTS as a list", () => {
        const outside = row({ cwd: join(other, "project"), roots: [home], env: { TMPDIR: temp } });
        // Default is 0 → still visible.
        expect(classifyWorkspace(outside)).toEqual({ visibility: "default" });
        expect(classifyWorkspace({ ...outside, env: { TMPDIR: temp, PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS: "1" } })).toEqual(
            { visibility: "secondary", visibilityReason: "outside-roots" },
        );

        // Both roots from the env list are honoured; the third path is outside.
        const roots = `${home}, ${other}`;
        const env = { TMPDIR: temp, PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS: "1", PI2_WORKSPACE_ROOTS: roots };
        expect(classifyWorkspace(row({ cwd: join(home, "a"), roots: undefined, env }))).toEqual({
            visibility: "default",
        });
        expect(classifyWorkspace(row({ cwd: join(other, "b"), roots: undefined, env }))).toEqual({
            visibility: "default",
        });
        expect(classifyWorkspace(row({ cwd: join(third, "c"), roots: undefined, env }))).toEqual({
            visibility: "secondary",
            visibilityReason: "outside-roots",
        });
    });

    it("precedence 6: stale is opt-in and never applies to lastActiveAt === null", () => {
        const old = row({ lastActiveAt: NOW - 31 * DAY, env: { TMPDIR: temp } });
        // Default 0 = disabled.
        expect(classifyWorkspace(old)).toEqual({ visibility: "default" });
        expect(classifyWorkspace({ ...old, env: { TMPDIR: temp, PI2_WORKSPACE_STALE_DAYS: "30" } })).toEqual({
            visibility: "secondary",
            visibilityReason: "stale",
        });
        const fresh = row({ lastActiveAt: NOW - 29 * DAY, env: { TMPDIR: temp, PI2_WORKSPACE_STALE_DAYS: "30" } });
        expect(classifyWorkspace(fresh)).toEqual({ visibility: "default" });
        expect(
            classifyWorkspace(
                row({ lastActiveAt: null, env: { TMPDIR: temp, PI2_WORKSPACE_STALE_DAYS: "1" } }),
            ),
        ).toEqual({ visibility: "default" });
    });

    it("never throws on garbage env values", () => {
        const garbage = {
            PI2_WORKSPACE_HIDE_TEMP: "maybe",
            PI2_WORKSPACE_HIDE_GHOSTS: "  ",
            PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS: "2",
            PI2_WORKSPACE_STALE_DAYS: "-3",
        };
        // Garbage booleans fall back to the defaults (temp+ghost on, roots off);
        // garbage stale-days falls back to 0 (off).
        expect(classifyWorkspace(row({ cwd: join(temp, "x"), env: garbage }))).toEqual({
            visibility: "secondary",
            visibilityReason: "temp",
        });
        expect(classifyWorkspace(row({ exists: false, env: garbage }))).toEqual({
            visibility: "secondary",
            visibilityReason: "ghost",
        });
        expect(classifyWorkspace(row({ cwd: join(other, "x"), lastActiveAt: null, env: garbage }))).toEqual({
            visibility: "default",
        });
        // Unknown cwd / missing roots must not throw.
        expect(classifyWorkspace({ cwd: "", exists: true, lastActiveAt: null, env: garbage })).toEqual({
            visibility: "default",
        });
    });

    it("parseBooleanEnv accepts 1/true/yes/on and 0/false/no/off, else the fallback", () => {
        for (const raw of ["1", "true", "TRUE", "yes", "on", " on "]) {
            expect(parseBooleanEnv(raw, false), raw).toBe(true);
        }
        for (const raw of ["0", "false", "False", "no", "off", " off "]) {
            expect(parseBooleanEnv(raw, true), raw).toBe(false);
        }
        for (const raw of [undefined, "", "maybe", "2", "enabled"]) {
            expect(parseBooleanEnv(raw, true), String(raw)).toBe(true);
            expect(parseBooleanEnv(raw, false), String(raw)).toBe(false);
        }
    });

    it("parseNonNegativeInt keeps positive integers and falls back to 0", () => {
        expect(parseNonNegativeInt("30")).toBe(30);
        expect(parseNonNegativeInt(" 7 ")).toBe(7);
        expect(parseNonNegativeInt("0")).toBe(0);
        for (const raw of [undefined, "", "-1", "1.5", "abc", "1e3", "999999999999999999999"]) {
            expect(parseNonNegativeInt(raw), String(raw)).toBe(0);
        }
    });

    it("tempRoots includes $TMPDIR plus the platform defaults and isTempPath matches subpaths", () => {
        const roots = tempRoots({ TMPDIR: temp });
        expect(roots).toContain(temp);
        expect(roots).toContain("/tmp");
        expect(new Set(roots).size).toBe(roots.length);
        expect(isTempPath(join(temp, "x", "y"), { TMPDIR: temp })).toBe(true);
        expect(isTempPath(temp, { TMPDIR: temp })).toBe(true);
        expect(isTempPath(join(home, "code"), { TMPDIR: temp })).toBe(false);
        expect(isTempPath("", { TMPDIR: temp })).toBe(false);
    });

    it("hides a temp ghost as temp (temp precedes ghost)", () => {
        expect(classifyWorkspace(row({ cwd: join(temp, "gone"), exists: false }))).toEqual({
            visibility: "secondary",
            visibilityReason: "temp",
        });
    });

    it("classifies rows with an unknown workspaceId-shaped input safely", () => {
        // Registry-only rows can carry an empty cwd; no path rule may fire.
        expect(classifyWorkspace(row({ cwd: "", exists: false, env: { PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS: "1" } }))).toEqual(
            { visibility: "secondary", visibilityReason: "ghost" },
        );
    });
});
