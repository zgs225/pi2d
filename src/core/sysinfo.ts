/**
 * Host sysinfo sampler — CPU / memory / disk with injectable I/O.
 * Zero runtime dependencies; no OS calls at import time.
 */
import { statfs as nodeStatfs } from "node:fs/promises";
import * as nodeOs from "node:os";
import { readFile as nodeReadFile } from "node:fs/promises";
import { stateDir } from "./paths.js";

/* ------------------------------------------------------------------ */
/* Public types                                                         */
/* ------------------------------------------------------------------ */

export interface CpuTimes {
    idle: number;
    total: number;
}

export interface StatFsLike {
    bsize: number;
    blocks: number;
    bfree: number;
}

export interface SystemStats {
    sampledAt: number;
    cpuPercent: number | null;
    cpuCores: number;
    loadAvg: [number, number, number] | null;
    memUsedBytes: number;
    memTotalBytes: number;
    memPercent: number;
    diskPath: string;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
    diskPercent: number | null;
}

export interface SysinfoSampler {
    sample(): Promise<SystemStats>;
}

export interface SysinfoDeps {
    now?: () => number;
    readFile?: (path: string) => Promise<string>;
    statfs?: (path: string) => Promise<StatFsLike>;
    cpus?: () => Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>;
    totalmem?: () => number;
    freemem?: () => number;
    loadavg?: () => number[];
    platform?: NodeJS.Platform;
    diskPath?: string;
    cacheMs?: number;
}

/* ------------------------------------------------------------------ */
/* Pure parsing helpers (exported for tests)                           */
/* ------------------------------------------------------------------ */

/**
 * Parse /proc/meminfo text.
 * Tries MemAvailable; falls back to MemFree + Buffers + Cached.
 */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
    const kbOf = (label: string): number | null => {
        const m = new RegExp(`^${label}:\\s+(\\d+)\\s+kB`, "m").exec(text);
        return m ? Number(m[1]) * 1024 : null;
    };
    const total = kbOf("MemTotal");
    if (total === null) return null;

    let available = kbOf("MemAvailable");
    if (available === null) {
        const free = kbOf("MemFree");
        const buffers = kbOf("Buffers") ?? 0;
        const cached = kbOf("Cached") ?? 0;
        if (free === null) return null;
        available = free + buffers + cached;
    }
    return { totalBytes: total, availableBytes: available };
}

/**
 * Parse the aggregate `cpu ` line from /proc/stat.
 * Returns cumulative idle and total jiffies.
 */
export function parseProcStat(text: string): CpuTimes | null {
    const m = /^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(text);
    if (!m) return null;
    const [, user, nice, sys, idle, iowait, irq, softirq] = m.map(Number);
    const idleTime = idle! + iowait!;
    const total = user! + nice! + sys! + idle! + iowait! + irq! + softirq!;
    return { idle: idleTime, total };
}

/** Aggregate os.cpus() array into CpuTimes. */
export function cpuTimesFromCpus(
    cpus: Array<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>,
): CpuTimes {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
        const t = cpu.times;
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
}

/**
 * Derive CPU busy % from two successive CpuTimes snapshots.
 * Returns null on the first sample (prev === null) or when the delta is zero.
 */
export function cpuPercentBetween(prev: CpuTimes | null, next: CpuTimes): number | null {
    if (prev === null) return null;
    const totalDelta = next.total - prev.total;
    if (totalDelta <= 0) return null;
    const idleDelta = next.idle - prev.idle;
    const busy = 1 - idleDelta / totalDelta;
    return Math.min(100, Math.max(0, Math.round(busy * 100)));
}

/**
 * Derive disk usage from a statfs result.
 * Returns null if blocks is 0 (pseudo-fs like tmpfs without a block count).
 */
export function diskFromStatfs(stats: StatFsLike): { totalBytes: number; usedBytes: number; percent: number } | null {
    const { bsize, blocks, bfree } = stats;
    if (![bsize, blocks, bfree].every((value) => Number.isFinite(value) && value >= 0)) return null;
    if (blocks <= 0 || bsize <= 0) return null;
    const totalBytes = blocks * bsize;
    if (!Number.isFinite(totalBytes)) return null;
    const rawUsedBytes = (blocks - bfree) * bsize;
    const usedBytes = Math.min(totalBytes, Math.max(0, Number.isFinite(rawUsedBytes) ? rawUsedBytes : 0));
    const percent = Math.min(100, Math.max(0, Math.round((usedBytes / totalBytes) * 100)));
    return { totalBytes, usedBytes, percent };
}

/* ------------------------------------------------------------------ */
/* Sampler factory                                                      */
/* ------------------------------------------------------------------ */

export function createSysinfo(deps: SysinfoDeps = {}): SysinfoSampler {
    const now = deps.now ?? Date.now;
    const cacheMs = deps.cacheMs ?? 1000;
    const platform = deps.platform ?? process.platform;
    const diskPath = deps.diskPath ?? stateDir();

    // I/O callables — real by default, injectable for tests
    const readFile = deps.readFile ?? ((path: string) => nodeReadFile(path, "utf8"));
    const statfsImpl = deps.statfs ?? ((path: string) => nodeStatfs(path) as Promise<StatFsLike>);
    const cpus = deps.cpus ?? (() => nodeOs.cpus());
    const totalmem = deps.totalmem ?? (() => nodeOs.totalmem());
    const freemem = deps.freemem ?? (() => nodeOs.freemem());
    const loadavg = deps.loadavg ?? (() => nodeOs.loadavg());

    let prevCpuTimes: CpuTimes | null = null;
    let cachedResult: SystemStats | null = null;
    let cachedAt = -Infinity;
    let inFlight: Promise<SystemStats> | null = null;

    async function doSample(): Promise<SystemStats> {
        const sampledAt = now();

        // ── CPU ──────────────────────────────────────────────────────
        let nextCpuTimes: CpuTimes | null = null;
        if (platform === "linux") {
            try {
                const text = await readFile("/proc/stat");
                nextCpuTimes = parseProcStat(text);
            } catch {
                // fall through to os.cpus()
            }
        }
        if (nextCpuTimes === null) {
            try {
                nextCpuTimes = cpuTimesFromCpus(cpus());
            } catch {
                nextCpuTimes = null;
            }
        }
        const cpuPercent = nextCpuTimes !== null ? cpuPercentBetween(prevCpuTimes, nextCpuTimes) : null;
        if (nextCpuTimes !== null) prevCpuTimes = nextCpuTimes;

        let cpuCores = 1;
        try {
            cpuCores = Math.max(1, cpus().length);
        } catch {
            // keep 1
        }

        // ── loadAvg ──────────────────────────────────────────────────
        let loadAvgResult: [number, number, number] | null = null;
        if (platform !== "win32") {
            try {
                const raw = loadavg();
                if (raw.length >= 3) {
                    loadAvgResult = [
                        Math.round(raw[0]! * 100) / 100,
                        Math.round(raw[1]! * 100) / 100,
                        Math.round(raw[2]! * 100) / 100,
                    ];
                }
            } catch {
                loadAvgResult = null;
            }
        }

        // ── Memory ───────────────────────────────────────────────────
        let memTotalBytes: number;
        let memUsedBytes: number;
        let parsed: { totalBytes: number; availableBytes: number } | null = null;
        if (platform === "linux") {
            try {
                const text = await readFile("/proc/meminfo");
                parsed = parseMeminfo(text);
            } catch {
                // fall through to os
            }
        }
        if (parsed !== null && Number.isFinite(parsed.totalBytes) && parsed.totalBytes >= 0 &&
            Number.isFinite(parsed.availableBytes) && parsed.availableBytes >= 0) {
            memTotalBytes = parsed.totalBytes;
            memUsedBytes = parsed.totalBytes - parsed.availableBytes;
        } else {
            let rawTotal = 0;
            let rawFree = 0;
            try {
                rawTotal = totalmem();
            } catch {
                // leave the total at zero
            }
            try {
                rawFree = freemem();
            } catch {
                // leave free memory at zero
            }
            memTotalBytes = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : 0;
            const freeBytes = Number.isFinite(rawFree) && rawFree >= 0 ? rawFree : 0;
            memUsedBytes = memTotalBytes - freeBytes;
        }
        memUsedBytes = Math.min(memTotalBytes, Math.max(0, Number.isFinite(memUsedBytes) ? memUsedBytes : 0));
        const memPercent = memTotalBytes > 0
            ? Math.min(100, Math.max(0, Math.round((memUsedBytes / memTotalBytes) * 100)))
            : 0;

        // ── Disk ─────────────────────────────────────────────────────
        let diskUsedBytes: number | null = null;
        let diskTotalBytes: number | null = null;
        let diskPercent: number | null = null;
        try {
            const sf = await statfsImpl(diskPath);
            const result = diskFromStatfs(sf);
            if (result !== null) {
                diskUsedBytes = result.usedBytes;
                diskTotalBytes = result.totalBytes;
                diskPercent = result.percent;
            }
        } catch {
            // leave nulls
        }

        return {
            sampledAt,
            cpuPercent,
            cpuCores,
            loadAvg: loadAvgResult,
            memUsedBytes,
            memTotalBytes,
            memPercent,
            diskPath,
            diskUsedBytes,
            diskTotalBytes,
            diskPercent,
        };
    }

    return {
        async sample(): Promise<SystemStats> {
            const t = now();
            if (cachedResult !== null && t - cachedAt < cacheMs) {
                return cachedResult;
            }
            if (inFlight) return inFlight;
            inFlight = doSample().then(
                (result) => {
                    cachedResult = result;
                    cachedAt = now();
                    inFlight = null;
                    return result;
                },
                (err) => {
                    inFlight = null;
                    // should never throw, but just in case
                    throw err;
                },
            );
            return inFlight;
        },
    };
}
