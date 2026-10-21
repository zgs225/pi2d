import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PORT_RETRIES, main, parseDaemonArgs } from "../../src/cli/pi2d.js";
import { acquireLock } from "../../src/cli/lock.js";
import { readCliToken, tokenPerms, writeCliToken } from "../../src/cli/token.js";
import { UsageError } from "../../src/cli/util.js";
import { PROTOCOL_VERSION } from "../../src/protocol/types.js";
import { clearRuntimeEnv, removeDir, setRuntimeEnv, tempDir } from "./helpers.js";

describe("parseDaemonArgs", () => {
    it("defaults to nothing set (foreground daemon, config defaults)", () => {
        expect(parseDaemonArgs([])).toEqual({ force: false, foreground: false, help: false, version: false });
    });

    it("parses every flag, in both value syntaxes", () => {
        expect(parseDaemonArgs(["--port", "7676", "--host", "0.0.0.0", "--static-dir=/srv/ui", "--force", "--foreground"])).toEqual({
            port: 7676,
            host: "0.0.0.0",
            staticDir: "/srv/ui",
            force: true,
            foreground: true,
            help: false,
            version: false,
        });
        expect(parseDaemonArgs(["-p", "0"]).port).toBe(0);
        expect(parseDaemonArgs(["-f"]).force).toBe(true);
        expect(parseDaemonArgs(["--help"]).help).toBe(true);
        expect(parseDaemonArgs(["-h"]).help).toBe(true);
        expect(parseDaemonArgs(["-V"]).version).toBe(true);
    });

    it("rejects bad ports and stray positionals", () => {
        for (const port of ["abc", "-1", "70000", "1.5"]) {
            expect(() => parseDaemonArgs(["--port", port])).toThrow(UsageError);
        }
        expect(() => parseDaemonArgs(["extra"])).toThrow(/unexpected argument extra/);
        expect(() => parseDaemonArgs(["--nope"])).toThrow(/unknown option --nope/);
        expect(() => parseDaemonArgs(["--port"])).toThrow(/requires a value/);
    });

    it("retries the default port at most +9", () => {
        expect(DEFAULT_PORT_RETRIES).toBe(9);
    });
});

describe("pi2d main (non-listening paths)", () => {
    it("prints usage for --help", async () => {
        const out: string[] = [];
        const code = await main(["--help"], { out: (line) => out.push(line), err: () => undefined });
        expect(code).toBe(0);
        expect(out.join("\n")).toContain("Usage: pi2d [options]");
        expect(out.join("\n")).toContain("--static-dir");
    });

    it("prints the version for --version", async () => {
        const out: string[] = [];
        const code = await main(["--version"], { out: (line) => out.push(line), err: () => undefined });
        expect(code).toBe(0);
        expect(out[0]).toMatch(/^pi2d \d+\.\d+\.\d+/);
    });

    it("exits 2 on bad arguments", async () => {
        const err: string[] = [];
        const code = await main(["--port", "nope"], {
            out: () => undefined,
            err: (line) => err.push(line),
        });
        expect(code).toBe(2);
        expect(err[0]).toContain("--port must be an integer");
    });
});

describe("local CLI token", () => {
    let dir: string;

    beforeEach(() => {
        dir = tempDir("pi2-token-");
    });

    afterEach(() => removeDir(dir));
    it("is 32 bytes of hex, written atomically with mode 0600", () => {
        const path = join(dir, "run", "cli.token");
        const token = writeCliToken(path);
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readFileSync(path, "utf8").trim()).toBe(token);
        expect(readCliToken(path)).toBe(token);
        expect(tokenPerms(path)).toEqual({ exists: true, mode: 0o600 });
    });

    it("rotates on every start", () => {
        const path = join(dir, "cli.token");
        const first = writeCliToken(path);
        const second = writeCliToken(path);
        expect(second).not.toBe(first);
        expect(readCliToken(path)).toBe(second);
    });

    it("reads as undefined when missing", () => {
        const path = join(dir, "missing.token");
        expect(readCliToken(path)).toBeUndefined();
        expect(tokenPerms(path)).toEqual({ exists: false, mode: undefined });
    });

    it("tightens the mode of a pre-existing world-readable token", () => {
        const path = join(dir, "cli.token");
        writeCliToken(path);
        chmodSync(path, 0o644);
        writeCliToken(path);
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });
});

describe("pi2d singleton lock vs cli.token", () => {
    let dir: string;
    let tokenPath: string;

    beforeEach(() => {
        dir = tempDir("pi2d-main-lock-");
        setRuntimeEnv(dir);
        mkdirSync(join(dir, "web"), { recursive: true });
        tokenPath = join(dir, "run", "cli.token");
    });

    afterEach(() => {
        clearRuntimeEnv();
        removeDir(dir);
    });

    function holdLock(): ReturnType<typeof acquireLock> {
        return acquireLock({
            payload: {
                port: 0,
                daemonId: "d-holder",
                startedAt: Date.now(),
                protocolVersion: PROTOCOL_VERSION,
            },
        });
    }

    it("does not rotate cli.token when another daemon holds the lock", async () => {
        mkdirSync(join(dir, "run"), { recursive: true });
        const original = writeCliToken(tokenPath);
        const holder = holdLock();
        try {
            const err: string[] = [];
            const code = await main([], { out: () => undefined, err: (line) => err.push(line) });
            expect(code).toBe(1);
            expect(err.join("\n")).toContain("another pi2d is running");
            expect(readCliToken(tokenPath)).toBe(original);
        } finally {
            holder.release();
        }
    });

    it("does not create cli.token before the lock is acquired", async () => {
        const holder = holdLock();
        try {
            const code = await main([], { out: () => undefined, err: () => undefined });
            expect(code).toBe(1);
            expect(existsSync(tokenPath)).toBe(false);
        } finally {
            holder.release();
        }
    });
});
