import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    acquireLock,
    assessLock,
    LockError,
    readDaemonJson,
    readLockFile,
    writeDaemonJson,
    type DaemonLock,
} from "../../src/cli/lock.js";
import { PROTOCOL_VERSION } from "../../src/protocol/types.js";
import { removeDir, tempDir } from "./helpers.js";

const BOOT = "boot-abc";

function payload(overrides: Partial<DaemonLock> = {}): Omit<DaemonLock, "pid" | "bootId"> & { pid?: number; bootId?: string } {
    return {
        port: 7676,
        daemonId: "d-test",
        startedAt: 1_700_000_000_000,
        protocolVersion: PROTOCOL_VERSION,
        ...overrides,
    };
}

describe("daemon lock", () => {
    let dir: string;
    let lockPath: string;

    beforeEach(() => {
        dir = tempDir("pi2-lock-");
        mkdirSync(dir, { recursive: true });
        lockPath = join(dir, "daemon.lock");
    });

    afterEach(() => removeDir(dir));

    it("creates the lock with the payload and mode 0600", () => {
        const handle = acquireLock({ lockPath, payload: payload(), bootId: () => BOOT });
        expect(handle.lock).toEqual({
            pid: process.pid,
            bootId: BOOT,
            port: 7676,
            daemonId: "d-test",
            startedAt: 1_700_000_000_000,
            protocolVersion: PROTOCOL_VERSION,
        });
        expect(readLockFile(lockPath)).toEqual(handle.lock);
        expect(statSync(lockPath).mode & 0o777).toBe(0o600);
        expect(readFileSync(lockPath, "utf8").endsWith("\n")).toBe(true);

        handle.release();
        expect(existsSync(lockPath)).toBe(false);
    });

    it("refuses a second daemon while the holder is alive", () => {
        const first = acquireLock({ lockPath, payload: payload(), bootId: () => BOOT });
        expect(() => acquireLock({ lockPath, payload: payload({ daemonId: "d-two" }), bootId: () => BOOT })).toThrow(
            LockError,
        );
        try {
            acquireLock({ lockPath, payload: payload({ daemonId: "d-two" }), bootId: () => BOOT });
        } catch (error) {
            const lockError = error as LockError;
            expect(lockError.code).toBe("E_LOCKED");
            expect(lockError.holder?.daemonId).toBe("d-test");
            expect(lockError.holder?.pid).toBe(process.pid);
            expect(lockError.message).toContain("--force");
        }
        // The original lock survived the failed attempt.
        expect(readLockFile(lockPath)?.daemonId).toBe("d-test");
        first.release();
    });

    it("overrides a live lock with --force", () => {
        const first = acquireLock({ lockPath, payload: payload(), bootId: () => BOOT });
        const forced = acquireLock({ lockPath, payload: payload({ daemonId: "d-forced" }), bootId: () => BOOT, force: true });
        expect(forced.lock.daemonId).toBe("d-forced");
        expect(readLockFile(lockPath)?.daemonId).toBe("d-forced");

        // The displaced daemon must not delete the new lock on shutdown.
        first.release();
        expect(readLockFile(lockPath)?.daemonId).toBe("d-forced");
        forced.release();
        expect(existsSync(lockPath)).toBe(false);
    });

    it("treats a dead pid as stale", () => {
        acquireLock({ lockPath, payload: payload({ daemonId: "d-dead" }), bootId: () => BOOT });
        const handle = acquireLock({
            lockPath,
            payload: payload({ daemonId: "d-new" }),
            bootId: () => BOOT,
            isPidAlive: () => false,
        });
        expect(handle.lock.daemonId).toBe("d-new");
        handle.release();
    });

    it("treats a pid from a previous boot as stale (pid reuse)", () => {
        acquireLock({ lockPath, payload: payload({ daemonId: "d-old" }), bootId: () => "boot-old" });
        const handle = acquireLock({
            lockPath,
            payload: payload({ daemonId: "d-new" }),
            bootId: () => BOOT,
            isPidAlive: () => true,
        });
        expect(handle.lock.daemonId).toBe("d-new");
        expect(handle.lock.bootId).toBe(BOOT);
        handle.release();
    });

    it("ignores a malformed lock file (crash during write)", () => {
        writeFileSync(lockPath, "{not json");
        const handle = acquireLock({ lockPath, payload: payload(), bootId: () => BOOT });
        expect(readLockFile(lockPath)?.daemonId).toBe("d-test");
        handle.release();
    });

    it("update() rewrites the payload in place", () => {
        const handle = acquireLock({ lockPath, payload: payload({ port: 0 }), bootId: () => BOOT });
        handle.update({ port: 7712 });
        expect(handle.lock.port).toBe(7712);
        expect(readLockFile(lockPath)?.port).toBe(7712);
        expect(readLockFile(lockPath)?.daemonId).toBe("d-test");
        handle.release();
    });

    it("assessLock explains why a lock is stale", () => {
        const lock: DaemonLock = {
            pid: 42,
            bootId: BOOT,
            port: 7676,
            daemonId: "d-1",
            startedAt: 1,
            protocolVersion: PROTOCOL_VERSION,
        };
        expect(assessLock(lock, { isPidAlive: () => true, bootId: () => BOOT })).toEqual({ live: true, reason: "alive" });
        expect(assessLock(lock, { isPidAlive: () => false, bootId: () => BOOT })).toEqual({
            live: false,
            reason: "no-pid",
        });
        expect(assessLock(lock, { isPidAlive: () => true, bootId: () => "other" })).toEqual({
            live: false,
            reason: "boot-changed",
        });
    });
});

describe("daemon.json", () => {
    let dir: string;
    let lockPath: string;
    let daemonJsonPath: string;

    beforeEach(() => {
        dir = tempDir("pi2-daemonjson-");
        lockPath = join(dir, "daemon.lock");
        daemonJsonPath = join(dir, "daemon.json");
    });

    afterEach(() => removeDir(dir));

    it("publishes the same payload as the lock, mode 0600", () => {
        const handle = acquireLock({
            lockPath,
            payload: { port: 7713, daemonId: "d-json", startedAt: 5, protocolVersion: PROTOCOL_VERSION },
            bootId: () => BOOT,
        });
        writeDaemonJson(handle.lock, daemonJsonPath);

        const discovered = readDaemonJson(daemonJsonPath);
        expect(discovered).toEqual({
            pid: process.pid,
            bootId: BOOT,
            port: 7713,
            daemonId: "d-json",
            startedAt: 5,
            protocolVersion: PROTOCOL_VERSION,
        });
        expect(statSync(daemonJsonPath).mode & 0o777).toBe(0o600);
        handle.release();
    });

    it("carries the optional access/publicUrl fields and stays readable without them", () => {
        const handle = acquireLock({
            lockPath,
            payload: {
                port: 7676,
                daemonId: "d-access",
                startedAt: 5,
                protocolVersion: PROTOCOL_VERSION,
                access: "tailscale",
                publicUrl: "https://host.ts.net",
            },
            bootId: () => BOOT,
        });
        expect(readLockFile(lockPath)?.access).toBe("tailscale");
        expect(readLockFile(lockPath)?.publicUrl).toBe("https://host.ts.net");
        handle.release();

        // A legacy payload (no new fields) still parses.
        const legacy = { ...payload(), pid: process.pid, bootId: BOOT };
        writeFileSync(lockPath, `${JSON.stringify(legacy)}\n`);
        expect(readLockFile(lockPath)?.access).toBeUndefined();
        expect(readLockFile(lockPath)?.publicUrl).toBeUndefined();
    });

    it("refuses a malformed access field", () => {
        const legacy = { ...payload(), pid: process.pid, bootId: BOOT, access: "public" };
        writeFileSync(lockPath, `${JSON.stringify(legacy)}\n`);
        expect(readLockFile(lockPath)).toBeUndefined();
    });

    it("is removed by release() and missing files read as undefined", () => {
        const handle = acquireLock({
            lockPath,
            payload: { port: 7676, daemonId: "d-json", startedAt: 5, protocolVersion: PROTOCOL_VERSION },
            bootId: () => BOOT,
        });
        writeDaemonJson(handle.lock, daemonJsonPath);
        handle.release();
        expect(existsSync(daemonJsonPath)).toBe(false);
        expect(readDaemonJson(daemonJsonPath)).toBeUndefined();

        // A discovery file owned by another daemon is left alone.
        writeDaemonJson({ ...handle.lock, daemonId: "d-other" }, daemonJsonPath);
        expect(readDaemonJson(daemonJsonPath)?.daemonId).toBe("d-other");
    });
});
