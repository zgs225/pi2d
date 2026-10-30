/**
 * Host sysinfo sampler — CPU / memory / disk with injectable I/O.
 * Zero runtime dependencies; no OS calls at import time.
 */
import { stat as nodeStat, statfs as nodeStatfs } from "node:fs/promises";
import * as nodeOs from "node:os";
import { readFile as nodeReadFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { IS_MAC, sessionsRoot, stateDir } from "./paths.js";

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
    /** Linux filesystem magic (`f_type`); used for the best-effort `fsType` label. */
    type?: number;
}

/** The slice of `fs.Stats` the mount probe needs. */
export interface StatLike {
    dev: number | bigint;
}

/**
 * One sampled filesystem. `mountPoint` is the boundary the probe found by
 * walking up while `st_dev` stayed the same — never the raw candidate path,
 * which is usually a deep, user-irrelevant directory.
 */
export interface DiskUsage {
    mountPoint: string;
    /** Best-effort type label (`ext4`, `btrfs`, …); absent when unknown. */
    fsType?: string;
    totalBytes: number;
    usedBytes: number;
    percent: number;
}

export interface SystemStats {
    sampledAt: number;
    /** Host uptime in whole seconds (`os.uptime()`), `null` when the OS has none. */
    hostUptimeSec: number | null;
    cpuPercent: number | null;
    cpuCores: number;
    loadAvg: [number, number, number] | null;
    memUsedBytes: number;
    memTotalBytes: number;
    memPercent: number;
    /** Mount point of the most constrained disk (`disks[0]`); legacy scalar fields alias it. */
    diskPath: string;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
    diskPercent: number | null;
    /** At most `maxDisks` filesystems, most constrained first. */
    disks: DiskUsage[];
    /** Why no filesystem could be sampled; absent when `disks` is non-empty. */
    diskError?: string;
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
    uptime?: () => number;
    loadavg?: () => number[];
    platform?: NodeJS.Platform;
    /** Primary disk candidate; defaults to `/` (the home volume on macOS). */
    diskPath?: string;
    /** Where pi keeps its sessions; sampled as a second candidate. Defaults to `sessionsRoot()`. */
    sessionsPath?: string;
    /** Extra candidates sampled per request (e.g. the visible workspace roots). */
    diskPaths?: () => string[];
    /** Whether two paths share a filesystem; injectable so tests never touch the disk. */
    stat?: (path: string) => Promise<StatLike>;
    /** How many filesystems to report; defaults to 4. */
    maxDisks?: number;
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

/** Linux `f_type` magics → a short label. Best effort: unknown magics stay unlabelled. */
const FS_MAGIC: Readonly<Record<number, string>> = {
    0x01_02_19_94: "tmpfs",
    0x2f_c1_2f_c1: "zfs",
    0x41_50_46_53: "apfs",
    0x4d_44: "vfat",
    0x69_69: "nfs",
    0x96_60: "iso9660",
    0xef_53: "ext4",
    0x20_11_ba_b0: "exfat",
    0x53_46_54_4e: "ntfs",
    0x58_46_53_42: "xfs",
    0x73_71_73_68: "squashfs",
    0x79_4c_76_30: "overlay",
    0x91_23_68_3e: "btrfs",
    0xf2_f5_20_10: "f2fs",
    0xff_53_4d_42: "cifs",
};

/** Best-effort filesystem label from a `statfs.type` magic number. */
export function fsTypeFromMagic(magic: number | undefined): string | undefined {
    if (magic === undefined || !Number.isFinite(magic)) return undefined;
    return FS_MAGIC[magic];
}

export interface MountProbe {
    /** Deepest existing ancestor of the candidate (what `statfs` may be called on). */
    path: string;
    /** Filesystem boundary above `path`; the user-facing label. */
    mountPoint: string;
    /** `st_dev` identity, stringified — the dedupe key. */
    dev: string;
}

/**
 * Resolve a candidate path to the filesystem that backs it.
 *
 * 1. Walk up until `stat` succeeds — `statfs` fails with `ENOENT` on a directory
 *    that does not exist yet (pi2d's state dir is created lazily), which used to
 *    null out the whole disk tile.
 * 2. Keep walking up while the parent reports the same `st_dev`; the last dir
 *    that shares it is the mount point.
 *
 * Returns `null` when no ancestor exists (the path is on an unmounted tree).
 */
export async function probeMount(
    candidate: string,
    stat: (path: string) => Promise<StatLike>,
): Promise<MountProbe | null> {
    let path = resolvePath(candidate);
    let dev: string | null = null;
    for (;;) {
        try {
            dev = String((await stat(path)).dev);
            break;
        } catch {
            const parent = dirname(path);
            if (parent === path) return null;
            path = parent;
        }
    }
    let mountPoint = path;
    for (;;) {
        const parent = dirname(mountPoint);
        if (parent === mountPoint) break;
        try {
            if (String((await stat(parent)).dev) !== dev) break;
        } catch {
            break;
        }
        mountPoint = parent;
    }
    return { path, mountPoint, dev };
}

function describeError(path: string, err: unknown): string {
    const code =
        typeof err === "object" && err !== null && "code" in err
            ? String((err as { code?: unknown }).code)
            : err instanceof Error
              ? err.message
              : String(err);
    return `${path}: ${code}`;
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
    // `/` on macOS is the sealed read-only system volume, which reports ~100%
    // used forever; the home volume is the honest "system disk" answer there.
    const diskPath = deps.diskPath ?? (platform === "darwin" ? nodeOs.homedir() : platform === "win32" ? stateDir() : "/");
    const maxDisks = Math.max(1, deps.maxDisks ?? 4);
    const sessionsPath = deps.sessionsPath ?? sessionsRoot();
    const extraDiskPaths = deps.diskPaths ?? (() => []);

    // I/O callables — real by default, injectable for tests
    const readFile = deps.readFile ?? ((path: string) => nodeReadFile(path, "utf8"));
    const statfsImpl = deps.statfs ?? ((path: string) => nodeStatfs(path) as Promise<StatFsLike>);
    const statImpl = deps.stat ?? ((path: string) => nodeStat(path) as Promise<StatLike>);
    const cpus = deps.cpus ?? (() => nodeOs.cpus());
    const totalmem = deps.totalmem ?? (() => nodeOs.totalmem());
    const freemem = deps.freemem ?? (() => nodeOs.freemem());
    const uptime = deps.uptime ?? (() => nodeOs.uptime());
    const loadavg = deps.loadavg ?? (() => nodeOs.loadavg());

    /**
     * Sample one row per distinct filesystem. Candidates are pi2d's own write
     * targets (root, the pi session store, the visible workspace roots), never
     * an enumeration of `/proc/mounts`: `statfs` on an unrelated, hung network
     * mount would otherwise stall the whole sample.
     */
    async function sampleDisks(): Promise<{ disks: DiskUsage[]; error?: string }> {
        const extra = (() => {
            try {
                return extraDiskPaths();
            } catch {
                return [];
            }
        })();
        const candidates = [diskPath, sessionsPath, ...extra]
            .filter((path, index, all) => typeof path === "string" && path !== "" && all.indexOf(path) === index)
            .slice(0, maxDisks * 2);

        const probes = new Map<string, MountProbe>();
        const failures: string[] = [];
        for (const candidate of candidates) {
            try {
                const probe = await probeMount(candidate, statImpl);
                if (probe === null) {
                    failures.push(`${candidate}: no existing ancestor`);
                    continue;
                }
                // Same `st_dev` ⇒ same filesystem ⇒ same row, whatever the path.
                if (!probes.has(probe.dev)) probes.set(probe.dev, probe);
            } catch (err) {
                failures.push(describeError(candidate, err));
            }
        }

        const disks: DiskUsage[] = [];
        for (const probe of probes.values()) {
            try {
                const sf = await statfsImpl(probe.mountPoint);
                const usage = diskFromStatfs(sf);
                if (usage === null) {
                    failures.push(`${probe.mountPoint}: no block count`);
                    continue;
                }
                const fsType = fsTypeFromMagic(sf.type);
                disks.push({
                    mountPoint: probe.mountPoint,
                    ...(fsType === undefined ? {} : { fsType }),
                    ...usage,
                });
            } catch (err) {
                failures.push(describeError(probe.mountPoint, err));
            }
        }

        // Worst first: the tile's headline number is the disk closest to full.
        disks.sort((a, b) => b.percent - a.percent || b.totalBytes - a.totalBytes);
        const capped = disks.slice(0, maxDisks);
        if (capped.length > 0) return { disks: capped };
        return { disks: [], error: failures[0] ?? "no filesystem could be sampled" };
    }

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

        // ── Host uptime ──────────────────────────────────────────────
        // The daemon's own process age lives on `/info.uptimeMs`; this is the
        // figure a user reads as "how long has this box been up".
        let hostUptimeSec: number | null = null;
        try {
            const raw = uptime();
            if (Number.isFinite(raw) && raw >= 0) hostUptimeSec = Math.round(raw);
        } catch {
            hostUptimeSec = null;
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
        const sampled = await sampleDisks();
        const worst = sampled.disks[0];
        const diskUsedBytes = worst?.usedBytes ?? null;
        const diskTotalBytes = worst?.totalBytes ?? null;
        const diskPercent = worst?.percent ?? null;
        const diskMount = worst?.mountPoint ?? diskPath;

        return {
            sampledAt,
            hostUptimeSec,
            cpuPercent,
            cpuCores,
            loadAvg: loadAvgResult,
            memUsedBytes,
            memTotalBytes,
            memPercent,
            diskPath: diskMount,
            diskUsedBytes,
            diskTotalBytes,
            diskPercent,
            disks: sampled.disks,
            ...(sampled.error === undefined ? {} : { diskError: sampled.error }),
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
