/**
 * Browser WebSocket surface (`/ws`).
 *
 * Auth happens in the first message (`{type:"auth",token}`) or via an
 * `Authorization: Bearer` upgrade header. Subscriptions fan records out from
 * the daemon bus; every connection has a bounded write buffer.
 */
import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Bus, InstanceManager, Logger, PluginConnection } from "../core/interfaces.js";
import type { Entry, InstanceState, SessionState } from "../protocol/types.js";
import { ERROR_CODES, errorBody } from "../protocol/errors.js";
import { isAllowedOrigin, type AuthStore, type DevicePublic } from "./auth.js";
import type { Config } from "../config.js";
import { toErrorPayload } from "./errors.js";

const SERVER_TYPES = new Set([
    "hello_ack",
    "instance_state",
    "workspace_update",
    "snapshot",
    "event",
    "presence",
    "resync_required",
    "error",
]);

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_BAD_MESSAGE = 4400;
const CLOSE_TRY_AGAIN = 1013;
/** How long a fresh subscription waits for the plugin's `snapshot`. */
export const DEFAULT_SNAPSHOT_WAIT_MS = 1_500;
const SNAPSHOT_POLL_MS = 20;

export interface WsServerOptions {
    server: Server;
    config: Config;
    auth: AuthStore;
    instances: InstanceManager;
    bus: Bus;
    logger?: Logger;
    daemonId?: string;
    now?: () => number;
    heartbeatMs?: number;
    authTimeoutMs?: number;
    snapshotWaitMs?: number;
    maxBufferedBytes?: number;
    closeBufferedBytes?: number;
    maxConnections?: number;
    measureBufferedAmount?: (socket: WebSocket) => number;
}

export interface WsServerHandle {
    wss: WebSocketServer;
    connections(): number;
    eventsSent(): number;
    close(): Promise<void>;
}

interface PendingSince {
    sessionId: string;
    epoch: string;
    seq: number;
}

interface ClientState {
    ws: WebSocket;
    device: DevicePublic | null;
    authenticated: boolean;
    workspaceIds: Set<string>;
    sessionWorkspaces: Map<string, string>;
    /** Last snapshot (epoch, seq) sent, so a bus echo is not duplicated. */
    snapshotsSent: Map<string, { epoch: string; seq: number }>;
    alive: boolean;
    dropped: boolean;
    authTimer: NodeJS.Timeout | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

/** Cached snapshot: `state` plus the plugin's optional `entries` tail (docs/protocol.md §2). */
interface CachedSnapshot {
    state: SessionState;
    entries?: Entry[];
}

/**
 * `PluginSocketConnection` caches the whole plugin snapshot, but the frozen
 * `PluginConnection` interface only exposes `state`. Duck-type the richer
 * accessor so the documented `entries` tail survives the relay to browsers;
 * implementations without it simply relay state.
 */
function readSnapshot(connection: PluginConnection, sessionId: string): CachedSnapshot | undefined {
    const richer = connection as PluginConnection & {
        snapshotEntry?: (id: string) => { state: SessionState; entries?: Entry[] } | undefined;
    };
    const entry = richer.snapshotEntry?.(sessionId);
    if (entry !== undefined) {
        return { state: entry.state, ...(entry.entries === undefined ? {} : { entries: entry.entries }) };
    }
    const state = connection.snapshot(sessionId);
    return state === undefined ? undefined : { state };
}

function writeUpgradeRejection(socket: Duplex, status: number, code: string, message: string): void {
    const body = JSON.stringify(errorBody(code, message));
    const reason = status === 403 ? "Forbidden" : status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Service Unavailable";
    socket.end(
        `HTTP/1.1 ${status} ${reason}\r\n` +
            "Connection: close\r\n" +
            "Content-Type: application/json; charset=utf-8\r\n" +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
            body,
    );
}

function bearerToken(header: string | string[] | undefined): string | undefined {
    const value = Array.isArray(header) ? header[0] : header;
    if (typeof value !== "string") return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(value.trim());
    return match?.[1]?.trim();
}

export function attachWsServer(options: WsServerOptions): WsServerHandle {
    const {
        server,
        config,
        auth,
        instances,
        bus,
        logger,
        daemonId = "d-local",
        now = Date.now,
        heartbeatMs = 30_000,
        authTimeoutMs = 10_000,
        snapshotWaitMs = DEFAULT_SNAPSHOT_WAIT_MS,
        maxBufferedBytes = 4 * 1024 * 1024,
        closeBufferedBytes = 8 * 1024 * 1024,
        maxConnections = config.limits.maxConnections,
        measureBufferedAmount = (socket: WebSocket) => socket.bufferedAmount,
    } = options;

    const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxFrameBytes });
    const clients = new Set<ClientState>();
    let eventsSent = 0;
    let closed = false;

    const send = (state: ClientState, record: Record<string, unknown>): void => {
        if (state.ws.readyState !== WebSocket.OPEN) return;
        try {
            state.ws.send(JSON.stringify(record));
        } catch (error) {
            logger?.debug("ws send failed", { error: error instanceof Error ? error.message : String(error) });
        }
    };

    const sendError = (state: ClientState, code: string, message: string): void => {
        send(state, { v: 1, type: "error", payload: errorBody(code, message) });
    };

    const sendEvent = (state: ClientState, record: Record<string, unknown>): void => {
        if (state.ws.readyState !== WebSocket.OPEN) return;
        let buffered: number;
        try {
            buffered = measureBufferedAmount(state.ws);
        } catch {
            buffered = state.ws.bufferedAmount;
        }
        if (buffered > closeBufferedBytes) {
            state.ws.close(CLOSE_TRY_AGAIN, "buffer overflow");
            return;
        }
        if (buffered > maxBufferedBytes) {
            if (!state.dropped) {
                state.dropped = true;
                send(state, { v: 1, type: "dropped", payload: { reason: "backpressure" }, ts: now() });
            }
            return;
        }
        state.dropped = false;
        eventsSent += 1;
        send(state, record);
    };

    const hello = (state: ClientState): void => {
        if (!state.device) return;
        send(state, {
            v: 1,
            type: "hello_ack",
            daemonId,
            limits: { maxFrameBytes: config.limits.maxFrameBytes },
            device: {
                id: state.device.id,
                name: state.device.name,
                kind: state.device.kind,
                scopes: state.device.scopes,
            },
        });
    };

    const authenticate = (state: ClientState, token: string | undefined): boolean => {
        if (!token) return false;
        const device = auth.verifyToken(token);
        if (!device) return false;
        state.device = device;
        state.authenticated = true;
        state.alive = true;
        if (state.authTimer) {
            clearTimeout(state.authTimer);
            state.authTimer = undefined;
        }
        auth.touchDevice(device.id);
        hello(state);
        return true;
    };

    const releaseSession = (state: ClientState, sessionId: string): void => {
        const workspaceId = state.sessionWorkspaces.get(sessionId);
        state.sessionWorkspaces.delete(sessionId);
        state.snapshotsSent.delete(sessionId);
        if (!workspaceId) return;
        const others = [...clients].some(
            (other) => other !== state && other.authenticated && other.sessionWorkspaces.has(sessionId),
        );
        if (others) return;
        const connection = instances.get(workspaceId);
        connection?.unsubscribe(sessionId);
        instances.maybeUnsubscribe(workspaceId, sessionId);
    };

    const epochFor = (workspaceId: string, state: InstanceState | undefined): string => {
        if (state) return state.instanceId;
        return instances.list().find((candidate) => candidate.workspaceId === workspaceId)?.instanceId ?? workspaceId;
    };

    const sendSnapshot = (
        state: ClientState,
        sessionId: string,
        epoch: string,
        seq: number,
        snapshot: CachedSnapshot,
    ): void => {
        const previous = state.snapshotsSent.get(sessionId);
        if (previous !== undefined && previous.epoch === epoch && previous.seq === seq) return;
        state.snapshotsSent.set(sessionId, { epoch, seq });
        send(state, {
            v: 1,
            type: "snapshot",
            sessionId,
            epoch,
            seq,
            ts: now(),
            // docs/protocol.md §2: a snapshot payload is `{state, entries[]}`. The
            // tail is relayed verbatim and only omitted when the plugin omitted it.
            payload:
                snapshot.entries === undefined
                    ? { state: snapshot.state }
                    : { state: snapshot.state, entries: snapshot.entries },
        });
    };

    /**
     * The plugin answers every `sub.subscribe` with a snapshot, but the reply is
     * asynchronous. A fresh browser subscription therefore polls the connection
     * cache briefly instead of returning no state at all (the first-subscribe bug).
     */
    const waitForSnapshot = async (
        connection: PluginConnection,
        sessionId: string,
        timeoutMs: number,
    ): Promise<CachedSnapshot | undefined> => {
        const attempts = Math.max(1, Math.ceil(timeoutMs / SNAPSHOT_POLL_MS));
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            const snapshot = readSnapshot(connection, sessionId);
            if (snapshot !== undefined) return snapshot;
            if (attempt < attempts - 1) await delay(SNAPSHOT_POLL_MS);
        }
        return readSnapshot(connection, sessionId);
    };

    const subscribeSession = async (
        state: ClientState,
        sessionId: string,
        workspaceHint: string | undefined,
        since: PendingSince | undefined,
    ): Promise<void> => {
        if (typeof sessionId !== "string" || sessionId === "") {
            sendError(state, ERROR_CODES.BAD_REQUEST, "sessionId is required");
            return;
        }
        const workspaceId = workspaceHint ?? instances.findWorkspaceBySession(sessionId);
        if (!workspaceId) {
            sendError(state, ERROR_CODES.SESSION_NOT_FOUND, `unknown session ${sessionId}`);
            return;
        }

        state.sessionWorkspaces.set(sessionId, workspaceId);
        const instanceState = await instances.ensure(workspaceId);
        const connection = instances.get(workspaceId);
        if (!connection) {
            sendError(state, ERROR_CODES.INSTANCE_UNAVAILABLE, `no instance for workspace ${workspaceId}`);
            return;
        }
        connection.subscribe(sessionId);

        const epoch = epochFor(workspaceId, instanceState);
        const lastSeq = connection.lastSeq(sessionId);
        if (since) {
            if (since.epoch !== epoch || since.seq > lastSeq) {
                send(state, {
                    v: 1,
                    type: "resync_required",
                    sessionId,
                    epoch,
                    seq: lastSeq,
                    payload: { requestedEpoch: since.epoch, requestedSeq: since.seq, lastSeq },
                });
                return;
            }
        }
        const cached = readSnapshot(connection, sessionId);
        if (cached) {
            sendSnapshot(state, sessionId, epoch, lastSeq, cached);
            return;
        }

        const snapshot = await waitForSnapshot(connection, sessionId, snapshotWaitMs);
        if (snapshot === undefined) {
            logger?.debug("no plugin snapshot after subscribe", { sessionId, workspaceId });
            return;
        }
        // The cache may have advanced (or the epoch changed) while we waited.
        sendSnapshot(state, sessionId, epochFor(workspaceId, instanceState), connection.lastSeq(sessionId), snapshot);
    };

    const subscribe = async (state: ClientState, payload: Record<string, unknown>): Promise<void> => {
        const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : undefined;
        const workspaceHint = typeof payload.workspaceId === "string" ? payload.workspaceId : undefined;
        if (workspaceId) {
            state.workspaceIds.add(workspaceId);
            await instances.ensure(workspaceId);
        }

        const sessionIds = Array.isArray(payload.sessionIds)
            ? payload.sessionIds.filter((value): value is string => typeof value === "string")
            : [];
        if (typeof payload.sessionId === "string") sessionIds.push(payload.sessionId);

        let since: PendingSince | undefined;
        if (typeof payload.since === "object" && payload.since !== null) {
            const raw = payload.since as Record<string, unknown>;
            if (
                typeof raw.sessionId === "string" &&
                typeof raw.epoch === "string" &&
                typeof raw.seq === "number"
            ) {
                since = { sessionId: raw.sessionId, epoch: raw.epoch, seq: raw.seq };
                sessionIds.push(raw.sessionId);
            }
        }

        if (!workspaceId && sessionIds.length === 0) {
            sendError(state, ERROR_CODES.BAD_REQUEST, "subscribe requires workspaceId or sessionIds");
            return;
        }

        for (const sessionId of new Set(sessionIds)) {
            await subscribeSession(state, sessionId, workspaceHint, since?.sessionId === sessionId ? since : undefined);
        }
    };

    const unsubscribe = (state: ClientState, payload: Record<string, unknown>): void => {
        const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : undefined;
        if (workspaceId) state.workspaceIds.delete(workspaceId);

        const sessionIds = Array.isArray(payload.sessionIds)
            ? payload.sessionIds.filter((value): value is string => typeof value === "string")
            : [];
        if (typeof payload.sessionId === "string") sessionIds.push(payload.sessionId);
        for (const sessionId of sessionIds) releaseSession(state, sessionId);
    };

    const handleMessage = async (state: ClientState, raw: RawData): Promise<void> => {
        state.alive = true;
        let message: Record<string, unknown>;
        try {
            message = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
            sendError(state, ERROR_CODES.BAD_REQUEST, "malformed JSON");
            state.ws.close(CLOSE_BAD_MESSAGE, "malformed JSON");
            return;
        }
        const type = typeof message.type === "string" ? message.type : "";
        if (!state.authenticated) {
            const payload = message.payload as Record<string, unknown> | undefined;
            const authToken =
                typeof message.token === "string"
                    ? message.token
                    : payload && typeof payload.token === "string"
                      ? payload.token
                      : undefined;
            if (type !== "auth" || typeof authToken !== "string") {
                sendError(state, ERROR_CODES.UNAUTHORIZED, "authenticate first");
                state.ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
                return;
            }
            if (!authenticate(state, authToken)) {
                sendError(state, ERROR_CODES.UNAUTHORIZED, "invalid device token");
                state.ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
            }
            return;
        }

        switch (type) {
            case "ping":
                send(state, { v: 1, type: "pong", ts: now() });
                return;
            case "auth":
                return;
            case "subscribe": {
                const payload =
                    typeof message.payload === "object" && message.payload !== null
                        ? (message.payload as Record<string, unknown>)
                        : {};
                try {
                    await subscribe(state, payload);
                } catch (error) {
                    const mapped = toErrorPayload(error);
                    sendError(state, mapped.body.code, mapped.body.message);
                }
                return;
            }
            case "unsubscribe": {
                const payload =
                    typeof message.payload === "object" && message.payload !== null
                        ? (message.payload as Record<string, unknown>)
                        : {};
                unsubscribe(state, payload);
                return;
            }
            default:
                sendError(state, ERROR_CODES.BAD_REQUEST, `unknown message type "${type}"`);
        }
    };

    const onUpgrade = (request: import("node:http").IncomingMessage, socket: Duplex, head: Buffer): void => {
        if (closed) {
            socket.destroy();
            return;
        }
        const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
        if (!isAllowedOrigin(origin, config.corsOrigins)) {
            writeUpgradeRejection(socket, 403, ERROR_CODES.FORBIDDEN, "origin is not allowed");
            return;
        }

        let pathname: string;
        try {
            pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        } catch {
            writeUpgradeRejection(socket, 400, ERROR_CODES.BAD_REQUEST, "malformed URL");
            return;
        }
        if (pathname !== "/ws" && pathname !== "/ws/") {
            writeUpgradeRejection(socket, 404, ERROR_CODES.NOT_FOUND, "unknown upgrade path");
            return;
        }
        if (clients.size >= maxConnections) {
            writeUpgradeRejection(socket, 503, ERROR_CODES.RATE_LIMITED, "too many connections");
            return;
        }

        const headerToken = bearerToken(request.headers.authorization);
        if (request.headers.authorization !== undefined && headerToken === undefined) {
            writeUpgradeRejection(socket, 401, ERROR_CODES.UNAUTHORIZED, "authorization must be a bearer token");
            return;
        }

        let device: DevicePublic | null = null;
        if (headerToken !== undefined) {
            device = auth.verifyToken(headerToken);
            if (!device) {
                writeUpgradeRejection(socket, 401, ERROR_CODES.UNAUTHORIZED, "invalid device token");
                return;
            }
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            const state: ClientState = {
                ws,
                device,
                authenticated: device !== null,
                workspaceIds: new Set(),
                sessionWorkspaces: new Map(),
                snapshotsSent: new Map(),
                alive: true,
                dropped: false,
                authTimer: undefined,
            };
            clients.add(state);
            if (device) {
                auth.touchDevice(device.id);
                hello(state);
            } else {
                state.authTimer = setTimeout(() => {
                    if (!state.authenticated) {
                        sendError(state, ERROR_CODES.UNAUTHORIZED, "authentication timeout");
                        state.ws.close(CLOSE_UNAUTHORIZED, "unauthorized");
                    }
                }, authTimeoutMs);
                state.authTimer.unref?.();
            }

            ws.on("message", (data) => {
                void handleMessage(state, data);
            });
            ws.on("pong", () => {
                state.alive = true;
            });
            ws.on("close", () => {
                if (state.authTimer) clearTimeout(state.authTimer);
                state.authTimer = undefined;
                for (const sessionId of [...state.sessionWorkspaces.keys()]) {
                    releaseSession(state, sessionId);
                }
                clients.delete(state);
            });
            ws.on("error", (error) => {
                logger?.debug("ws connection error", { error: error.message });
            });
        });
    };

    server.on("upgrade", onUpgrade);

    const unsubscribeBus = bus.subscribe((record) => {
        const type = typeof record.type === "string" ? record.type : "";
        if (!SERVER_TYPES.has(type)) return;
        const sessionId = typeof record.sessionId === "string" ? record.sessionId : undefined;
        const workspaceId =
            typeof record.workspaceId === "string"
                ? record.workspaceId
                : sessionId === undefined
                  ? undefined
                  : instances.findWorkspaceBySession(sessionId);
        for (const state of clients) {
            if (!state.authenticated) continue;
            const sessionMatch = sessionId !== undefined && state.sessionWorkspaces.has(sessionId);
            const workspaceMatch = workspaceId !== undefined && state.workspaceIds.has(workspaceId);
            if (!sessionMatch && !workspaceMatch) continue;

            // The plugin's snapshot (published by PluginSocketConnection) is state,
            // not an event: deliver it through the snapshot path so the client
            // render cache is replaced rather than replayed as a delta.
            if (type === "snapshot" && sessionId !== undefined) {
                const payload = isRecord(record.payload) ? record.payload : {};
                const snapshot = isRecord(payload.state) ? (payload.state as unknown as SessionState) : undefined;
                if (snapshot !== undefined) {
                    // The plugin's `entries` tail rides along with the state it
                    // belongs to; dropping it would break the documented payload.
                    const entries = Array.isArray(payload.entries) ? (payload.entries as Entry[]) : undefined;
                    const relayed: CachedSnapshot =
                        entries === undefined ? { state: snapshot } : { state: snapshot, entries };
                    const fallbackWorkspace = workspaceId ?? state.sessionWorkspaces.get(sessionId) ?? "";
                    const epoch =
                        typeof record.epoch === "string" ? record.epoch : epochFor(fallbackWorkspace, undefined);
                    const seq = typeof record.seq === "number" ? record.seq : 0;
                    sendSnapshot(state, sessionId, epoch, seq, relayed);
                    continue;
                }
            }
            sendEvent(state, record);
        }
    });

    const heartbeat = setInterval(() => {
        for (const state of clients) {
            if (!state.alive) {
                state.ws.terminate();
                continue;
            }
            state.alive = false;
            try {
                state.ws.ping();
            } catch {
                state.ws.terminate();
            }
        }
    }, heartbeatMs);
    heartbeat.unref?.();

    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        server.off("upgrade", onUpgrade);
        unsubscribeBus();
        clearInterval(heartbeat);
        for (const state of clients) {
            if (state.authTimer) clearTimeout(state.authTimer);
            state.ws.terminate();
        }
        clients.clear();
        await new Promise<void>((resolve) => {
            wss.close(() => resolve());
        });
    };

    return {
        wss,
        connections: () => clients.size,
        eventsSent: () => eventsSent,
        close,
    };
}
