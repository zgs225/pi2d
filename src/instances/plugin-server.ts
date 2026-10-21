/**
 * Plugin-facing unix-socket server (`<runtime>/d.sock`).
 *
 * The plugin dials the daemon and speaks newline-delimited JSON (docs/protocol.md
 * §2). Responsibilities:
 *   - write a fresh random 32-byte hex token to `<runtime>/d.sock.token` (0600, atomic)
 *   - authenticate the first record (`hello`, timing-safe token compare, `v === 1`)
 *   - reject a second instance for an already-managed workspace with
 *     `hello_ack {rejected:{code:"E_LEASE"}}` and report it for diagnostics
 *   - split only on `\n`, strip `\r`, cap a frame at 8 MB
 *   - close sockets that go quiet for 45 s (any record counts as activity)
 *   - turn each accepted connection into a `PluginSocketConnection`
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Bus, Logger } from "../core/interfaces.js";
import { daemonSocketPath, daemonTokenPath, ensureDir } from "../core/paths.js";
import { ERROR_CODES } from "../protocol/errors.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import {
    DEFAULT_MAX_WRITE_QUEUE_BYTES,
    PluginSocketConnection,
    type PluginHello,
} from "./connection.js";
import { errorMessage } from "./errors.js";

export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_HEARTBEAT_MS = 45_000;
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

export interface PluginServerRejection {
    code: string;
    message: string;
}

export interface PluginServerOptions {
    bus: Bus;
    logger?: Logger;
    daemonId?: string;
    /** Defaults to `daemonSocketPath()`. */
    socketPath?: string;
    /** Defaults to `daemonTokenPath()`. */
    tokenPath?: string;
    maxFrameBytes?: number;
    maxWriteQueueBytes?: number;
    /** Idle limit: any record resets the timer (docs/protocol.md §2). */
    heartbeatMs?: number;
    /** Sweep interval; defaults to `heartbeatMs / 3`. */
    heartbeatCheckMs?: number;
    /** The first record must arrive within this window. */
    helloTimeoutMs?: number;
    limits?: Record<string, unknown>;
    policy?: Record<string, unknown>;
    now?: () => number;
    /** Publish a minimal `instance_state` on connect/disconnect (the supervisor disables this). */
    publishInstanceState?: boolean;
    onOpen?: (connection: PluginSocketConnection) => void;
    onClose?: (connection: PluginSocketConnection, reason: string) => void;
    onRejected?: (hello: PluginHello, rejection: PluginServerRejection) => void;
}

interface SocketState {
    socket: Socket;
    buffer: string;
    lastActivity: number;
    connection: PluginSocketConnection | undefined;
    authTimer: NodeJS.Timeout | undefined;
    /** No further records are parsed (protocol/auth rejection). */
    finished: boolean;
    /** Reason reported to `onClose`; defaults to "socket closed". */
    closeReason: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Validates the wire fields of a `hello` record. Returns `undefined` when a
 * required field is missing or has the wrong type.
 */
export function parseHello(record: Record<string, unknown>): PluginHello | undefined {
    const instanceId = asString(record.instanceId);
    const workspaceId = asString(record.workspaceId);
    const cwd = asString(record.cwd);
    const pid = asNumber(record.pid);
    const pluginVersion = asString(record.pluginVersion);
    if (instanceId === undefined || workspaceId === undefined || cwd === undefined) return undefined;
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (pluginVersion === undefined) return undefined;
    if (typeof record.hasUI !== "boolean") return undefined;

    const rawListen = record.listenAddr;
    const listenAddr = typeof rawListen === "string" && rawListen !== "" ? rawListen : null;
    const capabilities = Array.isArray(record.capabilities)
        ? record.capabilities.filter((value): value is string => typeof value === "string")
        : undefined;

    return {
        instanceId,
        workspaceId,
        cwd,
        pid,
        hasUI: record.hasUI,
        listenAddr,
        pluginVersion,
        ...(capabilities === undefined ? {} : { capabilities }),
    };
}

export class PluginServer {
    private readonly options: PluginServerOptions;
    private readonly bus: Bus;
    private readonly logger: Logger | undefined;
    private readonly daemonId: string;
    private readonly socketPath: string;
    private readonly tokenPath: string;
    private readonly maxFrameBytes: number;
    private readonly maxWriteQueueBytes: number;
    private readonly heartbeatMs: number;
    private readonly heartbeatCheckMs: number;
    private readonly helloTimeoutMs: number;
    private readonly now: () => number;
    private readonly publishInstanceState: boolean;

    private server: Server | undefined;
    private heartbeatTimer: NodeJS.Timeout | undefined;
    private started = false;
    private closing = false;
    private tokenValue = "";
    private readonly sockets = new Set<SocketState>();
    private readonly byWorkspace = new Map<string, PluginSocketConnection>();

    constructor(options: PluginServerOptions) {
        this.options = options;
        this.bus = options.bus;
        this.logger = options.logger;
        this.daemonId = options.daemonId ?? "d-local";
        this.socketPath = options.socketPath ?? daemonSocketPath();
        this.tokenPath = options.tokenPath ?? daemonTokenPath();
        this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
        this.maxWriteQueueBytes = options.maxWriteQueueBytes ?? DEFAULT_MAX_WRITE_QUEUE_BYTES;
        this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
        this.heartbeatCheckMs =
            options.heartbeatCheckMs ?? Math.max(5, Math.floor(this.heartbeatMs / 3));
        this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
        this.now = options.now ?? Date.now;
        this.publishInstanceState = options.publishInstanceState ?? true;
    }

    get path(): string {
        return this.socketPath;
    }

    get tokenFilePath(): string {
        return this.tokenPath;
    }

    get isStarted(): boolean {
        return this.started;
    }

    /** Current daemon token (also persisted at `tokenFilePath`, mode 0600). */
    get token(): string {
        return this.tokenValue;
    }

    connection(workspaceId: string): PluginSocketConnection | undefined {
        return this.byWorkspace.get(workspaceId);
    }

    connections(): PluginSocketConnection[] {
        return [...this.byWorkspace.values()];
    }

    get connectionCount(): number {
        return this.byWorkspace.size;
    }

    setHandlers(handlers: {
        onOpen?: PluginServerOptions["onOpen"];
        onClose?: PluginServerOptions["onClose"];
        onRejected?: PluginServerOptions["onRejected"];
    }): void {
        if (handlers.onOpen !== undefined) this.options.onOpen = handlers.onOpen;
        if (handlers.onClose !== undefined) this.options.onClose = handlers.onClose;
        if (handlers.onRejected !== undefined) this.options.onRejected = handlers.onRejected;
    }

    async start(): Promise<void> {
        if (this.started) return;
        if (this.closing) throw new Error("plugin server is closing");

        this.tokenValue = randomBytes(32).toString("hex");
        await this.writeToken();

        ensureDir(dirname(this.socketPath));
        // A stale socket file from a crashed daemon would make listen() fail with EADDRINUSE.
        await rm(this.socketPath, { force: true }).catch(() => undefined);

        const server = createServer((socket) => this.handleSocket(socket));
        this.server = server;
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                server.off("listening", onListening);
                reject(error);
            };
            const onListening = (): void => {
                server.off("error", onError);
                resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(this.socketPath);
        });

        await chmod(this.socketPath, 0o600).catch((error: unknown) => {
            this.logger?.debug("could not chmod plugin socket", { error: errorMessage(error) });
        });
        server.on("error", (error) => {
            this.logger?.error("plugin server error", { error: error.message });
        });

        this.heartbeatTimer = setInterval(() => this.sweepHeartbeats(), this.heartbeatCheckMs);
        this.heartbeatTimer.unref?.();
        this.started = true;
        this.logger?.info("plugin server listening", {
            socketPath: this.socketPath,
            tokenPath: this.tokenPath,
            maxFrameBytes: this.maxFrameBytes,
        });
    }

    async close(): Promise<void> {
        if (this.closing) return;
        this.closing = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
        for (const state of [...this.sockets]) {
            state.closeReason = "daemon shutting down";
            try {
                state.socket.destroy();
            } catch {
                // already gone
            }
        }
        this.sockets.clear();
        this.byWorkspace.clear();
        this.started = false;

        const server = this.server;
        this.server = undefined;
        if (server) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await rm(this.socketPath, { force: true }).catch(() => undefined);
        this.logger?.info("plugin server closed", { socketPath: this.socketPath });
    }

    private async writeToken(): Promise<void> {
        const directory = dirname(this.tokenPath);
        ensureDir(directory);
        const temp = `${this.tokenPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
        await writeFile(temp, this.tokenValue, { mode: 0o600 });
        await chmod(temp, 0o600);
        await rename(temp, this.tokenPath);
        await chmod(this.tokenPath, 0o600).catch(() => undefined);
    }

    private tokenMatches(candidate: string): boolean {
        if (candidate.length !== this.tokenValue.length) return false;
        const expected = Buffer.from(this.tokenValue, "utf8");
        const actual = Buffer.from(candidate, "utf8");
        if (expected.length !== actual.length) return false;
        return timingSafeEqual(expected, actual);
    }

    private handleSocket(socket: Socket): void {
        if (this.closing) {
            socket.destroy();
            return;
        }
        socket.setEncoding("utf8");
        const state: SocketState = {
            socket,
            buffer: "",
            lastActivity: this.now(),
            connection: undefined,
            authTimer: undefined,
            finished: false,
            closeReason: undefined,
        };
        this.sockets.add(state);

        state.authTimer = setTimeout(() => {
            if (state.connection === undefined && !state.finished) {
                this.reject(state, ERROR_CODES.UNAUTHORIZED, "hello timeout", "hello timeout");
            }
        }, this.helloTimeoutMs);
        state.authTimer.unref?.();

        socket.on("data", (chunk: string | Buffer) => {
            this.handleData(state, typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        });
        socket.on("error", (error) => {
            this.logger?.debug("plugin socket error", {
                error: error.message,
                instanceId: state.connection?.instanceId,
            });
        });
        socket.on("close", () => this.handleSocketClose(state));
    }

    private handleData(state: SocketState, chunk: string): void {
        if (state.finished) return;
        state.lastActivity = this.now();
        state.buffer += chunk;

        if (Buffer.byteLength(state.buffer, "utf8") > this.maxFrameBytes) {
            this.reject(state, ERROR_CODES.PAYLOAD_TOO_LARGE, "frame exceeds maxFrameBytes", "frame too large");
            return;
        }

        let newline = state.buffer.indexOf("\n");
        while (newline >= 0) {
            let line = state.buffer.slice(0, newline);
            state.buffer = state.buffer.slice(newline + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line.trim() !== "") this.handleLine(state, line);
            if (state.finished) return;
            newline = state.buffer.indexOf("\n");
        }
    }

    private handleLine(state: SocketState, line: string): void {
        let record: unknown;
        try {
            record = JSON.parse(line);
        } catch {
            this.reject(state, ERROR_CODES.BAD_REQUEST, "malformed JSON", "malformed frame");
            return;
        }
        if (!isRecord(record)) {
            this.reject(state, ERROR_CODES.BAD_REQUEST, "record must be a JSON object", "malformed frame");
            return;
        }

        if (state.connection === undefined) {
            this.handleHello(state, record);
            return;
        }
        state.connection.handleRecord(record);
    }

    private handleHello(state: SocketState, record: Record<string, unknown>): void {
        if (record.type !== "hello") {
            this.reject(state, ERROR_CODES.BAD_REQUEST, "first record must be hello", "expected hello");
            return;
        }
        if (record.v !== PROTOCOL_VERSION) {
            this.reject(
                state,
                ERROR_CODES.PROTOCOL_VERSION,
                `unsupported protocol version ${String(record.v)}`,
                "protocol version",
            );
            return;
        }
        const token = asString(record.token);
        if (token === undefined || !this.tokenMatches(token)) {
            this.reject(state, ERROR_CODES.UNAUTHORIZED, "invalid daemon token", "unauthorized");
            return;
        }
        const hello = parseHello(record);
        if (hello === undefined) {
            this.reject(state, ERROR_CODES.BAD_REQUEST, "hello is missing required fields", "bad hello");
            return;
        }

        const existing = this.byWorkspace.get(hello.workspaceId);
        if (existing !== undefined && !existing.isClosed) {
            const message = `workspace already managed by ${existing.instanceId}`;
            this.writeAndFinish(state, {
                v: PROTOCOL_VERSION,
                type: "hello_ack",
                daemonId: this.daemonId,
                rejected: { code: ERROR_CODES.LEASE_CONFLICT, message },
            });
            this.logger?.warn("rejected unmanaged instance", {
                workspaceId: hello.workspaceId,
                instanceId: hello.instanceId,
                managedBy: existing.instanceId,
            });
            this.options.onRejected?.(hello, { code: ERROR_CODES.LEASE_CONFLICT, message });
            return;
        }

        if (state.authTimer) {
            clearTimeout(state.authTimer);
            state.authTimer = undefined;
        }

        const connection = new PluginSocketConnection({
            socket: state.socket,
            hello,
            bus: this.bus,
            ...(this.logger === undefined ? {} : { logger: this.logger }),
            now: this.now,
            maxWriteQueueBytes: this.maxWriteQueueBytes,
        });
        state.connection = connection;
        this.byWorkspace.set(hello.workspaceId, connection);

        connection.send({
            v: PROTOCOL_VERSION,
            type: "hello_ack",
            daemonId: this.daemonId,
            limits: this.options.limits ?? { maxFrameBytes: this.maxFrameBytes },
            policy: this.options.policy ?? { attention: "all" },
        });

        this.logger?.info("plugin connected", {
            workspaceId: hello.workspaceId,
            instanceId: hello.instanceId,
            pid: hello.pid,
            hasUI: hello.hasUI,
            pluginVersion: hello.pluginVersion,
        });
        if (this.publishInstanceState) this.publishState(connection, "ready");
        this.options.onOpen?.(connection);
    }

    private publishState(connection: PluginSocketConnection, status: string): void {
        this.bus.publish({
            v: PROTOCOL_VERSION,
            type: "instance_state",
            workspaceId: connection.workspaceId,
            instanceId: connection.instanceId,
            ts: this.now(),
            payload: {
                status,
                nvimPid: connection.pid,
                pluginVersion: connection.pluginVersion,
                hasUI: connection.hasUI,
                listenAddr: connection.listenAddr,
                sessions: connection.sessionIds().map((sessionId) => ({ sessionId })),
            },
        });
    }

    private reject(state: SocketState, code: string, message: string, reason: string): void {
        this.writeAndFinish(
            state,
            {
                v: PROTOCOL_VERSION,
                type: "error",
                payload: { code, message, retryable: false },
            },
            reason,
        );
    }

    private writeAndFinish(
        state: SocketState,
        record: Record<string, unknown>,
        reason = "rejected",
    ): void {
        if (state.finished) return;
        state.finished = true;
        state.closeReason = reason;
        if (state.authTimer) {
            clearTimeout(state.authTimer);
            state.authTimer = undefined;
        }
        try {
            state.socket.end(JSON.stringify(record) + "\n");
        } catch {
            state.socket.destroy();
        }
        // Do not let a peer that never reads keep the fd forever.
        const timer = setTimeout(() => {
            if (!state.socket.destroyed) state.socket.destroy();
        }, 500);
        timer.unref?.();
    }

    private handleSocketClose(state: SocketState): void {
        if (state.authTimer) {
            clearTimeout(state.authTimer);
            state.authTimer = undefined;
        }
        this.sockets.delete(state);
        const connection = state.connection;
        if (connection === undefined) return;
        state.connection = undefined;

        if (this.byWorkspace.get(connection.workspaceId) === connection) {
            this.byWorkspace.delete(connection.workspaceId);
        }
        const reason = state.closeReason ?? connection.closeReason ?? "socket closed";
        connection.notifyClosed(reason);
        if (this.publishInstanceState && !this.closing) this.publishState(connection, "degraded");
        this.logger?.info("plugin disconnected", {
            workspaceId: connection.workspaceId,
            instanceId: connection.instanceId,
            reason,
        });
        this.options.onClose?.(connection, reason);
    }

    private sweepHeartbeats(): void {
        const now = this.now();
        for (const state of [...this.sockets]) {
            if (state.finished) continue;
            if (now - state.lastActivity <= this.heartbeatMs) continue;
            this.logger?.warn("plugin heartbeat timeout", {
                workspaceId: state.connection?.workspaceId,
                instanceId: state.connection?.instanceId,
                idleMs: now - state.lastActivity,
            });
            state.closeReason = "heartbeat timeout";
            state.finished = true;
            try {
                state.socket.destroy();
            } catch {
                // already gone
            }
        }
    }
}
