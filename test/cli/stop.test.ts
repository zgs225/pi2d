import { describe, expect, it } from "vitest";
import { runStop, type StopOptions } from "../../src/cli/stop.js";
import { CliError } from "../../src/cli/util.js";
import type { DaemonLock } from "../../src/cli/lock.js";

function mockLock(overrides: Partial<DaemonLock> = {}): DaemonLock {
    return {
        pid: 12345,
        bootId: "boot-1",
        port: 7676,
        daemonId: "d-test-1",
        startedAt: 1700000000000,
        protocolVersion: 1,
        ...overrides,
    };
}

describe("runStop", () => {
    it("throws CliError when neither daemon.json nor daemon.lock exists", async () => {
        await expect(
            runStop({
                readDaemonJson: () => undefined,
                readLockFile: () => undefined,
            }),
        ).rejects.toThrow("no running pi2 daemon");
    });

    it("cleans up stale lock and throws CliError when PID is dead", async () => {
        const unlinked: string[] = [];
        const lock = mockLock({ pid: 99999 });

        await expect(
            runStop({
                readDaemonJson: () => lock,
                isPidAlive: () => false,
                bootId: () => "boot-1",
                unlink: (p) => unlinked.push(p),
            }),
        ).rejects.toThrow("no running pi2 daemon (cleaned up stale lock for pid 99999)");

        expect(unlinked.length).toBe(2);
    });

    it("cleans up stale lock and throws CliError when bootId has changed", async () => {
        const unlinked: string[] = [];
        const lock = mockLock({ pid: 12345, bootId: "boot-old" });

        await expect(
            runStop({
                readDaemonJson: () => lock,
                isPidAlive: () => true,
                bootId: () => "boot-new",
                unlink: (p) => unlinked.push(p),
            }),
        ).rejects.toThrow("no running pi2 daemon (cleaned up stale lock for pid 12345)");

        expect(unlinked.length).toBe(2);
    });

    it("sends SIGTERM, waits for daemon to exit, and returns 0", async () => {
        const signals: { pid: number; signal: NodeJS.Signals }[] = [];
        const lines: string[] = [];
        const unlinked: string[] = [];
        let alive = true;

        const code = await runStop({
            readDaemonJson: () => mockLock({ pid: 12345 }),
            isPidAlive: () => alive,
            bootId: () => "boot-1",
            kill: (pid, sig) => {
                signals.push({ pid, signal: sig });
                alive = false;
            },
            print: (line) => lines.push(line),
            unlink: (p) => unlinked.push(p),
            sleep: async () => {},
        });

        expect(code).toBe(0);
        expect(signals).toEqual([{ pid: 12345, signal: "SIGTERM" }]);
        expect(lines).toEqual(["pi2 daemon (pid 12345) stopped"]);
        expect(unlinked.length).toBe(2);
    });

    it("handles ESRCH on SIGTERM cleanly as stopped", async () => {
        const lines: string[] = [];
        const unlinked: string[] = [];

        const esrch = new Error("kill ESRCH") as NodeJS.ErrnoException;
        esrch.code = "ESRCH";

        const code = await runStop({
            readDaemonJson: () => mockLock({ pid: 12345 }),
            isPidAlive: () => true,
            bootId: () => "boot-1",
            kill: () => {
                throw esrch;
            },
            print: (line) => lines.push(line),
            unlink: (p) => unlinked.push(p),
        });

        expect(code).toBe(0);
        expect(lines).toEqual(["pi2 daemon (pid 12345) stopped"]);
        expect(unlinked.length).toBe(2);
    });

    it("throws CliError when SIGTERM fails with EPERM", async () => {
        const eperm = new Error("kill EPERM") as NodeJS.ErrnoException;
        eperm.code = "EPERM";

        await expect(
            runStop({
                readDaemonJson: () => mockLock({ pid: 12345 }),
                isPidAlive: () => true,
                bootId: () => "boot-1",
                kill: () => {
                    throw eperm;
                },
            }),
        ).rejects.toThrow("failed to stop pi2 daemon (pid 12345): permission denied");
    });

    it("throws CliError when daemon does not exit within timeout without force", async () => {
        let fakeTime = 1000;
        await expect(
            runStop({
                readDaemonJson: () => mockLock({ pid: 12345 }),
                isPidAlive: () => true,
                bootId: () => "boot-1",
                kill: () => {},
                timeoutSec: 1,
                now: () => fakeTime,
                sleep: async (ms) => {
                    fakeTime += ms;
                },
            }),
        ).rejects.toThrow("pi2 daemon (pid 12345) did not stop within 1s; use --force to kill");
    });

    it("escalates to SIGKILL with --force when SIGTERM times out", async () => {
        const signals: { pid: number; signal: NodeJS.Signals }[] = [];
        const lines: string[] = [];
        const unlinked: string[] = [];
        let fakeTime = 1000;
        let killedWithSigkill = false;

        const code = await runStop({
            readDaemonJson: () => mockLock({ pid: 12345 }),
            isPidAlive: () => !killedWithSigkill,
            bootId: () => "boot-1",
            kill: (pid, sig) => {
                signals.push({ pid, signal: sig });
                if (sig === "SIGKILL") killedWithSigkill = true;
            },
            force: true,
            timeoutSec: 1,
            now: () => fakeTime,
            sleep: async (ms) => {
                fakeTime += ms;
            },
            print: (line) => lines.push(line),
            unlink: (p) => unlinked.push(p),
        });

        expect(code).toBe(0);
        expect(signals).toEqual([
            { pid: 12345, signal: "SIGTERM" },
            { pid: 12345, signal: "SIGKILL" },
        ]);
        expect(lines).toEqual(["pi2 daemon (pid 12345) killed with SIGKILL"]);
        expect(unlinked.length).toBe(2);
    });

    it("throws CliError if daemon still alive after SIGKILL", async () => {
        let fakeTime = 1000;
        await expect(
            runStop({
                readDaemonJson: () => mockLock({ pid: 12345 }),
                isPidAlive: () => true,
                bootId: () => "boot-1",
                kill: () => {},
                force: true,
                timeoutSec: 1,
                now: () => fakeTime,
                sleep: async (ms) => {
                    fakeTime += ms;
                },
            }),
        ).rejects.toThrow("pi2 daemon (pid 12345) could not be killed with SIGKILL");
    });
});
