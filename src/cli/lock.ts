/**
 * Daemon singleton lock (`<runtime>/daemon.lock`) and discovery file
 * (`<runtime>/daemon.json`).
 *
 * Both files carry the same payload:
 *
 * ```jsonc
 * {"pid":1234,"bootId":"…","port":7676,"daemonId":"d-…","startedAt":1733,"protocolVersion":1}
 * ```
 *
 * The lock is created with `wx` (atomic: only one daemon wins) and is
 * considered **stale** when the pid is gone or the recorded boot id differs
 * from the current one (pid reuse after a reboot). `--force` ignores a live
 * lock. `daemon.json` is written after `listen()` so other tools can find the
 * actual port without parsing arguments.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { daemonLockPath, ensureDir, runtimeDir } from "../core/paths.js";

export const LOCK_FILE = "daemon.lock";
export const DAEMON_JSON_FILE = "daemon.json";

export interface DaemonLock {
    pid: number;
    bootId: string;
    port: number;
    daemonId: string;
    startedAt: number;
    protocolVersion: number;
}

export type LockErrorCode = "E_LOCKED";

export class LockError extends Error {
    readonly code: LockErrorCode;
    readonly holder: DaemonLock | undefined;

    constructor(code: LockErrorCode, message: string, holder?: DaemonLock) {
        super(message);
        this.name = "LockError";
        this.code = code;
        this.holder = holder;
    }
}

export const defaultLockPath = (): string => join(runtimeDir(), LOCK_FILE);
export const defaultDaemonJsonPath = (): string => join(runtimeDir(), DAEMON_JSON_FILE);

/** Linux boot id; on macOS the boottime; otherwise a stable placeholder. */
export function readBootId(): string {
    try {
        const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        if (value !== "") return value;
    } catch {
        // not Linux
    }
    if (process.platform === "darwin") {
        try {
            const value = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
            if (value !== "") return value;
        } catch {
            // sysctl missing
        }
    }
    return "unknown";
}

export function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM means the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function isLock(value: unknown): value is DaemonLock {
    if (typeof value !== "object" || value === null) return false;
    const candidate = value as Partial<DaemonLock>;
    return (
        typeof candidate.pid === "number" &&
        Number.isInteger(candidate.pid) &&
        candidate.pid > 0 &&
        typeof candidate.bootId === "string" &&
        typeof candidate.port === "number" &&
        typeof candidate.daemonId === "string" &&
        candidate.daemonId !== "" &&
        typeof candidate.startedAt === "number" &&
        typeof candidate.protocolVersion === "number"
    );
}

/** Parse a lock/daemon.json file; `undefined` when absent or malformed. */
export function parseDaemonFile(raw: string): DaemonLock | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    return isLock(parsed) ? parsed : undefined;
}

export function readLockFile(path: string = defaultLockPath()): DaemonLock | undefined {
    if (!existsSync(path)) return undefined;
    try {
        return parseDaemonFile(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }
}

export function readDaemonJson(path: string = defaultDaemonJsonPath()): DaemonLock | undefined {
    return readLockFile(path);
}

export interface StalenessOptions {
    isPidAlive?: (pid: number) => boolean;
    bootId?: () => string;
}

export interface Staleness {
    live: boolean;
    reason: "alive" | "no-pid" | "boot-changed";
}

/** A lock is live only when the pid still exists *and* we are on the same boot. */
export function assessLock(lock: DaemonLock, options: StalenessOptions = {}): Staleness {
    const alive = (options.isPidAlive ?? isPidAlive)(lock.pid);
    if (!alive) return { live: false, reason: "no-pid" };
    const bootId = (options.bootId ?? readBootId)();
    if (bootId !== "unknown" && lock.bootId !== "unknown" && bootId !== lock.bootId) {
        return { live: false, reason: "boot-changed" };
    }
    return { live: true, reason: "alive" };
}

function writeAtomic(path: string, payload: DaemonLock, mode = 0o600): void {
    ensureDir(dirname(path));
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode });
    renameSync(temporary, path);
}

export interface AcquireLockOptions {
    lockPath?: string;
    force?: boolean;
    /** `pid` defaults to the current process. */
    payload: Omit<DaemonLock, "pid" | "bootId"> & { pid?: number; bootId?: string };
    isPidAlive?: (pid: number) => boolean;
    bootId?: () => string;
}

export interface DaemonLockHandle {
    readonly path: string;
    readonly lock: DaemonLock;
    /** Rewrite the lock in place (e.g. once the real port is known). */
    update(patch: Partial<DaemonLock>): DaemonLock;
    /** Remove the lock (and `daemon.json`) when we still own them. */
    release(): void;
}

export function acquireLock(options: AcquireLockOptions): DaemonLockHandle {
    const path = options.lockPath ?? daemonLockPath();
    ensureDir(dirname(path));
    const bootId = options.payload.bootId ?? (options.bootId ?? readBootId)();
    const candidate: DaemonLock = {
        ...options.payload,
        pid: options.payload.pid ?? process.pid,
        bootId,
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            writeFileSync(path, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx", mode: 0o600 });
            return makeHandle(path, candidate);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }

        const holder = readLockFile(path);
        if (holder !== undefined) {
            const staleness = assessLock(holder, {
                ...(options.isPidAlive === undefined ? {} : { isPidAlive: options.isPidAlive }),
                bootId: () => bootId,
            });
            if (staleness.live && options.force !== true) {
                throw new LockError(
                    "E_LOCKED",
                    `another pi2d is running (pid ${holder.pid}, port ${holder.port}); use --force to override`,
                    holder,
                );
            }
        }
        // Stale, forced, or unreadable (a half-written lock from a crash).
        try {
            unlinkSync(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }

    throw new LockError("E_LOCKED", `could not acquire ${path}: another pi2d keeps re-creating it`);
}

function makeHandle(path: string, initial: DaemonLock): DaemonLockHandle {
    let current = initial;
    return {
        path,
        get lock(): DaemonLock {
            return current;
        },
        update(patch: Partial<DaemonLock>): DaemonLock {
            current = { ...current, ...patch };
            writeAtomic(path, current);
            return current;
        },
        release(): void {
            const onDisk = readLockFile(path);
            if (onDisk === undefined || (onDisk.pid === current.pid && onDisk.daemonId === current.daemonId)) {
                try {
                    unlinkSync(path);
                } catch {
                    // already gone
                }
            }
            // A stale daemon.json would point tools at a dead port.
            const daemonJsonPath = join(dirname(path), DAEMON_JSON_FILE);
            const discovery = readLockFile(daemonJsonPath);
            if (discovery !== undefined && discovery.daemonId === current.daemonId) {
                try {
                    unlinkSync(daemonJsonPath);
                } catch {
                    // already gone
                }
            }
        },
    };
}

export function writeDaemonJson(payload: DaemonLock, path: string = defaultDaemonJsonPath()): string {
    writeAtomic(path, payload);
    return path;
}
