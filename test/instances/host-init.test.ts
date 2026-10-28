/**
 * Generated host init (`src/instances/host-init.ts`).
 *
 * `node:fs/promises.writeFile` is spied on so "memoized / compared before write"
 * is asserted by counting real writes instead of racing file mtimes.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    const writeFile = actual.writeFile as unknown as (...args: unknown[]) => Promise<void>;
    return {
        ...actual,
        writeFile: (...args: unknown[]): Promise<void> => {
            writes.paths.push(String(args[0]));
            return writeFile(...args);
        },
    };
});

const { HOST_INIT_FILENAME, renderHostInit, resetHostInitCache, writeHostInit } = await import(
    "../../src/instances/host-init.js"
);

const PLUGIN = "/home/tester/.local/share/nvim/lazy/pi2.nvim";

describe("renderHostInit", () => {
    it("prepends the plugin and starts the host without loading the user config", () => {
        const lua = renderHostInit(PLUGIN);

        expect(lua).toContain(`vim.opt.runtimepath:prepend("${PLUGIN}")`);
        expect(lua).toContain("vim.opt.swapfile = false");
        expect(lua).toContain('vim.opt.shadafile = "NONE"');
        expect(lua).toContain('vim.g.mapleader = " "');
        expect(lua).toContain('local ok, host = pcall(require, "pi.host")');
        expect(lua).toContain('vim.api.nvim_err_writeln("pi2: " .. tostring(host))');
        expect(lua).toContain('vim.cmd("cquit 1")');
        expect(lua).toContain("host.start()");
        // Header names the daemon and the plugin it points at, so a stray file in
        // the state dir explains itself.
        expect(lua).toContain("pi2d");
        expect(lua).toContain(`-- plugin: ${PLUGIN}`);
        // No wait loop of our own: host.start() owns the handshake.
        expect(lua).not.toContain("vim.wait");
        // A failing `require` must exit, not fall through to host.start().
        expect(lua.indexOf("cquit 1")).toBeLessThan(lua.indexOf("host.start()"));
    });

    it("escapes the plugin dir as a Lua string (no shell quoting)", () => {
        const lua = renderHostInit('/tmp/we"ird\\dir');
        expect(lua).toContain('vim.opt.runtimepath:prepend("/tmp/we\\"ird\\\\dir")');
        expect(lua).not.toContain("'");
    });
});

describe("writeHostInit", () => {
    let dir: string;

    beforeEach(() => {
        dir = resolve(mkdtempSync(join(tmpdir(), "pi2-host-init-")));
        writes.paths.length = 0;
        resetHostInitCache();
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("writes host-init.lua (mode 0600) and returns the absolute path", async () => {
        const path = await writeHostInit({ dir, pluginDir: PLUGIN });

        expect(path).toBe(join(dir, HOST_INIT_FILENAME));
        expect(readFileSync(path, "utf8")).toBe(renderHostInit(PLUGIN));
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(writes.paths).toHaveLength(1);
    });

    it("does not rewrite on the second call for the same (dir, pluginDir)", async () => {
        const first = await writeHostInit({ dir, pluginDir: PLUGIN });
        const second = await writeHostInit({ dir, pluginDir: PLUGIN });

        expect(second).toBe(first);
        expect(writes.paths).toHaveLength(1);
    });

    it("rewrites when the plugin dir changes", async () => {
        await writeHostInit({ dir, pluginDir: PLUGIN });
        const other = "/tmp/other/pi2.nvim";
        const path = await writeHostInit({ dir, pluginDir: other });

        expect(readFileSync(path, "utf8")).toContain(`vim.opt.runtimepath:prepend("${other}")`);
        expect(writes.paths).toHaveLength(2);
    });

    it("skips the write when the file already matches", async () => {
        const path = join(dir, HOST_INIT_FILENAME);
        writeFileSync(path, renderHostInit(PLUGIN));
        resetHostInitCache();

        await expect(writeHostInit({ dir, pluginDir: PLUGIN })).resolves.toBe(path);
        expect(writes.paths).toHaveLength(0);
    });
});
