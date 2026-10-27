/**
 * `pi2 stop` / `pi2 daemon stop` — stop a running pi2 web-console daemon.
 *
 * Locates the daemon via `<runtime>/daemon.json` (or `daemon.lock`), verifies
 * the PID belongs to this boot, sends SIGTERM, and waits for it to exit.
 * If --force is passed and SIGTERM times out, escalates to SIGKILL.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { runtimeDir } from "../core/paths.js";
import {
    assessLock,
    DAEMON_JSON_FILE,
    LOCK_FILE,
    readBootId,
    readDaemonJson,
    readLockFile,
    isPidAlive as defaultIsPidAlive,
    type DaemonLock,
} from "./lock.js";
import { CliError, errorMessage } from "./util.js";

export const STOP_USAGE = `pi2 stop — stop a running pi2 daemon

Usage:
  pi2 stop [options]
  pi2 daemon stop [options]

Options:
  -f, --force          force kill with SIGKILL if the daemon does not stop in time
  -t, --timeout <sec>  seconds to wait for the daemon to exit (default: 5)
  -h, --help           print this help and exit

Environment:
  PI2_RUNTIME_DIR      directory holding daemon.json and daemon.lock`;

export interface StopOptions {
    runtime?: string;
    force?: boolean;
    timeoutSec?: number;
    print?: (line: string) => void;
    readDaemonJson?: (path: string) => DaemonLock | undefined;
    readLockFile?: (path: string) => DaemonLock | undefined;
    isPidAlive?: (pid: number) => boolean;
    bootId?: () => string;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
    unlink?: (path: string) => void;
    now?: () => number;
}

export async function runStop(options: StopOptions = {}): Promise<number> {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const runtime = options.runtime ?? runtimeDir();
    const daemonJsonPath = resolve(runtime, DAEMON_JSON_FILE);
    const lockPath = resolve(runtime, LOCK_FILE);

    const readJson = options.readDaemonJson ?? readDaemonJson;
    const readLock = options.readLockFile ?? readLockFile;
    const lock = readJson(daemonJsonPath) ?? readLock(lockPath);

    if (lock === undefined) {
        throw new CliError(`no running pi2 daemon (${daemonJsonPath} missing)`);
    }

    const checkAlive = options.isPidAlive ?? defaultIsPidAlive;
    const getBootId = options.bootId ?? readBootId;
    const staleness = assessLock(lock, { isPidAlive: checkAlive, bootId: getBootId });
    const doUnlink = options.unlink ?? ((p: string) => rmSync(p, { force: true }));

    if (!staleness.live) {
        doUnlink(daemonJsonPath);
        doUnlink(lockPath);
        throw new CliError(`no running pi2 daemon (cleaned up stale lock for pid ${lock.pid})`);
    }

    const killFn = options.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
    const sleepFn = options.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
    const nowFn = options.now ?? Date.now;
    const timeoutSec = options.timeoutSec ?? 5;
    const timeoutMs = timeoutSec * 1000;

    try {
        killFn(lock.pid, "SIGTERM");
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ESRCH") {
            doUnlink(daemonJsonPath);
            doUnlink(lockPath);
            print(`pi2 daemon (pid ${lock.pid}) stopped`);
            return 0;
        }
        if (err.code === "EPERM") {
            throw new CliError(`failed to stop pi2 daemon (pid ${lock.pid}): permission denied`);
        }
        throw new CliError(`failed to stop pi2 daemon (pid ${lock.pid}): ${errorMessage(error)}`);
    }

    const pollIntervalMs = 50;
    const deadline = nowFn() + timeoutMs;
    let exited = false;

    while (nowFn() < deadline) {
        if (!checkAlive(lock.pid)) {
            exited = true;
            break;
        }
        await sleepFn(Math.min(pollIntervalMs, Math.max(1, deadline - nowFn())));
    }

    if (!exited && !checkAlive(lock.pid)) {
        exited = true;
    }

    if (exited) {
        doUnlink(daemonJsonPath);
        doUnlink(lockPath);
        print(`pi2 daemon (pid ${lock.pid}) stopped`);
        return 0;
    }

    if (options.force === true) {
        try {
            killFn(lock.pid, "SIGKILL");
        } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code !== "ESRCH") {
                if (err.code === "EPERM") {
                    throw new CliError(`failed to kill pi2 daemon (pid ${lock.pid}): permission denied`);
                }
                throw new CliError(`failed to kill pi2 daemon (pid ${lock.pid}): ${errorMessage(error)}`);
            }
        }

        const killDeadline = nowFn() + 1000;
        while (nowFn() < killDeadline) {
            if (!checkAlive(lock.pid)) {
                exited = true;
                break;
            }
            await sleepFn(50);
        }

        if (!exited && !checkAlive(lock.pid)) {
            exited = true;
        }

        if (!exited) {
            throw new CliError(`pi2 daemon (pid ${lock.pid}) could not be killed with SIGKILL`);
        }

        doUnlink(daemonJsonPath);
        doUnlink(lockPath);
        print(`pi2 daemon (pid ${lock.pid}) killed with SIGKILL`);
        return 0;
    }

    throw new CliError(`pi2 daemon (pid ${lock.pid}) did not stop within ${timeoutSec}s; use --force to kill`);
}
