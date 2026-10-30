import { describe, expect, it } from "vitest";
import {
    cpuPercentBetween,
    cpuTimesFromCpus,
    createSysinfo,
    diskFromStatfs,
    fsTypeFromMagic,
    parseMeminfo,
    parseProcStat,
    probeMount,
} from "../../src/core/sysinfo.js";

const mem = (available = "MemAvailable:       512 kB") => `MemTotal: 1024 kB\n${available}\nMemFree: 128 kB\nBuffers: 64 kB\nCached: 128 kB\n`;
const cpus = (user: number, idle: number) => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }];

/** `path -> st_dev` fake: anything absent throws ENOENT, like a real stat. */
type FsTree = Record<string, number | bigint>;

function fakeStat(tree: FsTree) {
    return async (path: string) => {
        const dev = tree[path];
        if (dev === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
        return { dev };
    };
}

/** Every sampler call below injects `stat`+`statfs`, so no test touches the disk. */
const oneFs: FsTree = { "/": 1, "/pi/sessions": 1 };

describe("sysinfo", () => {
    it("parses meminfo using MemAvailable and fallback fields", () => {
        expect(parseMeminfo(mem())).toEqual({ totalBytes: 1024 * 1024, availableBytes: 512 * 1024 });
        expect(parseMeminfo(mem("MemFree: 128 kB"))).toEqual({ totalBytes: 1024 * 1024, availableBytes: 320 * 1024 });
        expect(parseMeminfo("MemAvailable: 1 kB")).toBeNull();
    });

    it("parses proc stat and aggregates cpu times", () => {
        expect(parseProcStat("cpu  10 2 3 40 5 6 7\ncpu0 1 0 0 1 0 0 0\n")).toEqual({ idle: 45, total: 73 });
        expect(cpuTimesFromCpus(cpus(10, 40))).toEqual({ idle: 40, total: 50 });
    });

    it("calculates bounded CPU percentages", () => {
        expect(cpuPercentBetween(null, { idle: 1, total: 2 })).toBeNull();
        expect(cpuPercentBetween({ idle: 1, total: 2 }, { idle: 1, total: 2 })).toBeNull();
        expect(cpuPercentBetween({ idle: 10, total: 20 }, { idle: 5, total: 10 })).toBeNull();
        expect(cpuPercentBetween({ idle: 10, total: 20 }, { idle: 15, total: 30 })).toBe(50);
        expect(cpuPercentBetween({ idle: 10, total: 20 }, { idle: 0, total: 30 })).toBe(100);
        expect(cpuPercentBetween({ idle: 10, total: 20 }, { idle: 30, total: 30 })).toBe(0);
    });

    it("calculates disk usage and handles null cases", () => {
        expect(diskFromStatfs({ bsize: 100, blocks: 10, bfree: 4 })).toEqual({ totalBytes: 1000, usedBytes: 600, percent: 60 });
        expect(diskFromStatfs({ bsize: 100, blocks: 0, bfree: 0 })).toBeNull();
        expect(diskFromStatfs({ bsize: 0, blocks: 10, bfree: 0 })).toBeNull();
        expect(diskFromStatfs({ bsize: Number.NaN, blocks: 10, bfree: 0 })).toBeNull();
        expect(diskFromStatfs({ bsize: 100, blocks: 10, bfree: 20 })).toEqual({
            totalBytes: 1000,
            usedBytes: 0,
            percent: 0,
        });
        expect(diskFromStatfs({ bsize: 100, blocks: 10, bfree: -1 })).toBeNull();
    });

    it("clamps malformed memory sampler values", async () => {
        const result = await createSysinfo({
            now: () => 1,
            platform: "darwin",
            diskPath: "/",
            sessionsPath: "/pi/sessions",
            stat: fakeStat(oneFs),
            cpus: () => cpus(10, 10),
            totalmem: () => Number.NaN,
            freemem: () => Number.POSITIVE_INFINITY,
            loadavg: () => [0, 0, 0],
            statfs: async () => ({ bsize: 100, blocks: 10, bfree: 20 }),
        }).sample();
        expect(result.memTotalBytes).toBe(0);
        expect(result.memUsedBytes).toBe(0);
        expect(result.memPercent).toBe(0);
        expect(result.diskPercent).toBe(0);
    });

    it("samples injected system data, caches, and expires", async () => {
        let clock = 1000;
        let reads = 0;
        let stats = 0;
        const sampler = createSysinfo({
            now: () => clock,
            platform: "linux",
            diskPath: "/test",
            sessionsPath: "/pi/sessions",
            // `/test` does not exist: the probe must land on the root filesystem
            // instead of blanking the tile (the shipped bug).
            stat: fakeStat(oneFs),
            uptime: () => 4321.6,
            readFile: async (path) => { reads++; return path === "/proc/stat" ? "cpu 10 0 0 10 0 0 0" : mem(); },
            statfs: async () => { stats++; return { bsize: 100, blocks: 10, bfree: 4, type: 0xef53 }; },
            cpus: () => cpus(10, 10),
            totalmem: () => 999,
            freemem: () => 1,
            loadavg: () => [1.234, 2.345, 3.456],
            cacheMs: 100,
        });
        const first = await sampler.sample();
        expect(first).toEqual({
            sampledAt: 1000,
            hostUptimeSec: 4322,
            cpuPercent: null,
            cpuCores: 1,
            loadAvg: [1.23, 2.35, 3.46],
            memUsedBytes: 512 * 1024,
            memTotalBytes: 1024 * 1024,
            memPercent: 50,
            diskPath: "/",
            diskUsedBytes: 600,
            diskTotalBytes: 1000,
            diskPercent: 60,
            disks: [{ mountPoint: "/", fsType: "ext4", totalBytes: 1000, usedBytes: 600, percent: 60 }],
        });
        await sampler.sample();
        expect(reads).toBe(2);
        expect(stats).toBe(1);
        clock = 1100;
        await sampler.sample();
        expect(reads).toBe(4);
        expect(stats).toBe(2);
    });

    it("resolves when total memory probing throws", async () => {
        const sampler = createSysinfo({
            platform: "darwin",
            diskPath: "/",
            sessionsPath: "/pi/sessions",
            stat: fakeStat(oneFs),
            cpus: () => cpus(1, 1),
            totalmem: () => { throw new Error("totalmem unavailable"); },
            freemem: () => 25,
            statfs: async () => ({ bsize: 1, blocks: 1, bfree: 0 }),
            loadavg: () => [0, 0, 0],
        });
        await expect(sampler.sample()).resolves.toMatchObject({ memTotalBytes: 0, memUsedBytes: 0, memPercent: 0 });
    });

    it("reports a host uptime independently of the daemon's own age", async () => {
        const result = await createSysinfo({
            platform: "linux",
            diskPath: "/",
            sessionsPath: "/pi/sessions",
            stat: fakeStat(oneFs),
            statfs: async () => ({ bsize: 100, blocks: 10, bfree: 4 }),
            uptime: () => 5 * 86_400 + 3 * 3_600,
            cpus: () => cpus(1, 1),
            totalmem: () => 1,
            freemem: () => 0,
            loadavg: () => [0, 0, 0],
        }).sample();
        expect(result.hostUptimeSec).toBe(442_800);
    });

    it("nulls a host uptime the OS cannot report", async () => {
        const base = {
            platform: "linux" as const,
            diskPath: "/",
            sessionsPath: "/pi/sessions",
            stat: fakeStat(oneFs),
            statfs: async () => ({ bsize: 100, blocks: 10, bfree: 4 }),
            cpus: () => cpus(1, 1),
            totalmem: () => 1,
            freemem: () => 0,
            loadavg: () => [0, 0, 0],
        };
        for (const uptime of [() => Number.NaN, () => -1, () => Number.POSITIVE_INFINITY, () => { throw new Error("no uptime"); }]) {
            await expect(createSysinfo({ ...base, uptime }).sample()).resolves.toMatchObject({ hostUptimeSec: null });
        }
    });

    it("reports a diskError instead of silent nulls when nothing can be sampled", async () => {
        const result = await createSysinfo({
            now: () => 1,
            platform: "linux",
            diskPath: "/test",
            sessionsPath: "/pi/sessions",
            readFile: async () => { throw new Error("read"); },
            stat: fakeStat(oneFs),
            statfs: async () => { throw Object.assign(new Error("statfs"), { code: "ENOENT" }); },
            cpus: () => { throw new Error("cpu"); },
            totalmem: () => 0,
            freemem: () => 0,
            loadavg: () => { throw new Error("load"); },
        }).sample();
        expect(result.cpuPercent).toBeNull();
        expect(result.loadAvg).toBeNull();
        expect(result.diskUsedBytes).toBeNull();
        expect(result.diskTotalBytes).toBeNull();
        expect(result.diskPercent).toBeNull();
        expect(result.disks).toEqual([]);
        expect(result.diskError).toBe("/: ENOENT");
        expect(result.diskPath).toBe("/test");
        expect(result.memTotalBytes).toBe(0);
        expect(result.memUsedBytes).toBe(0);
    });
});

describe("disk probes", () => {
    it("walks up to the nearest existing ancestor", async () => {
        const tree: FsTree = { "/": 10, "/home": 20, "/home/u": 20 };
        await expect(probeMount("/home/u/project", fakeStat(tree))).resolves.toEqual({
            path: "/home/u",
            mountPoint: "/home",
            dev: "20",
        });
        // Nothing exists → null, not a throw.
        await expect(probeMount("/nope", fakeStat({}))).resolves.toBeNull();
    });

    it("stops at the filesystem boundary, not at the root", async () => {
        const tree: FsTree = { "/": 1, "/mnt": 1, "/mnt/data": 2, "/mnt/data/ws": 2 };
        await expect(probeMount("/mnt/data/ws/x", fakeStat(tree))).resolves.toMatchObject({ mountPoint: "/mnt/data" });
        await expect(probeMount("/mnt/data/ws/x", fakeStat(tree))).resolves.toMatchObject({ dev: "2" });
        await expect(probeMount("/usr/lib", fakeStat(tree))).resolves.toMatchObject({ mountPoint: "/" });
    });

    it("labels known filesystem magics only", () => {
        expect(fsTypeFromMagic(0xef53)).toBe("ext4");
        expect(fsTypeFromMagic(0x9123683e)).toBe("btrfs");
        expect(fsTypeFromMagic(0xdeadbeef)).toBeUndefined();
        expect(fsTypeFromMagic(undefined)).toBeUndefined();
        expect(fsTypeFromMagic(Number.NaN)).toBeUndefined();
    });

    it("dedupes by st_dev and reports the most constrained disk first", async () => {
        const tree: FsTree = { "/": 1, "/pi/sessions": 1, "/home": 2, "/mnt/data": 3 };
        const seen: string[] = [];
        const result = await createSysinfo({
            platform: "linux",
            diskPath: "/",
            sessionsPath: "/pi/sessions",
            // Three workspace roots, two of them on the same filesystem as /home.
            diskPaths: () => ["/home/a/one", "/home/a/two", "/mnt/data/ws"],
            stat: fakeStat(tree),
            statfs: async (path) => {
                seen.push(path);
                const freeBlocks = path === "/" ? 40 : path === "/home" ? 5 : 75;
                return { bsize: 100, blocks: 100, bfree: freeBlocks, type: 0xef53 };
            },
            cpus: () => cpus(1, 1),
            totalmem: () => 1,
            freemem: () => 0,
            loadavg: () => [0, 0, 0],
        }).sample();

        // One statfs per distinct filesystem: /home/a/one and /home/a/two collapsed.
        expect(seen.sort()).toEqual(["/", "/home", "/mnt/data"]);
        expect(result.disks.map((disk) => disk.mountPoint)).toEqual(["/home", "/", "/mnt/data"]);
        expect(result.disks.map((disk) => disk.percent)).toEqual([95, 60, 25]);
        // Legacy scalars alias the worst row.
        expect(result.diskPath).toBe("/home");
        expect(result.diskPercent).toBe(95);
        expect(result.diskError).toBeUndefined();
    });

    it("caps the filesystem list", async () => {
        const tree: FsTree = { "/": 1, "/pi/sessions": 1 };
        for (let i = 0; i < 6; i += 1) tree[`/vol${i}`] = 10 + i;
        const result = await createSysinfo({
            platform: "linux",
            diskPath: "/",
            sessionsPath: "/pi/sessions",
            diskPaths: () => [0, 1, 2, 3, 4, 5].map((i) => `/vol${i}/ws`),
            stat: fakeStat(tree),
            statfs: async () => ({ bsize: 100, blocks: 100, bfree: 5000 }),
            cpus: () => cpus(1, 1),
            totalmem: () => 1,
            freemem: () => 0,
            loadavg: () => [0, 0, 0],
        }).sample();
        expect(result.disks).toHaveLength(4);
    });
});
