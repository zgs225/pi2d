import { describe, expect, it } from "vitest";
import {
    cpuPercentBetween,
    cpuTimesFromCpus,
    createSysinfo,
    diskFromStatfs,
    parseMeminfo,
    parseProcStat,
} from "../../src/core/sysinfo.js";

const mem = (available = "MemAvailable:       512 kB") => `MemTotal: 1024 kB\n${available}\nMemFree: 128 kB\nBuffers: 64 kB\nCached: 128 kB\n`;
const cpus = (user: number, idle: number) => [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }];

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
            readFile: async (path) => { reads++; return path === "/proc/stat" ? "cpu 10 0 0 10 0 0 0" : mem(); },
            statfs: async () => { stats++; return { bsize: 100, blocks: 10, bfree: 4 }; },
            cpus: () => cpus(10, 10),
            totalmem: () => 999,
            freemem: () => 1,
            loadavg: () => [1.234, 2.345, 3.456],
            cacheMs: 100,
        });
        const first = await sampler.sample();
        expect(first).toEqual({ sampledAt: 1000, cpuPercent: null, cpuCores: 1, loadAvg: [1.23, 2.35, 3.46], memUsedBytes: 512 * 1024, memTotalBytes: 1024 * 1024, memPercent: 50, diskPath: "/test", diskUsedBytes: 600, diskTotalBytes: 1000, diskPercent: 60 });
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
            cpus: () => cpus(1, 1),
            totalmem: () => { throw new Error("totalmem unavailable"); },
            freemem: () => 25,
            statfs: async () => ({ bsize: 1, blocks: 1, bfree: 0 }),
            loadavg: () => [0, 0, 0],
        });
        await expect(sampler.sample()).resolves.toMatchObject({ memTotalBytes: 0, memUsedBytes: 0, memPercent: 0 });
    });

    it("falls back and resolves I/O failures with null CPU and disk", async () => {
        const result = await createSysinfo({
            now: () => 1,
            platform: "linux",
            readFile: async () => { throw new Error("read"); },
            statfs: async () => { throw new Error("statfs"); },
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
        expect(result.memTotalBytes).toBe(0);
        expect(result.memUsedBytes).toBe(0);
    });
});
