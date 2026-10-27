import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonSocketPath, daemonTokenPath, stateDir } from "../../src/core/paths.js";
import {
    createInstanceManager,
    parseProcRss,
    parsePsRss,
    summarizeResources,
    type InstanceManagerDeps,
    type InstanceManagerHandle,
} from "../../src/instances/supervisor.js";
import type { InstanceState } from "../../src/protocol/types.js";
import { makeSessionState } from "../daemon/fakes.js";
import {
    FakeBus,
    PluginClient,
    delay,
    makeHello,
    makeTempEnv,
    readRunLog,
    startRecords,
    waitFor,
    writeFakeNvim,
    type TempEnv,
} from "./helpers.js";

function asRecord(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

function isRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function processExits(bus: FakeBus): Record<string, unknown>[] {
    return bus.published.filter(
        (record) =>
            record.type === "event" && asRecord(asRecord(record.payload).event).type === "pi2:process_exit",
    );
}

describe("InstanceManager", () => {
    let env: TempEnv;
    let bus: FakeBus;
    let manager: InstanceManagerHandle | undefined;
    const workspaces = new Map<string, string>();

    beforeEach(() => {
        env = makeTempEnv();
        bus = new FakeBus();
        workspaces.clear();
    });

    afterEach(async () => {
        if (manager) await manager.close();
        manager = undefined;
        env.cleanup();
    });

    function addWorkspace(id = "ws-1"): string {
        const cwd = join(env.dir, "repo", id);
        mkdirSync(cwd, { recursive: true });
        workspaces.set(id, cwd);
        return cwd;
    }

    async function create(options: {
        bin?: string;
        deps?: Partial<InstanceManagerDeps>;
    } = {}): Promise<InstanceManagerHandle> {
        const instance = await createInstanceManager({
            bus,
            resolveCwd: (workspaceId) => workspaces.get(workspaceId),
            ensureTimeoutMs: 4_000,
            shutdownGraceMs: 300,
            sigtermGraceMs: 200,
            minSpawnIntervalMs: 300,
            maxSpawnIntervalMs: 1_000,
            ...(options.bin === undefined ? {} : { nvimBin: options.bin }),
            ...(options.deps ?? {}),
        });
        manager = instance;
        return instance;
    }

    it("spawns one nvim with the right argv/env and resolves with a ready state", async () => {
        const cwd = addWorkspace();
        const fake = writeFakeNvim(env.dir, { sessions: ["s1"] });
        const mgr = await create({ bin: fake.bin });

        const state = await mgr.ensure("ws-1");

        expect(state.status).toBe("ready");
        expect(state.instanceId).toMatch(/^i-fake-\d+$/);
        expect(state.pluginVersion).toBe("9.9.9-fake");
        expect(state.nvimPid).toBeGreaterThan(0);
        expect(state.hasUI).toBe(false);
        expect(state.attachedClients).toBe(0);
        expect(state.startedAt).toBeGreaterThan(0);
        expect(state.listenAddr).toMatch(/\/i\/[0-9a-f]{16}\.sock$/);
        expect(mgr.get("ws-1")?.instanceId).toBe(state.instanceId);

        const starts = startRecords(fake.runLog);
        expect(starts).toHaveLength(1);
        const start = starts[0]!;
        const argv = start.argv as string[];
        expect(argv.slice(0, 2)).toEqual(["--headless", "--listen"]);
        expect(argv[2]).toBe(state.listenAddr);
        expect(argv.slice(3)).toEqual(["-c", 'lua require("pi.host").start()']);
        expect(start.cwd).toBe(cwd);
        const spawnedEnv = start.env as Record<string, string>;
        expect(spawnedEnv.PI2_WORKSPACE_ID).toBe("ws-1");
        expect(spawnedEnv.PI2_RUNTIME_DIR).toBe(env.runtime);
        expect(spawnedEnv.PI2_DAEMON_SOCKET).toBe(daemonSocketPath());
        expect(spawnedEnv.PI2_DAEMON_TOKEN_PATH).toBe(daemonTokenPath());

        // Starting -> ready both surfaced on the bus.
        const statuses = bus.published
            .filter((record) => record.type === "instance_state" && record.workspaceId === "ws-1")
            .map((record) => asRecord(record.payload).status);
        expect(statuses).toContain("starting");
        expect(statuses).toContain("ready");
    });

    it("passes PI2_NVIM_INIT as -u only when configured", async () => {
        addWorkspace();
        const init = join(env.dir, "init.lua");
        const fake = writeFakeNvim(env.dir);
        const mgr = await create({ bin: fake.bin, deps: { nvimInit: init } });

        await mgr.ensure("ws-1");

        const argv = startRecords(fake.runLog)[0]?.argv as string[];
        expect(argv.slice(3, 5)).toEqual(["-u", init]);
        expect(argv.slice(5)).toEqual(["-c", 'lua require("pi.host").start()']);
    });

    it("is idempotent and reports state changes to handlers", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir);
        const mgr = await create({ bin: fake.bin });
        const seen: InstanceState[] = [];
        mgr.onInstanceChange((state) => seen.push(state));

        const first = await mgr.ensure("ws-1");
        const second = await mgr.ensure("ws-1");

        expect(second.instanceId).toBe(first.instanceId);
        expect(startRecords(fake.runLog)).toHaveLength(1);
        expect(seen.some((state) => state.status === "ready")).toBe(true);
    });

    it("lets concurrent ensure() calls share one spawn", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir);
        const mgr = await create({ bin: fake.bin });

        const states = await Promise.all([mgr.ensure("ws-1"), mgr.ensure("ws-1"), mgr.ensure("ws-1")]);

        expect(new Set(states.map((state) => state.instanceId)).size).toBe(1);
        expect(startRecords(fake.runLog)).toHaveLength(1);
    });

    it("adopts an already connected plugin instead of spawning", async () => {
        const cwd = addWorkspace();
        const fake = writeFakeNvim(env.dir);
        const mgr = await create({ bin: fake.bin });

        const plugin = await PluginClient.connect({
            socketPath: daemonSocketPath(),
            hello: makeHello({ instanceId: "i-adopt", workspaceId: "ws-1", cwd }),
        });
        await plugin.next("hello_ack");

        const state = await mgr.ensure("ws-1");
        expect(state.instanceId).toBe("i-adopt");
        expect(state.status).toBe("ready");
        expect(startRecords(fake.runLog)).toHaveLength(0);
        plugin.close();
    });

    it("times out a silent instance with E_INSTANCE_STARTING and kills it", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir, { mode: "no-hello" });
        const mgr = await create({ bin: fake.bin });

        await expect(mgr.ensure("ws-1", { timeoutMs: 1_000 })).rejects.toMatchObject({
            code: "E_INSTANCE_STARTING",
            retryable: true,
        });

        const starts = startRecords(fake.runLog);
        expect(starts).toHaveLength(1);
        const pid = starts[0]?.pid as number;
        await waitFor(() => !isRunning(pid), 3_000);
        expect(mgr.list().find((state) => state.workspaceId === "ws-1")?.status).toBe("stopped");
        // A failed start backs off the next attempt.
        await expect(mgr.ensure("ws-1")).rejects.toMatchObject({
            code: "E_INSTANCE_UNAVAILABLE",
            message: expect.stringContaining("backing off"),
        });
    });

    it("reports E_INSTANCE_UNAVAILABLE when the nvim binary cannot be spawned", async () => {
        addWorkspace();
        const mgr = await create({ deps: { nvimBin: join(env.dir, "no-such-nvim") } });

        await expect(mgr.ensure("ws-1")).rejects.toMatchObject({
            code: "E_INSTANCE_UNAVAILABLE",
            message: expect.stringContaining("failed to spawn"),
        });

        const logDir = join(stateDir(), "instances");
        await waitFor(() => {
            if (!existsSync(logDir)) return false;
            const logFile = readdirSync(logDir)[0];
            if (logFile === undefined) return false;
            return readFileSync(join(logDir, logFile), "utf8").includes("spawn error");
        });
    });

    it("backs off after a failed start, then succeeds on a later ensure", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir, { mode: "exit-first-run", failRuns: 1 });
        const mgr = await create({
            bin: fake.bin,
            deps: { minSpawnIntervalMs: 150, maxSpawnIntervalMs: 500 },
        });

        await expect(mgr.ensure("ws-1")).rejects.toMatchObject({ code: "E_INSTANCE_UNAVAILABLE" });
        expect(startRecords(fake.runLog)).toHaveLength(1);

        const started = Date.now();
        await expect(mgr.ensure("ws-1")).rejects.toMatchObject({
            code: "E_INSTANCE_UNAVAILABLE",
            message: expect.stringContaining("backing off"),
        });
        expect(Date.now() - started).toBeLessThan(150);
        expect(startRecords(fake.runLog)).toHaveLength(1);

        await delay(220);
        const state = await mgr.ensure("ws-1");
        expect(state.status).toBe("ready");
        expect(startRecords(fake.runLog)).toHaveLength(2);
    });

    it("rejects a second instance as unmanaged while the managed one keeps serving", async () => {
        const cwd = addWorkspace();
        const fake = writeFakeNvim(env.dir);
        const mgr = await create({ bin: fake.bin });
        const first = await mgr.ensure("ws-1");

        const intruder = await PluginClient.connect({
            socketPath: daemonSocketPath(),
            hello: makeHello({ instanceId: "i-intruder", workspaceId: "ws-1", cwd }),
        });
        const ack = await intruder.next("hello_ack");

        expect(asRecord(ack.rejected).code).toBe("E_LEASE");
        expect(asRecord(ack.rejected).message).toBe(`workspace already managed by ${first.instanceId}`);
        await intruder.waitForClosed();

        const unmanaged = await waitFor(() =>
            mgr.list().find((state) => state.instanceId === "i-intruder"),
        );
        expect(unmanaged.status).toBe("unmanaged");
        expect(unmanaged.workspaceId).toBe("ws-1");
        expect(unmanaged.reason).toContain("already managed");

        expect(mgr.instanceStates().map((state) => state.instanceId)).toEqual([first.instanceId]);
        expect((await mgr.ensure("ws-1")).instanceId).toBe(first.instanceId);
        expect(startRecords(fake.runLog)).toHaveLength(1);
    });

    it("degrades on socket close and fans pi2:process_exit out to known sessions", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir, { sessions: ["s1", "s2"], crashAfterMs: 150 });
        const mgr = await create({
            bin: fake.bin,
            deps: { minSpawnIntervalMs: 800, maxSpawnIntervalMs: 2_000 },
        });
        const state = await mgr.ensure("ws-1");
        await waitFor(() => mgr.get("ws-1")?.hasSession("s2"), 3_000);

        const degraded = await waitFor(
            () => mgr.list().find((candidate) => candidate.status === "degraded"),
            4_000,
        );
        expect(degraded.instanceId).toBe(state.instanceId);
        expect(degraded.nvimPid).toBeNull();
        expect(mgr.get("ws-1")).toBeUndefined();
        expect(mgr.findWorkspaceBySession("s1")).toBeUndefined();

        const exits = processExits(bus);
        expect(exits.map((record) => record.sessionId).sort()).toEqual(["s1", "s2"]);
        for (const record of exits) {
            expect(record.workspaceId).toBe("ws-1");
            expect(record.epoch).toBe(state.instanceId);
            expect(asRecord(record.payload).event).toMatchObject({
                type: "pi2:process_exit",
                code: null,
                reason: "instance died",
            });
        }

        // Never auto-restarted...
        await delay(400);
        expect(startRecords(fake.runLog)).toHaveLength(1);
        // ...and the next ensure backs off, then spawns a fresh instance.
        await expect(mgr.ensure("ws-1")).rejects.toMatchObject({ code: "E_INSTANCE_UNAVAILABLE" });
        await delay(500);
        const respawned = await mgr.ensure("ws-1");
        expect(respawned.instanceId).not.toBe(state.instanceId);
        expect(startRecords(fake.runLog)).toHaveLength(2);
    });

    it("drains an instance on shutdown, reports stopped and does not emit process_exit", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir, { sessions: ["s1"] });
        const mgr = await create({ bin: fake.bin });
        const state = await mgr.ensure("ws-1");
        const pid = state.nvimPid as number;
        const exitsBefore = processExits(bus).length;

        await mgr.shutdown("ws-1", "drain");

        const stopped = mgr.list().find((candidate) => candidate.workspaceId === "ws-1");
        expect(stopped?.status).toBe("stopped");
        expect(stopped?.nvimPid).toBeNull();
        expect(mgr.get("ws-1")).toBeUndefined();
        expect(processExits(bus)).toHaveLength(exitsBefore);
        expect(
            readRunLog(fake.runLog).some(
                (entry) => entry.kind === "shutdown" && asRecord(entry).mode === "drain",
            ),
        ).toBe(true);
        await waitFor(() => !isRunning(pid), 3_000);

        const respawned = await mgr.ensure("ws-1");
        expect(respawned.instanceId).not.toBe(state.instanceId);
        expect(startRecords(fake.runLog)).toHaveLength(2);
    });

    it("escalates SIGTERM to SIGKILL when the instance ignores shutdown", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir, { ignoreShutdown: true });
        const mgr = await create({
            bin: fake.bin,
            deps: { shutdownGraceMs: 150, sigtermGraceMs: 150 },
        });
        const state = await mgr.ensure("ws-1");
        const pid = state.nvimPid as number;

        const started = Date.now();
        await mgr.shutdown("ws-1", "stop");
        const elapsed = Date.now() - started;

        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(mgr.list().find((candidate) => candidate.workspaceId === "ws-1")?.status).toBe("stopped");
        expect(readRunLog(fake.runLog).some((entry) => entry.kind === "sigterm")).toBe(true);
        await waitFor(() => !isRunning(pid), 3_000);
    });

    it("treats shutdown of an unknown workspace as a no-op", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir);
        const mgr = await create({ bin: fake.bin });
        await expect(mgr.shutdown("ws-missing", "stop")).resolves.toBeUndefined();
        expect(startRecords(fake.runLog)).toHaveLength(0);
    });

    it("resolves workspace ownership from live sessions and snapshot caches", async () => {
        addWorkspace();
        const snapshotState = makeSessionState("s9", "ws-1");
        const fake = writeFakeNvim(env.dir, {
            sessions: ["s1"],
            snapshots: [{ sessionId: "s9", state: snapshotState }],
        });
        const mgr = await create({ bin: fake.bin });

        await mgr.ensure("ws-1");

        await waitFor(() => mgr.findWorkspaceBySession("s1") === "ws-1");
        await waitFor(() => mgr.findWorkspaceBySession("s9") === "ws-1");
        expect(mgr.findWorkspaceBySession("unknown")).toBeUndefined();
    });

    it("unsubscribes the plugin when the last browser subscriber goes away", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir);
        const mgr = await create({ bin: fake.bin });
        await mgr.ensure("ws-1");

        mgr.get("ws-1")?.subscribe("s1");
        mgr.maybeUnsubscribe("ws-1", "s1");

        await waitFor(() =>
            readRunLog(fake.runLog).some((entry) => {
                if (entry.kind !== "record") return false;
                const record = asRecord(asRecord(entry).record);
                return record.type === "sub.unsubscribe" && record.sessionId === "s1";
            }),
        );
        const received = readRunLog(fake.runLog)
            .filter((entry) => entry.kind === "record")
            .map((entry) => asRecord(entry.record).type);
        expect(received).toContain("sub.subscribe");
        expect(received).toContain("sub.unsubscribe");
    });

    it("reports E_NOT_FOUND for unknown workspaces without spawning", async () => {
        const fake = writeFakeNvim(env.dir);
        const mgr = await create({ bin: fake.bin });

        await expect(mgr.ensure("no-such-workspace")).rejects.toMatchObject({ code: "E_NOT_FOUND" });
        expect(startRecords(fake.runLog)).toHaveLength(0);
    });

    it("reports per-instance RSS and totals for /api/v1/resources", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir, { sessions: ["s1"] });
        const mgr = await create({
            bin: fake.bin,
            deps: {
                readRss: async () => 123 * 1024 * 1024,
                totalMemory: () => 16 * 1024 ** 3,
            },
        });
        const state = await mgr.ensure("ws-1");
        await waitFor(() => mgr.get("ws-1")?.hasSession("s1"));

        const snapshot = await mgr.resources();

        expect(snapshot.instances).toHaveLength(1);
        expect(snapshot.instances[0]).toMatchObject({
            workspaceId: "ws-1",
            instanceId: state.instanceId,
            nvimPid: state.nvimPid,
            rssBytes: 123 * 1024 * 1024,
            sessions: 1,
            hasUI: false,
        });
        expect(snapshot.totalRssBytes).toBe(123 * 1024 * 1024);
        expect(snapshot.physicalMemoryBytes).toBe(16 * 1024 ** 3);
        expect(snapshot.warn).toBe(false);
        expect(snapshot.reason).toBeUndefined();
    });

    it("closes the server and kills spawned instances", async () => {
        addWorkspace();
        const fake = writeFakeNvim(env.dir);
        const mgr = await create({ bin: fake.bin });
        const state = await mgr.ensure("ws-1");
        const pid = state.nvimPid as number;

        await mgr.close();

        await waitFor(() => !isRunning(pid), 3_000);
        await expect(mgr.ensure("ws-1")).rejects.toMatchObject({ code: "E_INSTANCE_UNAVAILABLE" });
        expect(existsSync(daemonSocketPath())).toBe(false);
    });
});

describe("resources helpers", () => {
    it("parses /proc/<pid>/status VmRSS", () => {
        expect(parseProcRss("Name:\tnvim\nVmRSS:\t  102400 kB\nVmSize:\t 204800 kB\n")).toBe(102400 * 1024);
        expect(parseProcRss("VmRSS: 0 kB")).toBe(0);
        expect(parseProcRss("Name: nvim\n")).toBeNull();
        expect(parseProcRss("VmRSS: not-a-number kB")).toBeNull();
    });

    it("parses ps -o rss= output", () => {
        expect(parsePsRss("  204800\n")).toBe(204800 * 1024);
        expect(parsePsRss("204800 12\n")).toBe(204800 * 1024);
        expect(parsePsRss("")).toBeNull();
        expect(parsePsRss("not-a-number")).toBeNull();
    });

    const instance = (index: number, rssBytes: number | null = 1024) => ({
        workspaceId: `ws-${index}`,
        instanceId: `i-${index}`,
        nvimPid: 1000 + index,
        rssBytes,
        sessions: 0,
        hasUI: false,
    });

    it("warns above eight instances", () => {
        const snapshot = summarizeResources(Array.from({ length: 9 }, (_, index) => instance(index)), 16 * 1024 ** 3);
        expect(snapshot.warn).toBe(true);
        expect(snapshot.reason).toContain("9 instances");
        expect(snapshot.totalRssBytes).toBe(9 * 1024);
    });

    it("warns when RSS exceeds 60% of physical memory", () => {
        const snapshot = summarizeResources([instance(1, 11 * 1024 ** 3)], 16 * 1024 ** 3);
        expect(snapshot.warn).toBe(true);
        expect(snapshot.reason).toContain("RSS");
    });

    it("does not warn at exactly eight instances and 60% RSS", () => {
        const snapshot = summarizeResources([instance(1, 9.6 * 1024 ** 3)], 16 * 1024 ** 3);
        expect(snapshot.warn).toBe(false);
        expect(snapshot.reason).toBeUndefined();
    });

    it("ignores missing RSS in the total", () => {
        const snapshot = summarizeResources([instance(1, null), instance(2, 2048)], 16 * 1024 ** 3);
        expect(snapshot.totalRssBytes).toBe(2048);
        expect(snapshot.warn).toBe(false);
    });
});
