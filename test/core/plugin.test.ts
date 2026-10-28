/**
 * Plugin discovery (`src/core/plugin.ts`).
 *
 * Everything is injected (`env`, `home`, `exists`, `readdir`) so the tests never
 * look at the machine's real nvim install: a developer with pi2.nvim checked out
 * would otherwise get different results from CI.
 */

import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
    PLUGIN_NAME,
    classifyPluginDir,
    describePluginFailure,
    displayPath,
    pluginDirCandidates,
    resolvePluginDir,
} from "../../src/core/plugin.js";

const HOME = "/home/tester";
const HOST = "lua/pi/host.lua";
const BRIDGE = "lua/pi/web/bridge.lua";

/** Fake `exists` over an explicit set of paths. */
function fakeExists(paths: readonly string[]): (path: string) => boolean {
    const set = new Set(paths);
    return (path) => set.has(path);
}

/** Minimal `Dirent` lookalike; `readdir` is only asked for directory names. */
function dir(name: string): Dirent {
    return { name, isDirectory: () => true } as Dirent;
}

/** A `readdir` that only knows one directory (any other root is "missing"). */
function fakeReaddir(entries: Record<string, Dirent[]>): (path: string, o: { withFileTypes: true }) => Dirent[] {
    return (path) => {
        const found = entries[path];
        if (found === undefined) throw new Error(`ENOENT: ${path}`);
        return found;
    };
}

const PACK = `${HOME}/.local/share/nvim/site/pack`;

describe("resolvePluginDir", () => {
    it("uses PI2_PLUGIN_DIR first and expands a leading ~/", () => {
        const configured = "/home/tester/work/pi2.nvim";
        const resolution = resolvePluginDir({
            env: { PI2_PLUGIN_DIR: "  ~/work/pi2.nvim  " },
            home: HOME,
            exists: fakeExists([configured, `${configured}/${HOST}`, `${configured}/${BRIDGE}`]),
            readdir: fakeReaddir({}),
        });

        expect(resolution).toEqual({
            plugin: {
                dir: configured,
                host: `${configured}/${HOST}`,
                bridge: `${configured}/${BRIDGE}`,
            },
        });
    });

    it("skips a lazy checkout without lua/pi/host.lua in favour of a pack dir", () => {
        const lazy = `${HOME}/.local/share/nvim/lazy/${PLUGIN_NAME}`;
        const packed = `${PACK}/plugins/start/${PLUGIN_NAME}`;
        const resolution = resolvePluginDir({
            env: {},
            home: HOME,
            exists: fakeExists([
                lazy,
                // lazy.nvim installed the plugin but this checkout predates host.lua
                `${lazy}/${BRIDGE}`,
                packed,
                `${packed}/${HOST}`,
                `${packed}/${BRIDGE}`,
            ]),
            readdir: fakeReaddir({ [PACK]: [dir("plugins")] }),
        });

        expect(resolution.plugin?.dir).toBe(packed);
    });

    it("reports every candidate when nothing is host-capable", () => {
        const lazy = `${HOME}/.local/share/nvim/lazy/${PLUGIN_NAME}`;
        const resolution = resolvePluginDir({
            env: {},
            home: HOME,
            exists: fakeExists([lazy, `${lazy}/${HOST}`]),
            readdir: fakeReaddir({ [PACK]: [dir("a"), dir("b")] }),
        });

        expect(resolution.plugin).toBeUndefined();
        expect(resolution.candidates?.map((candidate) => candidate.reason)).toEqual([
            "missing-bridge",
            "absent",
            "absent",
            "absent",
            "absent",
        ]);
        expect(resolution.candidates?.[0]?.dir).toBe(lazy);
    });

    it("never throws when site/pack is missing and ends in a readable failure", () => {
        const resolution = resolvePluginDir({
            env: {},
            home: HOME,
            exists: () => false,
            readdir: () => {
                throw new Error("ENOENT");
            },
        });

        expect(resolution.plugin).toBeUndefined();
        expect(describePluginFailure(resolution.candidates ?? [])).toContain(`no ${PLUGIN_NAME} plugin found`);
    });
});

describe("pluginDirCandidates", () => {
    it("orders env dir, lazy.nvim, pack/start, pack/opt, then the system dirs", () => {
        const dirs = pluginDirCandidates({
            env: { PI2_PLUGIN_DIR: "/opt/pi2.nvim" },
            home: HOME,
            readdir: fakeReaddir({
                [PACK]: [dir("mine")],
                "/usr/share/nvim/site/pack": [dir("distro")],
            }),
        });

        expect(dirs).toEqual([
            "/opt/pi2.nvim",
            `${HOME}/.local/share/nvim/lazy/${PLUGIN_NAME}`,
            `${PACK}/mine/start/${PLUGIN_NAME}`,
            `${PACK}/mine/opt/${PLUGIN_NAME}`,
            `/usr/share/nvim/site/pack/distro/start/${PLUGIN_NAME}`,
            `/usr/share/nvim/site/pack/distro/opt/${PLUGIN_NAME}`,
        ]);
    });

    it("ignores a blank PI2_PLUGIN_DIR and dedupes overlapping candidates", () => {
        const lazy = `${HOME}/.local/share/nvim/lazy/${PLUGIN_NAME}`;
        const dirs = pluginDirCandidates({
            env: { PI2_PLUGIN_DIR: "   ", HOME },
            home: HOME,
            readdir: fakeReaddir({}),
        });
        expect(dirs[0]).toBe(lazy);

        const duplicated = pluginDirCandidates({
            env: { PI2_PLUGIN_DIR: lazy },
            home: HOME,
            readdir: fakeReaddir({}),
        });
        expect(duplicated.filter((dir) => dir === lazy)).toHaveLength(1);
    });
});

describe("classifyPluginDir", () => {
    it("requires both entry points", () => {
        expect(classifyPluginDir("/p", fakeExists(["/p"]))).toEqual({ dir: "/p", reason: "missing-host" });
        expect(classifyPluginDir("/p", fakeExists(["/p", `/p/${HOST}`]))).toEqual({
            dir: "/p",
            reason: "missing-bridge",
        });
        expect(classifyPluginDir("/p", fakeExists(["/p", `/p/${HOST}`, `/p/${BRIDGE}`]))).toEqual({
            dir: "/p",
            reason: "ok",
        });
        expect(classifyPluginDir("/p", () => false)).toEqual({ dir: "/p", reason: "absent" });
    });
});

describe("describePluginFailure", () => {
    it("names the first existing but incomplete checkout (tilde-collapsed)", () => {
        const lazy = `${homedir()}/.local/share/nvim/lazy/${PLUGIN_NAME}`;
        const line = describePluginFailure([
            { dir: `${homedir()}/.local/share/nvim/site/pack/x/start/${PLUGIN_NAME}`, reason: "absent" },
            { dir: lazy, reason: "missing-host" },
        ]);

        expect(line).toBe(`${PLUGIN_NAME} at ~/.local/share/nvim/lazy/${PLUGIN_NAME} has no ${HOST} (update the plugin)`);
        expect(displayPath(lazy)).toContain("~/");
    });

    it("reports a missing bridge instead of the host file", () => {
        const line = describePluginFailure([{ dir: "/tmp/pi2.nvim", reason: "missing-bridge" }]);
        expect(line).toContain(`has no ${BRIDGE}`);
    });

    it("falls back to a not-found line naming the first location", () => {
        const line = describePluginFailure([
            { dir: "/tmp/a/pi2.nvim", reason: "absent" },
            { dir: "/tmp/b/pi2.nvim", reason: "absent" },
        ]);
        expect(line).toBe(`no ${PLUGIN_NAME} plugin found (looked in 2 location(s), first /tmp/a/pi2.nvim)`);
        expect(describePluginFailure([])).toContain("no locations");
    });

    // A typo in `PI2_PLUGIN_DIR` used to be blamed on a stale lazy.nvim checkout,
    // which sends the user to the wrong directory (found by the acceptance run).
    it("names an explicitly configured directory that does not exist", () => {
        const line = describePluginFailure(
            [
                { dir: "/opt/typo/pi2.nvim", reason: "absent" },
                { dir: "/home/x/.local/share/nvim/lazy/pi2.nvim", reason: "missing-host" },
            ],
            { configured: "/opt/typo/pi2.nvim" },
        );

        expect(line).toBe("PI2_PLUGIN_DIR=/opt/typo/pi2.nvim does not exist");
    });

    it("names a configured directory that is not host-capable", () => {
        const line = describePluginFailure([{ dir: "/opt/pi2.nvim", reason: "missing-host" }], {
            configured: "/opt/pi2.nvim",
        });

        expect(line).toBe(`PI2_PLUGIN_DIR=/opt/pi2.nvim has no ${HOST} (update the plugin)`);
    });
});
