/**
 * Composition root: the real dependency graph behind `pi2 daemon`.
 *
 * Everything the daemon serves is assembled here so that the CLI entry point
 * only has to deal with process concerns (args, lock, signals, daemon.json):
 *
 *   config        -> `loadConfig()` (env driven, see docs/deployment.md)
 *   bus           -> `InMemoryBus` (WS/SSE fan-out)
 *   auth          -> `AuthStore` over `<dataDir>/devices.json` + `<runtime>/cli.token`
 *   workspaces    -> `createWorkspaceStore({ discovery, registry, instances })`
 *   instances     -> `createInstanceManager()` (starts the plugin unix socket itself)
 *   http/ws       -> `startServer(config, deps)`
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadConfig, type Config, type ConfigEnv } from "../config.js";
import { dataDir, daemonSocketPath, daemonTokenPath, runtimeDir, stateDir } from "../core/paths.js";
import type { Logger } from "../core/interfaces.js";
import { AuthStore } from "../daemon/auth.js";
import { InMemoryBus } from "../daemon/hub.js";
import { startServer, type ServerDeps, type StartedServer } from "../daemon/server.js";
import { createInstanceManager, type InstanceManagerHandle } from "../instances/index.js";
import { createDiscovery, createWorkspaceStore, WorkspaceRegistry, type WorkspaceStoreHandle } from "../workspaces/index.js";
import { listenWithRetry, type ListenOptions } from "./listen.js";

/** File name of the local CLI token inside the runtime dir. */
export const CLI_TOKEN_FILE = "cli.token";

export interface WireOptions {
    /** Environment used for `loadConfig`; defaults to `process.env`. */
    env?: ConfigEnv;
    /** Direct config overrides, applied after the environment. */
    config?: Partial<Config>;
    logger?: Logger;
    daemonId?: string;
    machineId?: string;
    /** Runtime dir for the plugin socket + CLI token; defaults to `runtimeDir()`. */
    runtime?: string;
    /** Instance log dir; defaults to `<stateDir>/instances`. */
    logDir?: string;
    /** Workspace registry file; defaults to `<dataDir>/workspaces.json`. */
    registryPath?: string;
    /** Discovery override (`sessionsRoot()` by default). */
    discoveryRoot?: string;
    nvimBin?: string;
    nvimInit?: string;
    now?: () => number;
    /** Extra `ServerDeps` (heartbeat/ws overrides) for tests. */
    server?: Pick<ServerDeps, "heartbeatMs" | "ws">;
}

export interface WiredDaemon {
    /** Effective config; `config.port` is updated by `start()` to the bound port. */
    config: Config;
    deps: ServerDeps;
    instanceManager: InstanceManagerHandle;
    workspaceStore: WorkspaceStoreHandle;
    auth: AuthStore;
    bus: InMemoryBus;
    /** The http+ws server, once `start()` succeeded. */
    server: StartedServer | undefined;
    /** `<runtime>/cli.token` — the local admin token for this daemon. */
    cliTokenPath: string;
    runtime: string;
    /** Start http+ws (idempotent). `options` is passed to `listenWithRetry`. */
    start(options?: ListenOptions): Promise<StartedServer>;
    /** Close the http server (if started) and the instance layer. */
    close(): Promise<void>;
}

function machineIdFor(host: string): string {
    // Stable per host so browsers grouped by machine survive daemon restarts.
    let hash = 0;
    for (let i = 0; i < host.length; i += 1) hash = (hash * 31 + host.charCodeAt(i)) >>> 0;
    return `m-${hash.toString(16).padStart(8, "0")}`;
}

export async function wireDaemon(options: WireOptions = {}): Promise<WiredDaemon> {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now;
    const runtime = options.runtime ?? runtimeDir();
    const daemonId = options.daemonId ?? `d-${randomUUID()}`;

    const base = loadConfig(env);
    const config: Config = {
        ...base,
        ...options.config,
        limits: { ...base.limits, ...(options.config?.limits ?? {}) },
        corsOrigins: options.config?.corsOrigins ?? base.corsOrigins,
    };

    const bus = new InMemoryBus(options.logger === undefined ? {} : { logger: options.logger });
    const cliTokenPath = join(runtime, CLI_TOKEN_FILE);
    const auth = new AuthStore({
        path: config.deviceStorePath,
        localTokenPath: cliTokenPath,
        ...(options.now === undefined ? {} : { now: options.now }),
    });

    // `resolveCwd` needs the store, and the store needs the manager: keep one
    // late-bound reference instead of duplicating the registry lookup.
    let workspaceStore: WorkspaceStoreHandle | undefined;
    const instanceManager = await createInstanceManager({
        bus,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        daemonId,
        now,
        socketPath: daemonSocketPath(),
        tokenPath: daemonTokenPath(),
        runtime,
        logDir: options.logDir ?? join(stateDir(), "instances"),
        ...(options.nvimBin === undefined ? {} : { nvimBin: options.nvimBin }),
        ...(options.nvimInit === undefined ? {} : { nvimInit: options.nvimInit }),
        resolveCwd: (workspaceId: string): string | undefined => {
            const workspace = workspaceStore?.get(workspaceId);
            if (workspace === undefined) return undefined;
            return workspace.cwd;
        },
    });

    const discovery = createDiscovery({
        ...(options.discoveryRoot === undefined ? {} : { root: options.discoveryRoot }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    const registry = new WorkspaceRegistry({
        filePath: options.registryPath ?? join(dataDir(), "workspaces.json"),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    workspaceStore = createWorkspaceStore({
        discovery,
        registry,
        instances: instanceManager,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
    });

    const startedAt = now();
    const deps: ServerDeps = {
        auth,
        instances: instanceManager,
        workspaces: workspaceStore,
        bus,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        daemonId,
        machineId: options.machineId ?? machineIdFor(env.HOSTNAME ?? process.env.HOSTNAME ?? "localhost"),
        startedAt,
        now,
        ...(options.server?.heartbeatMs === undefined ? {} : { heartbeatMs: options.server.heartbeatMs }),
        ...(options.server?.ws === undefined ? {} : { ws: options.server.ws }),
    };

    let server: StartedServer | undefined;
    let closing: Promise<void> | undefined;

    const wired: WiredDaemon = {
        config,
        deps,
        instanceManager,
        workspaceStore,
        auth,
        bus,
        server,
        cliTokenPath,
        runtime,
        async start(listenOptions: ListenOptions = {}): Promise<StartedServer> {
            if (server !== undefined) return server;
            server = await listenWithRetry(wired.config, deps, listenOptions);
            wired.server = server;
            wired.config = server.config;
            return server;
        },
        async close(): Promise<void> {
            if (closing !== undefined) return closing;
            closing = (async () => {
                const current = wired.server;
                if (current !== undefined) await current.close();
                // `instanceManager.close()` also stops the plugin socket server;
                // the CLI's SIGTERM path closes the socket without killing nvim.
                await instanceManager.close();
            })();
            return closing;
        },
    };

    return wired;
}

export { startServer };
export type { StartedServer };
