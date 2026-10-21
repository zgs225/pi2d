/**
 * `PluginConnection` implementation over one accepted unix-socket connection.
 *
 * Framing (JSONL) is owned by `plugin-server.ts`; this module owns the
 * protocol semantics: command/ack correlation, session subscriptions, the
 * per-session snapshot cache and the `event` relay onto the daemon bus.
 *
 * The daemon never renumbers: `seq`/`epoch` always come from the plugin.
 * A snapshot with a different `epoch` invalidates the cached state for that
 * session (the plugin restarted or re-opened the session elsewhere).
 */

import type { Socket } from "node:net";
import type { Bus, Logger, PluginConnection } from "../core/interfaces.js";
import { ERROR_CODES } from "../protocol/errors.js";
import { PROTOCOL_VERSION, type Entry, type SessionState } from "../protocol/types.js";
import { InstanceError, errorMessage } from "./errors.js";

export const DEFAULT_COMMAND_TIMEOUT_MS = 25_000;
/** docs/protocol.md §2: "Write-queue cap 4 MB per connection". */
export const DEFAULT_MAX_WRITE_QUEUE_BYTES = 4 * 1024 * 1024;

/** The `hello` record, already validated by the server. */
export interface PluginHello {
    instanceId: string;
    workspaceId: string;
    cwd: string;
    pid: number;
    hasUI: boolean;
    listenAddr: string | null;
    pluginVersion: string;
    capabilities?: string[];
}

export interface SnapshotCacheEntry {
    epoch: string;
    seq: number;
    state: SessionState;
    /**
     * The plugin's `entries` tail sent next to `state` (docs/protocol.md §2).
     * `undefined` when the plugin omitted it (state-only snapshot).
     */
    entries?: Entry[];
}

export interface PluginSocketConnectionOptions {
    socket: Socket;
    hello: PluginHello;
    bus: Bus;
    logger?: Logger;
    now?: () => number;
    maxWriteQueueBytes?: number;
    /** Called for `instance_state` records (the supervisor owns the state machine). */
    onInstanceState?: (record: Record<string, unknown>, connection: PluginSocketConnection) => void;
}

export interface CommandRequest {
    id: string;
    sessionId?: string;
    method: string;
    params?: Record<string, unknown>;
    clientRequestId?: string;
}

export interface CommandAck {
    seq?: number;
    disposition?: string;
    /** Command result fields (the plugin's `ack.payload`), spread for callers. */
    [key: string]: unknown;
}

interface PendingCommand {
    method: string;
    resolve: (ack: CommandAck) => void;
    reject: (error: InstanceError) => void;
    timer: NodeJS.Timeout;
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

export class PluginSocketConnection implements PluginConnection {
    readonly instanceId: string;
    readonly workspaceId: string;
    readonly cwd: string;
    readonly pid: number;
    readonly hasUI: boolean;
    readonly listenAddr: string | null;
    readonly pluginVersion: string;
    readonly capabilities: string[];

    /** Resolves exactly once when the connection is torn down (socket close, heartbeat, shutdown). */
    readonly closedPromise: Promise<void>;

    private readonly socket: Socket;
    private readonly bus: Bus;
    private readonly logger: Logger | undefined;
    private readonly now: () => number;
    private readonly maxWriteQueueBytes: number;
    private readonly onInstanceState:
        | ((record: Record<string, unknown>, connection: PluginSocketConnection) => void)
        | undefined;

    private readonly pending = new Map<string, PendingCommand>();
    private readonly snapshots = new Map<string, SnapshotCacheEntry>();
    /** Per session: the highest seq seen *within the current epoch*. */
    private readonly seqs = new Map<string, { epoch: string; seq: number }>();
    private readonly sessions = new Set<string>();
    private readonly resolveClosed: () => void;

    private closed = false;
    private dropNoticeSent = false;
    private droppedRecords = 0;
    private closeReasonValue: string | undefined;

    constructor(options: PluginSocketConnectionOptions) {
        this.socket = options.socket;
        this.bus = options.bus;
        this.logger = options.logger;
        this.now = options.now ?? Date.now;
        this.maxWriteQueueBytes = options.maxWriteQueueBytes ?? DEFAULT_MAX_WRITE_QUEUE_BYTES;
        this.onInstanceState = options.onInstanceState;

        this.instanceId = options.hello.instanceId;
        this.workspaceId = options.hello.workspaceId;
        this.cwd = options.hello.cwd;
        this.pid = options.hello.pid;
        this.hasUI = options.hello.hasUI;
        this.listenAddr = options.hello.listenAddr;
        this.pluginVersion = options.hello.pluginVersion;
        this.capabilities = options.hello.capabilities ?? [];

        let resolveClosed: (() => void) | undefined;
        this.closedPromise = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        this.resolveClosed = resolveClosed as () => void;
    }

    /** True once the peer went away or `close()` was called. */
    get isClosed(): boolean {
        return this.closed;
    }

    get closeReason(): string | undefined {
        return this.closeReasonValue;
    }

    get pendingCommands(): number {
        return this.pending.size;
    }

    get droppedCount(): number {
        return this.droppedRecords;
    }

    send(record: Record<string, unknown>): void {
        if (this.closed || this.socket.destroyed) return;
        const line = JSON.stringify({ v: PROTOCOL_VERSION, ...record }) + "\n";
        const bytes = Buffer.byteLength(line, "utf8");

        if (this.socket.writableLength + bytes > this.maxWriteQueueBytes) {
            const type = record.type;
            if (type === "event") {
                // Low-priority records are dropped first (docs/protocol.md §2).
                this.droppedRecords += 1;
                if (!this.dropNoticeSent) {
                    this.dropNoticeSent = true;
                    const sessionId = asString(record.sessionId);
                    this.bus.publish({
                        v: PROTOCOL_VERSION,
                        type: "dropped",
                        workspaceId: this.workspaceId,
                        ...(sessionId === undefined ? {} : { sessionId }),
                        payload: { reason: "backpressure" },
                    });
                }
                return;
            }
            // Control records must not be dropped: the write queue would grow unbounded.
            this.logger?.warn("plugin write queue overflow, closing connection", {
                instanceId: this.instanceId,
                workspaceId: this.workspaceId,
                type: typeof type === "string" ? type : "unknown",
                queuedBytes: this.socket.writableLength,
            });
            this.close("write queue overflow");
            return;
        }

        try {
            this.socket.write(line);
        } catch (error) {
            this.logger?.debug("plugin send failed", {
                instanceId: this.instanceId,
                error: errorMessage(error),
            });
        }
    }

    command(request: CommandRequest, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<CommandAck> {
        if (this.closed || this.socket.destroyed) {
            return Promise.reject(
                InstanceError.unavailable(`instance ${this.instanceId} is not connected`, {
                    workspaceId: this.workspaceId,
                }),
            );
        }
        if (this.pending.has(request.id)) {
            return Promise.reject(
                new InstanceError(ERROR_CODES.BAD_REQUEST, `duplicate command id ${request.id}`),
            );
        }

        return new Promise<CommandAck>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(request.id);
                reject(InstanceError.timeout(`command ${request.method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref?.();

            this.pending.set(request.id, { method: request.method, resolve, reject, timer });
            this.send({
                type: "cmd",
                id: request.id,
                ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
                payload: {
                    method: request.method,
                    ...(request.params === undefined ? {} : { params: request.params }),
                    ...(request.clientRequestId === undefined
                        ? {}
                        : { clientRequestId: request.clientRequestId }),
                },
            });
        });
    }

    subscribe(sessionId: string): void {
        this.send({ type: "sub.subscribe", sessionId });
    }

    unsubscribe(sessionId: string): void {
        this.send({ type: "sub.unsubscribe", sessionId });
    }

    snapshot(sessionId: string): SessionState | undefined {
        return this.snapshots.get(sessionId)?.state;
    }

    lastSeq(sessionId: string): number {
        return this.seqs.get(sessionId)?.seq ?? 0;
    }

    /** Session ids seen via `instance_state`, `snapshot` or `event` records. */
    sessionIds(): string[] {
        return [...this.sessions];
    }

    hasSession(sessionId: string): boolean {
        return this.sessions.has(sessionId);
    }

    /** The full cached snapshot: `state` plus the plugin's optional `entries` tail. */
    snapshotEntry(sessionId: string): SnapshotCacheEntry | undefined {
        return this.snapshots.get(sessionId);
    }

    close(reason: string): void {
        if (this.closed) return;
        this.closeReasonValue = reason;
        this.logger?.debug("closing plugin connection", {
            instanceId: this.instanceId,
            workspaceId: this.workspaceId,
            reason,
        });
        try {
            this.socket.end();
        } catch (error) {
            this.logger?.debug("plugin socket end failed", { error: errorMessage(error) });
        }
        // The server's "close" handler calls `notifyClosed`; destroy guarantees prompt cleanup.
        this.socket.destroy();
    }

    /** Server hook: the socket is gone, fail in-flight work and notify once. */
    notifyClosed(reason?: string): void {
        if (this.closed) return;
        this.closed = true;
        this.closeReasonValue = reason ?? this.closeReasonValue ?? "socket closed";

        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(
                InstanceError.unavailable(
                    `connection to ${this.instanceId} closed before ${pending.method} completed (${this.closeReasonValue})`,
                    { workspaceId: this.workspaceId },
                ),
            );
        }
        this.pending.clear();
        this.resolveClosed();
    }

    /** Server hook: one framed JSON record from the plugin. */
    handleRecord(record: Record<string, unknown>): void {
        if (this.closed) return;
        const type = asString(record.type);
        switch (type) {
            case "ack":
                this.handleAck(record);
                return;
            case "error":
                this.handleError(record);
                return;
            case "snapshot":
                this.handleSnapshot(record);
                return;
            case "event":
                this.handleEvent(record);
                return;
            case "instance_state":
                this.handleInstanceState(record);
                return;
            case "bye":
                this.notifyClosed("plugin said bye");
                return;
            case "hello":
            case "hello_ack":
            case "presence":
            case "workspace_update":
                return;
            default:
                this.logger?.debug("unhandled plugin record", {
                    instanceId: this.instanceId,
                    type: type ?? "missing",
                });
        }
    }

    private handleAck(record: Record<string, unknown>): void {
        const id = asString(record.id);
        if (id === undefined) return;
        const payload = isRecord(record.payload) ? record.payload : {};
        const seq = asNumber(record.seq) ?? asNumber(payload.seq);
        const sessionId = asString(record.sessionId);
        if (sessionId !== undefined && seq !== undefined) this.recordSeq(sessionId, this.epochFor(sessionId), seq);

        const pending = this.pending.get(id);
        if (!pending) {
            this.logger?.debug("ack for unknown command", { instanceId: this.instanceId, id });
            return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        const disposition = asString(payload.disposition);
        pending.resolve({
            ...payload,
            ...(seq === undefined ? {} : { seq }),
            ...(disposition === undefined ? {} : { disposition }),
        });
    }

    private handleError(record: Record<string, unknown>): void {
        const id = asString(record.id);
        const payload = isRecord(record.payload) ? record.payload : {};
        const code = asString(payload.code) ?? ERROR_CODES.INTERNAL;
        const message = asString(payload.message) ?? "plugin command failed";
        const retryable = payload.retryable === true;

        if (id === undefined) {
            this.logger?.warn("plugin error without id", { instanceId: this.instanceId, code, message });
            return;
        }
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new InstanceError(code, message, retryable));
    }

    private handleSnapshot(record: Record<string, unknown>): void {
        const sessionId = asString(record.sessionId);
        if (sessionId === undefined) return;
        this.sessions.add(sessionId);

        const epoch = asString(record.epoch) ?? this.instanceId;
        const seq = asNumber(record.seq) ?? this.lastSeq(sessionId);
        this.recordSeq(sessionId, epoch, seq);

        const payload = isRecord(record.payload) ? record.payload : {};
        const state = isRecord(payload.state) ? (payload.state as unknown as SessionState) : undefined;
        // docs/protocol.md §2: `snapshot` carries `{state, entries[]}` — the tail is
        // authoritative plugin data, not something the daemon may drop.
        const entries = Array.isArray(payload.entries) ? (payload.entries as Entry[]) : undefined;

        const cached = this.snapshots.get(sessionId);
        if (cached !== undefined && cached.epoch !== epoch) {
            // Epoch changed: the cached render state is useless.
            this.snapshots.delete(sessionId);
        }
        if (state === undefined) return;
        const previous = this.snapshots.get(sessionId);
        this.snapshots.set(sessionId, {
            epoch,
            seq: previous !== undefined && previous.epoch === epoch ? Math.max(previous.seq, seq) : seq,
            state,
            ...(entries === undefined ? {} : { entries }),
        });

        // Forward plugin snapshots so browsers subscribed to the session get the
        // authoritative state (the WS server fans bus records out to subscribers).
        this.bus.publish({
            v: PROTOCOL_VERSION,
            type: "snapshot",
            workspaceId: this.workspaceId,
            sessionId,
            epoch,
            seq,
            ts: asNumber(record.ts) ?? this.now(),
            payload,
        });
    }

    private handleEvent(record: Record<string, unknown>): void {
        const sessionId = asString(record.sessionId);
        if (sessionId === undefined) return;
        this.sessions.add(sessionId);

        const epoch = asString(record.epoch) ?? this.instanceId;
        const seq = asNumber(record.seq) ?? this.lastSeq(sessionId);
        this.recordSeq(sessionId, epoch, seq);

        const payload = isRecord(record.payload) ? record.payload : {};
        const event = isRecord(payload.event) ? payload.event : payload;
        const ts = asNumber(record.ts) ?? asNumber(event.ts) ?? this.now();

        this.bus.publish({
            v: PROTOCOL_VERSION,
            type: "event",
            workspaceId: this.workspaceId,
            sessionId,
            epoch,
            seq,
            ts,
            ...(asNumber(record.mono) === undefined ? {} : { mono: record.mono }),
            ...(isRecord(record.origin) ? { origin: record.origin } : {}),
            payload: { event },
        });
    }

    private handleInstanceState(record: Record<string, unknown>): void {
        const payload = isRecord(record.payload) ? record.payload : {};
        if (Array.isArray(payload.sessions)) {
            for (const session of payload.sessions) {
                if (typeof session === "string") {
                    this.sessions.add(session);
                } else if (isRecord(session)) {
                    const sessionId = asString(session.sessionId);
                    if (sessionId !== undefined) this.sessions.add(sessionId);
                }
            }
        }
        this.onInstanceState?.(record, this);
    }

    private epochFor(sessionId: string): string {
        return this.seqs.get(sessionId)?.epoch ?? this.instanceId;
    }

    /** `seq` is only comparable within one epoch (docs/protocol.md §1). */
    private recordSeq(sessionId: string, epoch: string, seq: number): void {
        const previous = this.seqs.get(sessionId);
        if (previous === undefined || previous.epoch !== epoch) {
            this.seqs.set(sessionId, { epoch, seq });
            return;
        }
        if (seq > previous.seq) previous.seq = seq;
    }
}
