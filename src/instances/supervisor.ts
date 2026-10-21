/**
 * Instance supervisor: one managed nvim per workspace.
 *
 * Lifecycle (docs/protocol.md §5):
 *   - `ensure()` is idempotent and resolves once the spawned plugin says `hello`.
 *   - A crash degrades the instance and fans `pi2:process_exit` out for every
 *     session the instance knew about. It is **never** restarted automatically;
 *     the next `ensure()` spawns a new process (with exponential backoff).
 *   - `shutdown()` asks the plugin politely, then escalates SIGTERM → SIGKILL.
 */

import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
    Bus,
    InstanceManager,
    InstanceResourcesSnapshot,
    Logger,
    PluginConnection,
} from "../core/interfaces.js";
import {
    daemonSocketPath,
    daemonTokenPath,
    ensureDir,
    instanceSocketPath as defaultInstanceSocketPath,
    runtimeDir,
    stateDir,
} from "../core/paths.js";
import { ERROR_CODES } from "../protocol/errors.js";
import { PROTOCOL_VERSION, type InstanceState } from "../protocol/types.js";
import { PluginSocketConnection, type PluginHello } from "./connection.js";
import { InstanceError, asInstanceError, errorMessage } from "./errors.js";
import { PluginServer, type PluginServerOptions, type PluginServerRejection } from "./plugin-server.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_ENSURE_TIMEOUT_MS = 5_000;
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
export const DEFAULT_SIGTERM_GRACE_MS = 2_000;
export const DEFAULT_MIN_SPAWN_INTERVAL_MS = 2_000;
export const DEFAULT_MAX_SPAWN_INTERVAL_MS = 60_000;
/** Soft warning thresholds for `/api/v1/resources`. */
export const DEFAULT_MAX_INSTANCES = 8;
export const DEFAULT_RSS_FRACTION = 0.6;

export type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface InstanceManagerDeps {
    bus: Bus;
    logger?: Logger;
    /** Resolve the workspace cwd (the daemon's workspace lookup). */
    resolveCwd: (workspaceId: string) => string | undefined | Promise<string | undefined>;
    daemonId?: string;
    now?: () => number;
    /** Defaults to `daemonSocketPath()`. */
    socketPath?: string;
    /** Defaults to `daemonTokenPath()`. */
    tokenPath?: string;
    /** Defaults to `runtimeDir()`; exported to the spawned nvim as `PI2_RUNTIME_DIR`. */
    runtime?: string;
    /** Defaults to `${stateDir()}/instances`. */
    logDir?: string;
    nvimBin?: string;
    nvimInit?: string;
    env?: NodeJS.ProcessEnv;
    spawnFn?: SpawnFunction;
    instanceSocketPath?: (workspaceId: string, instanceId: string) => string;
    pluginServerOptions?: Omit<
        PluginServerOptions,
        "bus" | "logger" | "onOpen" | "onClose" | "onRejected" | "publishInstanceState"
    >;
    ensureTimeoutMs?: number;
    shutdownGraceMs?: number;
    sigtermGraceMs?: number;
    minSpawnIntervalMs?: number;
    maxSpawnIntervalMs?: number;
    maxWriteQueueBytes?: number;
    heartbeatMs?: number;
    readRss?: (pid: number) => Promise<number | null>;
    totalMemory?: () => number;
}

export interface InstanceManagerHandle extends InstanceManager {
    /** Stop the plugin server and kill every spawned nvim (daemon/test shutdown). */
    close(): Promise<void>;
    /** The plugin-facing socket server (exposed for diagnostics). */
    readonly pluginServer: PluginServer;
}

interface SpawnWaiter {
    promise: Promise<PluginSocketConnection>;
    settle(connection: PluginSocketConnection): void;
    fail(error: InstanceError): void;
    attach(child: ChildProcess, logPath: string): void;
    cancel(reason: string): void;
}

interface SpawnFailure {
    count: number;
    nextAllowedAt: number;
}

/** `VmRSS:   123456 kB` from `/proc/<pid>/status` → bytes. */
export function parseProcRss(status: string): number | null {
    const match = /^\s*VmRSS:\s+(\d+)\s+kB\s*$/m.exec(status);
    if (!match?.[1]) return null;
    const kib = Number(match[1]);
    return Number.isFinite(kib) ? kib * 1024 : null;
}

/** `ps -o rss= -p <pid>` output (KiB, may have leading whitespace) → bytes. */
export function parsePsRss(output: string): number | null {
    const first = output.trim().split(/\s+/)[0];
    if (first === undefined || first === "") return null;
    const kib = Number(first);
    return Number.isFinite(kib) && kib >= 0 ? kib * 1024 : null;
}

export function summarizeResources(
    instances: InstanceResourcesSnapshot["instances"],
    physicalMemoryBytes: number,
    options: { maxInstances?: number; rssFraction?: number } = {},
): InstanceResourcesSnapshot {
    const maxInstances = options.maxInstances ?? DEFAULT_MAX_INSTANCES;
    const rssFraction = options.rssFraction ?? DEFAULT_RSS_FRACTION;
    const totalRssBytes = instances.reduce((sum, instance) => sum + (instance.rssBytes ?? 0), 0);
    const reasons: string[] = [];

    if (instances.length > maxInstances) {
        reasons.push(`${instances.length} instances (>${maxInstances})`);
    }
    if (physicalMemoryBytes > 0 && totalRssBytes > physicalMemoryBytes * rssFraction) {
        const percent = Math.round((totalRssBytes / physicalMemoryBytes) * 100);
        reasons.push(`instance RSS ${percent}% of physical memory (>${Math.round(rssFraction * 100)}%)`);
    }

    return {
        instances,
        totalRssBytes,
        physicalMemoryBytes,
        warn: reasons.length > 0,
        ...(reasons.length === 0 ? {} : { reason: reasons.join("; ") }),
    };
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.off("exit", onExit);
            resolve(value);
        };
        const onExit = (): void => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        child.once("exit", onExit);
    });
}

function waitForClose(connection: PluginSocketConnection, timeoutMs: number): Promise<boolean> {
    if (connection.isClosed) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        void connection.closedPromise.then(() => finish(true));
    });
}

function tryKill(child: ChildProcess, signal: NodeJS.Signals): void {
    try {
        child.kill(signal);
    } catch {
        // already exited
    }
}

export class ManagedInstanceManager implements InstanceManagerHandle {
    readonly pluginServer: PluginServer;

    private readonly bus: Bus;
    private readonly logger: Logger | undefined;
    private readonly deps: InstanceManagerDeps;
    private readonly now: () => number;
    private readonly socketPath: string;
    private readonly tokenPath: string;
    private readonly runtime: string;
    private readonly logDir: string;
    private readonly nvimBin: string;
    private readonly nvimInit: string | undefined;
    private readonly spawnFn: SpawnFunction;
    private readonly instanceSocketPath: (workspaceId: string, instanceId: string) => string;
    private readonly readRss: (pid: number) => Promise<number | null>;
    private readonly totalMemory: () => number;
    private readonly ensureTimeoutMs: number;
    private readonly shutdownGraceMs: number;
    private readonly sigtermGraceMs: number;
    private readonly minSpawnIntervalMs: number;
    private readonly maxSpawnIntervalMs: number;

    private readonly states = new Map<string, InstanceState>();
    private readonly unmanaged = new Map<string, InstanceState>();
    private readonly connections = new Map<string, PluginSocketConnection>();
    private readonly spawning = new Map<string, Promise<InstanceState>>();
    private readonly waiters = new Map<string, SpawnWaiter>();
    private readonly children = new Map<string, ChildProcess>();
    private readonly failures = new Map<string, SpawnFailure>();
    private readonly shuttingDown = new Set<string>();
    private readonly changeHandlers = new Set<(state: InstanceState) => void>();

    private closed = false;

    constructor(deps: InstanceManagerDeps) {
        this.deps = deps;
        this.bus = deps.bus;
        this.logger = deps.logger;
        this.now = deps.now ?? Date.now;
        this.socketPath = deps.socketPath ?? daemonSocketPath();
        this.tokenPath = deps.tokenPath ?? daemonTokenPath();
        this.runtime = deps.runtime ?? runtimeDir();
        this.logDir = deps.logDir ?? join(stateDir(), "instances");
        this.nvimBin = deps.nvimBin ?? process.env.PI2_NVIM_BIN ?? "nvim";
        const init = deps.nvimInit ?? process.env.PI2_NVIM_INIT;
        this.nvimInit = init !== undefined && init !== "" ? init : undefined;
        this.spawnFn = deps.spawnFn ?? ((command, args, options) => spawn(command, args, options));
        this.instanceSocketPath = deps.instanceSocketPath ?? defaultInstanceSocketPath;
        this.readRss = deps.readRss ?? defaultReadRss;
        this.totalMemory = deps.totalMemory ?? totalmem;
        this.ensureTimeoutMs = deps.ensureTimeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS;
        this.shutdownGraceMs = deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
        this.sigtermGraceMs = deps.sigtermGraceMs ?? DEFAULT_SIGTERM_GRACE_MS;
        this.minSpawnIntervalMs = deps.minSpawnIntervalMs ?? DEFAULT_MIN_SPAWN_INTERVAL_MS;
        this.maxSpawnIntervalMs = deps.maxSpawnIntervalMs ?? DEFAULT_MAX_SPAWN_INTERVAL_MS;

        this.pluginServer = new PluginServer({
            ...(deps.pluginServerOptions ?? {}),
            bus: deps.bus,
            ...(deps.logger === undefined ? {} : { logger: deps.logger }),
            ...(deps.daemonId === undefined ? {} : { daemonId: deps.daemonId }),
            socketPath: this.socketPath,
            tokenPath: this.tokenPath,
            now: this.now,
            publishInstanceState: false,
        });
        this.pluginServer.setHandlers({
            onOpen: (connection) => this.handleOpen(connection),
            onClose: (connection, reason) => this.handleClose(connection, reason),
            onRejected: (hello, rejection) => this.handleRejected(hello, rejection),
        });
    }

    /** Starts the plugin-facing unix socket server and writes the daemon token. */
    async start(): Promise<void> {
        await this.pluginServer.start();
    }

    async ensure(workspaceId: string, opts: { timeoutMs?: number } = {}): Promise<InstanceState> {
        if (this.closed) throw InstanceError.unavailable("instance manager is closed");
        if (typeof workspaceId !== "string" || workspaceId === "") {
            throw new InstanceError(ERROR_CODES.BAD_REQUEST, "workspaceId is required");
        }

        const existing = this.connections.get(workspaceId);
        if (existing !== undefined && !existing.isClosed) {
            const state = this.readyState(existing, this.states.get(workspaceId));
            this.setState(state);
            return state;
        }

        const running = this.spawning.get(workspaceId);
        if (running !== undefined) return running;

        const failure = this.failures.get(workspaceId);
        const now = this.now();
        if (failure !== undefined && now < failure.nextAllowedAt) {
            throw InstanceError.unavailable(
                `instance for ${workspaceId} is backing off after ${failure.count} failed start(s)`,
                { retryAfterMs: failure.nextAllowedAt - now },
            );
        }

        const timeoutMs = opts.timeoutMs ?? this.ensureTimeoutMs;
        const promise = this.spawnInstance(workspaceId, timeoutMs);
        this.spawning.set(workspaceId, promise);
        try {
            return await promise;
        } finally {
            if (this.spawning.get(workspaceId) === promise) this.spawning.delete(workspaceId);
        }
    }

    async shutdown(workspaceId: string, mode: "drain" | "stop"): Promise<void> {
        const connection = this.connections.get(workspaceId);
        const child = this.children.get(workspaceId);
        const previous = this.states.get(workspaceId);

        if (connection === undefined && child === undefined) {
            if (previous !== undefined) {
                this.setState({
                    ...previous,
                    status: "stopped",
                    nvimPid: null,
                    attachedClients: 0,
                    reason: "shutdown: no live instance",
                });
            }
            return;
        }

        this.shuttingDown.add(workspaceId);
        const base: InstanceState = previous ?? {
            workspaceId,
            instanceId: connection?.instanceId ?? "unknown",
            status: "ready",
            nvimPid: child?.pid ?? null,
            pluginVersion: connection?.pluginVersion ?? null,
            hasUI: connection?.hasUI ?? false,
            attachedClients: 0,
            listenAddr: connection?.listenAddr ?? null,
            startedAt: this.now(),
        };
        this.setState({ ...base, status: "stopping", attachedClients: 0, reason: `shutdown:${mode}` });

        try {
            if (connection !== undefined) {
                connection.send({
                    v: PROTOCOL_VERSION,
                    type: "instance.shutdown",
                    payload: { mode },
                });
                const closedGracefully = await waitForClose(connection, this.shutdownGraceMs);
                if (!closedGracefully) {
                    this.logger?.warn("instance ignored shutdown, escalating", {
                        workspaceId,
                        instanceId: connection.instanceId,
                        mode,
                    });
                    connection.close("shutdown timeout");
                }
            }

            const liveChild = this.children.get(workspaceId) ?? child;
            if (liveChild !== undefined) {
                tryKill(liveChild, "SIGTERM");
                const exited = await waitForChildExit(liveChild, this.sigtermGraceMs);
                if (!exited) {
                    this.logger?.warn("instance ignored SIGTERM, sending SIGKILL", { workspaceId });
                    tryKill(liveChild, "SIGKILL");
                    await waitForChildExit(liveChild, 1_000);
                }
            }
        } finally {
            if (this.connections.get(workspaceId) === connection) this.connections.delete(workspaceId);
            const liveChild = this.children.get(workspaceId);
            if (liveChild === undefined || liveChild === child) this.children.delete(workspaceId);
            this.shuttingDown.delete(workspaceId);
            this.setState({
                ...(this.states.get(workspaceId) ?? base),
                status: "stopped",
                nvimPid: null,
                attachedClients: 0,
                reason: `shutdown complete (${mode})`,
            });
        }
    }

    get(workspaceId: string): PluginConnection | undefined {
        return this.connections.get(workspaceId);
    }

    list(): InstanceState[] {
        return [...this.states.values(), ...this.unmanaged.values()];
    }

    instanceStates(): InstanceState[] {
        return [...this.states.values()];
    }

    findWorkspaceBySession(sessionId: string): string | undefined {
        for (const connection of this.connections.values()) {
            if (connection.snapshot(sessionId) !== undefined || connection.hasSession(sessionId)) {
                return connection.workspaceId;
            }
        }
        return undefined;
    }

    async resources(): Promise<InstanceResourcesSnapshot> {
        const instances: InstanceResourcesSnapshot["instances"] = [];
        for (const connection of this.connections.values()) {
            const state = this.states.get(connection.workspaceId);
            const pid = connection.pid > 0 ? connection.pid : (state?.nvimPid ?? null);
            const rssBytes = pid === null ? null : await this.readRss(pid);
            instances.push({
                workspaceId: connection.workspaceId,
                instanceId: connection.instanceId,
                nvimPid: pid,
                rssBytes,
                sessions: connection.sessionIds().length,
                hasUI: connection.hasUI,
            });
        }
        return summarizeResources(instances, this.totalMemory());
    }

    maybeUnsubscribe(workspaceId: string, sessionId: string): void {
        this.connections.get(workspaceId)?.unsubscribe(sessionId);
    }

    onInstanceChange(handler: (state: InstanceState) => void): void {
        this.changeHandlers.add(handler);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const waiter of [...this.waiters.values()]) waiter.cancel("instance manager closed");
        this.waiters.clear();
        this.spawning.clear();
        for (const child of [...this.children.values()]) tryKill(child, "SIGKILL");
        this.children.clear();
        this.connections.clear();
        await this.pluginServer.close();
        this.logger?.info("instance manager closed", { workspaces: this.states.size });
    }

    private async spawnInstance(workspaceId: string, timeoutMs: number): Promise<InstanceState> {
        const cwd = await this.deps.resolveCwd(workspaceId);
        if (cwd === undefined || cwd === "") {
            throw InstanceError.notFound(`unknown workspace ${workspaceId}`);
        }

        const instanceId = `i-${randomUUID()}`;
        const socketPath = this.instanceSocketPath(workspaceId, instanceId);
        const logPath = join(this.logDir, `${instanceId}.log`);
        const startedAt = this.now();
        const previous = this.states.get(workspaceId);

        const starting: InstanceState = {
            workspaceId,
            instanceId,
            status: "starting",
            nvimPid: null,
            pluginVersion: null,
            hasUI: false,
            attachedClients: 0,
            listenAddr: socketPath,
            startedAt: previous?.startedAt ?? startedAt,
        };
        this.setState(starting);

        const waiter = this.createWaiter(workspaceId, timeoutMs);
        let child: ChildProcess | undefined;
        try {
            const args = [
                "--headless",
                "--listen",
                socketPath,
                ...(this.nvimInit === undefined ? [] : ["-u", this.nvimInit]),
                "-c",
                'lua require("pi.host").start()',
            ];
            const env: NodeJS.ProcessEnv = {
                ...process.env,
                ...(this.deps.env ?? {}),
                PI2_RUNTIME_DIR: this.runtime,
                PI2_DAEMON_SOCKET: this.socketPath,
                PI2_DAEMON_TOKEN_PATH: this.tokenPath,
                PI2_WORKSPACE_ID: workspaceId,
            };
            this.logger?.info("spawning instance", { workspaceId, instanceId, cwd, command: this.nvimBin, logPath });
            child = this.spawnFn(this.nvimBin, args, {
                cwd,
                env,
                stdio: "ignore",
                detached: true,
            });
            this.children.set(workspaceId, child);
            if (child.pid !== undefined) this.setState({ ...starting, nvimPid: child.pid });
            child.unref();
            waiter.attach(child, logPath);

            const connection = await waiter.promise;
            this.failures.delete(workspaceId);
            // Note: the plugin mints its own `instanceId`; it need not match the id we
            // used for `--listen`. Never infer "redundant spawn" from that difference.
            return this.readyState(connection, this.states.get(workspaceId));
        } catch (error) {
            const failure = asInstanceError(error);
            this.recordFailure(workspaceId);
            if (child !== undefined) {
                tryKill(child, "SIGKILL");
                if (this.children.get(workspaceId) === child) this.children.delete(workspaceId);
            }
            this.setState({
                ...(this.states.get(workspaceId) ?? starting),
                status: "stopped",
                nvimPid: null,
                attachedClients: 0,
                reason: failure.message,
            });
            this.logger?.warn("instance failed to start", {
                workspaceId,
                instanceId,
                code: failure.code,
                error: failure.message,
            });
            throw failure;
        }
    }

    private createWaiter(workspaceId: string, timeoutMs: number): SpawnWaiter {
        const manager = this;
        let settled = false;
        let resolvePromise!: (connection: PluginSocketConnection) => void;
        let rejectPromise!: (error: Error) => void;

        const promise = new Promise<PluginSocketConnection>((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        // Callers always await this, but a synchronous spawn failure can cancel an
        // unobserved waiter; keep Node from reporting an unhandled rejection.
        void promise.catch(() => undefined);

        let timer: NodeJS.Timeout | undefined;
        let exited = false;

        const cleanup = (): void => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            if (this.waiters.get(workspaceId) === waiter) this.waiters.delete(workspaceId);
        };

        const waiter: SpawnWaiter = {
            promise,
            settle(connection) {
                if (settled) return;
                settled = true;
                cleanup();
                resolvePromise(connection);
            },
            fail(error) {
                if (settled) return;
                settled = true;
                cleanup();
                rejectPromise(error);
            },
            attach(child, logPath) {
                child.once("exit", (code, signal) => {
                    exited = true;
                    if (manager.children.get(workspaceId) === child) manager.children.delete(workspaceId);
                    if (settled) return;
                    const message = `nvim exited before hello (code ${String(code)}, signal ${String(signal)})`;
                    void manager.appendLog(logPath, message);
                    waiter.fail(InstanceError.unavailable(message, { workspaceId }));
                });
                child.once("error", (error) => {
                    void manager.appendLog(logPath, `spawn error: ${error.message}`);
                    waiter.fail(InstanceError.unavailable(`failed to spawn nvim: ${error.message}`, { workspaceId }));
                });
            },
            cancel(reason) {
                if (settled) return;
                settled = true;
                cleanup();
                rejectPromise(InstanceError.unavailable(reason));
            },
        };

        timer = setTimeout(() => {
            const message = exited
                ? `instance for ${workspaceId} exited before hello`
                : `instance for ${workspaceId} did not say hello within ${timeoutMs}ms`;
            waiter.fail(exited ? InstanceError.unavailable(message) : InstanceError.starting(message));
        }, timeoutMs);
        timer.unref?.();

        this.waiters.set(workspaceId, waiter);
        return waiter;
    }

    private handleOpen(connection: PluginSocketConnection): void {
        if (this.closed) {
            connection.close("instance manager is closed");
            return;
        }
        this.connections.set(connection.workspaceId, connection);
        this.waiters.get(connection.workspaceId)?.settle(connection);
        this.setState(this.readyState(connection, this.states.get(connection.workspaceId)));
    }

    private handleClose(connection: PluginSocketConnection, reason: string): void {
        if (this.connections.get(connection.workspaceId) !== connection) return;
        this.connections.delete(connection.workspaceId);

        const previous = this.states.get(connection.workspaceId);
        if (this.closed || this.shuttingDown.has(connection.workspaceId) || previous?.status === "stopping") {
            return;
        }

        this.recordFailure(connection.workspaceId);
        this.setState({
            ...(previous ?? this.readyState(connection, undefined)),
            instanceId: connection.instanceId,
            status: "degraded",
            nvimPid: null,
            attachedClients: 0,
            reason,
        });

        // The plugin is gone: every session it owned is now interrupted.
        for (const sessionId of connection.sessionIds()) {
            const ts = this.now();
            this.bus.publish({
                v: PROTOCOL_VERSION,
                type: "event",
                workspaceId: connection.workspaceId,
                sessionId,
                epoch: connection.instanceId,
                seq: connection.lastSeq(sessionId),
                ts,
                payload: {
                    event: { type: "pi2:process_exit", code: null, reason: "instance died", ts },
                },
            });
        }
    }

    private handleRejected(hello: PluginHello, rejection: PluginServerRejection): void {
        const state: InstanceState = {
            workspaceId: hello.workspaceId,
            instanceId: hello.instanceId,
            status: "unmanaged",
            nvimPid: hello.pid,
            pluginVersion: hello.pluginVersion,
            hasUI: hello.hasUI,
            attachedClients: 0,
            listenAddr: hello.listenAddr,
            startedAt: this.now(),
            reason: rejection.message,
        };
        this.unmanaged.set(hello.instanceId, state);
        this.logger?.warn("unmanaged instance rejected", {
            workspaceId: hello.workspaceId,
            instanceId: hello.instanceId,
            reason: rejection.message,
        });
        this.publishState(state);
    }

    private recordFailure(workspaceId: string): void {
        const previous = this.failures.get(workspaceId);
        const count = (previous?.count ?? 0) + 1;
        const delay = Math.min(this.maxSpawnIntervalMs, this.minSpawnIntervalMs * 2 ** (count - 1));
        this.failures.set(workspaceId, { count, nextAllowedAt: this.now() + delay });
    }

    private readyState(
        connection: PluginSocketConnection,
        previous: InstanceState | undefined,
    ): InstanceState {
        return {
            workspaceId: connection.workspaceId,
            instanceId: connection.instanceId,
            status: "ready",
            nvimPid: connection.pid,
            pluginVersion: connection.pluginVersion,
            hasUI: connection.hasUI,
            attachedClients: 0,
            listenAddr: connection.listenAddr,
            startedAt: previous?.startedAt ?? this.now(),
        };
    }

    private setState(state: InstanceState): void {
        const previous = this.states.get(state.workspaceId);
        this.states.set(state.workspaceId, state);
        if (previous !== undefined && sameState(previous, state)) return;
        this.publishState(state);
    }

    private publishState(state: InstanceState): void {
        const sessions = this.connections
            .get(state.workspaceId)
            ?.sessionIds()
            .map((sessionId) => ({ sessionId }));
        this.bus.publish({
            v: PROTOCOL_VERSION,
            type: "instance_state",
            workspaceId: state.workspaceId,
            instanceId: state.instanceId,
            ts: this.now(),
            payload: {
                ...state,
                sessions: sessions ?? [],
            },
        });
        for (const handler of this.changeHandlers) {
            try {
                handler(state);
            } catch (error) {
                this.logger?.warn("instance change handler threw", { error: errorMessage(error) });
            }
        }
    }

    private async appendLog(logPath: string, message: string): Promise<void> {
        try {
            ensureDir(dirname(logPath));
            await appendFile(logPath, `${new Date(this.now()).toISOString()} ${message}\n`);
        } catch (error) {
            this.logger?.debug("could not write instance log", { logPath, error: errorMessage(error) });
        }
    }
}

function sameState(a: InstanceState, b: InstanceState): boolean {
    return (
        a.instanceId === b.instanceId &&
        a.status === b.status &&
        a.nvimPid === b.nvimPid &&
        a.pluginVersion === b.pluginVersion &&
        a.hasUI === b.hasUI &&
        a.attachedClients === b.attachedClients &&
        a.listenAddr === b.listenAddr &&
        a.startedAt === b.startedAt &&
        a.reason === b.reason
    );
}

async function defaultReadRss(pid: number): Promise<number | null> {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === "linux") {
        try {
            return parseProcRss(await readFile(`/proc/${pid}/status`, "utf8"));
        } catch {
            return null;
        }
    }
    try {
        const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
        return parsePsRss(stdout);
    } catch {
        return null;
    }
}

/**
 * Creates the instance manager and starts its plugin-facing socket server
 * (so the daemon token exists before the first nvim is spawned).
 */
export async function createInstanceManager(deps: InstanceManagerDeps): Promise<InstanceManagerHandle> {
    const manager = new ManagedInstanceManager(deps);
    await manager.start();
    return manager;
}
