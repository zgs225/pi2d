import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../../src/daemon/auth.js";
import { startServer, type StartedServer } from "../../src/daemon/server.js";
import type { Config, Limits } from "../../src/config.js";
import type { SysinfoSampler, SystemStats } from "../../src/core/sysinfo.js";
import type { WorkspaceInfo } from "../../src/protocol/types.js";
import { FakeBus, FakeInstanceManager, FakeWorkspaceStore } from "./fakes.js";

export const TEST_LIMITS: Limits = {
    maxBodyBytes: 8 * 1024 * 1024,
    maxFrameBytes: 8 * 1024 * 1024,
    maxConnections: 64,
};

export function tempDir(prefix = "pi2-daemon-test-"): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

export function testConfig(overrides: Partial<Config> = {}): Config {
    const base: Config = {
        host: "127.0.0.1",
        port: 0,
        staticDir: "/nonexistent-web-dist",
        corsOrigins: [],
        limits: TEST_LIMITS,
        tokenPath: "/tmp/pi2-daemon-test.sock.token",
        deviceStorePath: "/tmp/pi2-daemon-test-devices.json",
        publicUrl: null,
    };
    return { ...base, ...overrides, limits: { ...base.limits, ...(overrides.limits ?? {}) } };
}

/** Deterministic fake sampler returned when no override is provided. */
export const FAKE_SYSTEM_STATS: SystemStats = {
    sampledAt: 1_700_000_000_000,
    cpuPercent: 42,
    cpuCores: 4,
    loadAvg: [1.5, 1.2, 0.9],
    memUsedBytes: 4 * 1024 ** 3,
    memTotalBytes: 16 * 1024 ** 3,
    memPercent: 25,
    diskPath: "/tmp/pi2-test",
    diskUsedBytes: 50 * 1024 ** 3,
    diskTotalBytes: 200 * 1024 ** 3,
    diskPercent: 25,
};

export function makeFakeSysinfoSampler(stats: Partial<SystemStats> = {}): SysinfoSampler {
    const merged: SystemStats = { ...FAKE_SYSTEM_STATS, ...stats };
    return { sample: async () => merged };
}

export interface HarnessOptions {
    workspaces?: WorkspaceInfo[];
    seedInstances?: string[];
    config?: Partial<Config>;
    staticFiles?: Record<string, string>;
    /** Written to `<dir>/cli.token` and accepted by the daemon's AuthStore. */
    cliToken?: string;
    heartbeatMs?: number;
    wsOverrides?: {
        maxBufferedBytes?: number;
        closeBufferedBytes?: number;
        snapshotWaitMs?: number;
        measureBufferedAmount?: (socket: unknown) => number;
    };
    /** Override the sysinfo sampler; defaults to a deterministic fake (no real OS I/O). */
    sysinfo?: SysinfoSampler;
}

export interface Harness {
    dir: string;
    staticDir: string;
    config: Config;
    auth: AuthStore;
    instances: FakeInstanceManager;
    workspaces: FakeWorkspaceStore;
    bus: FakeBus;
    server: StartedServer;
    url: string;
    wsUrl: string;
    createToken(name?: string): string;
    cleanup(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
    const dir = tempDir();
    const staticDir = join(dir, "web");
    mkdirSync(join(staticDir, "assets"), { recursive: true });
    const files: Record<string, string> = {
        "index.html": "<!doctype html><title>pi2</title><div id=app></div>",
        "assets/app-abc123.js": "console.log('pi2');",
        ...(options.staticFiles ?? {}),
    };
    for (const [relative, content] of Object.entries(files)) {
        const target = join(staticDir, relative);
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, content);
    }

    const auth = new AuthStore({
        path: join(dir, "devices.json"),
        ...(options.cliToken === undefined
            ? {}
            : { localTokenPath: join(dir, "cli.token") }),
    });
    if (options.cliToken !== undefined) {
        writeFileSync(join(dir, "cli.token"), `${options.cliToken}\n`, { mode: 0o600 });
    }
    const instances = new FakeInstanceManager();
    for (const workspaceId of options.seedInstances ?? []) instances.addWorkspace(workspaceId);
    const workspaces = new FakeWorkspaceStore(options.workspaces ?? []);
    const bus = new FakeBus();
    const config = testConfig({
        staticDir,
        deviceStorePath: auth.path,
        ...options.config,
        ...(options.config?.limits ? { limits: { ...TEST_LIMITS, ...options.config.limits } } : {}),
    });

    const server = await startServer(config, {
        auth,
        instances,
        workspaces,
        bus,
        daemonId: "d-test",
        machineId: "m-test",
        startedAt: Date.now(),
        heartbeatMs: options.heartbeatMs,
        ws: options.wsOverrides,
        sysinfo: options.sysinfo ?? makeFakeSysinfoSampler(),
    });

    return {
        dir,
        staticDir,
        config,
        auth,
        instances,
        workspaces,
        bus,
        server,
        url: server.url,
        wsUrl: `${server.url.replace(/^http/, "ws")}/ws`,
        createToken(name = "test laptop"): string {
            return auth.createDevice({ name, kind: "laptop" }).token;
        },
        async cleanup(): Promise<void> {
            await server.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
