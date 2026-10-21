/**
 * Reconnecting WebSocket client for the pi2 daemon.
 *
 * Frame flow (docs/protocol.md §1/§3.3):
 *   connect → socket open → auth frame → hello_ack → open (subscriptions flush)
 *   snapshot replaces the render cache and establishes `(epoch, seq)`
 *   event increments `seq`; reconnect resubscribes with `since` for a lossless resume
 *
 * The frame envelope is shared with the daemon (`v`, `type`, `id`, `payload`).
 * The auth frame is the first frame on every socket, before any subscribe.
 */

export type WsConnectionState = "idle" | "connecting" | "authenticating" | "open" | "reconnecting" | "closed";

export interface WsFrame {
    v?: number;
    type: string;
    id?: string;
    workspaceId?: string;
    sessionId?: string;
    epoch?: string;
    seq?: number;
    ts?: number;
    payload?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface WsSnapshotMessage {
    sessionId: string;
    epoch?: string;
    seq: number;
    payload: unknown;
}

export interface WsEventMessage {
    sessionId: string;
    epoch?: string;
    seq: number;
    payload: unknown;
    ts?: number;
}

export interface WsHandlers {
    onState?: (state: WsConnectionState) => void;
    onHelloAck?: () => void;
    onSnapshot?: (snapshot: WsSnapshotMessage) => void;
    onEvent?: (event: WsEventMessage) => void;
    onResyncRequired?: (frame: WsFrame) => void;
    onError?: (error: Error, frame?: WsFrame) => void;
}

/** Minimal surface the client needs; lets tests inject a fake socket. */
export interface WebSocketLike {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => WebSocketLike;

export interface PiWsOptions {
    url: string;
    token?: string | null;
    socketFactory?: SocketFactory;
    initialBackoffMs?: number;
    maxBackoffMs?: number;
    backoffMultiplier?: number;
    authTimeoutMs?: number;
    /** 0 disables the keep-alive ping. */
    heartbeatMs?: number;
    handlers?: WsHandlers;
}

const AUTH_FRAME_TYPE = "auth";

/** `Authorization: Bearer <token>` prefix, the shape `setDeviceToken()` stores. */
const BEARER_PREFIX = /^bearer(?:\s+|$)/i;

/**
 * Unwrap an `Authorization: Bearer` style token for the WS auth frame.
 *
 * `setDeviceToken()` persists the token as `Bearer <token>` (the HTTP client
 * strips the prefix in `authHeader()`), but the daemon hashes the auth-frame
 * string verbatim in `verifyToken()` and does not understand the prefix. Sending
 * it unchanged makes every authenticated socket fail with `E_UNAUTHORIZED`.
 *
 * @param token Token as stored (`abc` or `Bearer abc`).
 * @returns The bare token, or `undefined` when there is nothing to send.
 */
export function normalizeDeviceToken(token: string | null | undefined): string | undefined {
    if (typeof token !== "string") return undefined;
    const stripped = token.trim().replace(BEARER_PREFIX, "").trim();
    return stripped.length ? stripped : undefined;
}

function defaultFactory(url: string): WebSocketLike {
    return new WebSocket(url) as unknown as WebSocketLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object";
}

export class PiWsClient {
    private readonly url: string;
    private readonly socketFactory: SocketFactory;
    private readonly initialBackoffMs: number;
    private readonly maxBackoffMs: number;
    private readonly backoffMultiplier: number;
    private readonly authTimeoutMs: number;
    private readonly heartbeatMs: number;

    private handlers: WsHandlers;
    private socket: WebSocketLike | null = null;
    private state: WsConnectionState = "idle";
    private token: string | null;
    private attempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private authTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private manuallyClosed = false;
    private readonly subscriptions = new Set<string>();
    private readonly lastSeq = new Map<string, number>();
    private readonly epochs = new Map<string, string>();

    constructor(options: PiWsOptions) {
        this.url = options.url;
        this.token = options.token ?? null;
        this.socketFactory = options.socketFactory ?? defaultFactory;
        this.initialBackoffMs = options.initialBackoffMs ?? 200;
        this.maxBackoffMs = options.maxBackoffMs ?? 5_000;
        this.backoffMultiplier = options.backoffMultiplier ?? 2;
        this.authTimeoutMs = options.authTimeoutMs ?? 8_000;
        this.heartbeatMs = options.heartbeatMs ?? 25_000;
        this.handlers = options.handlers ?? {};
    }

    getState(): WsConnectionState {
        return this.state;
    }

    getLastSeq(sessionId: string): number | undefined {
        return this.lastSeq.get(sessionId);
    }

    getEpoch(sessionId: string): string | undefined {
        return this.epochs.get(sessionId);
    }

    setHandlers(handlers: WsHandlers): void {
        this.handlers = { ...this.handlers, ...handlers };
    }

    setToken(token: string | null): void {
        this.token = token;
    }

    connect(): void {
        if (this.state === "connecting" || this.state === "authenticating" || this.state === "open") return;
        this.manuallyClosed = false;
        this.openSocket();
    }

    /**
     * Stop reconnecting and close the socket. A later `connect()` starts over
     * (used by the connection store when the user re-pairs).
     */
    close(): void {
        this.manuallyClosed = true;
        this.clearReconnectTimer();
        this.clearAuthTimer();
        this.stopHeartbeat();
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onclose = null;
            socket.onerror = null;
            try {
                socket.close(1000, "client closed");
            } catch {
                /* already closed */
            }
        }
        this.setState("closed");
    }

    /** Subscribe to one or more sessions; queued until the socket is authenticated. */
    subscribe(sessionIds: string | string[]): void {
        const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
        for (const id of ids) if (id) this.subscriptions.add(id);
        if (this.state === "open") this.sendSubscribe(ids.filter(Boolean));
    }

    unsubscribe(sessionIds: string | string[]): void {
        const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
        for (const id of ids) {
            this.subscriptions.delete(id);
            this.lastSeq.delete(id);
            this.epochs.delete(id);
        }
        if (this.state === "open" && ids.length) {
            this.send({ v: 1, type: "unsubscribe", payload: { sessionIds: ids } });
        }
    }

    getSubscriptions(): string[] {
        return [...this.subscriptions];
    }

    private setState(next: WsConnectionState): void {
        if (this.state === next) return;
        this.state = next;
        this.handlers.onState?.(next);
    }

    private openSocket(): void {
        this.clearReconnectTimer();
        this.setState(this.attempt > 0 ? "reconnecting" : "connecting");

        let socket: WebSocketLike;
        try {
            socket = this.socketFactory(this.url);
        } catch (error) {
            this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;

        socket.onopen = () => {
            if (this.socket !== socket) return;
            this.setState("authenticating");
            // Normalized on every socket (not cached) so a re-partnered token is
            // picked up by the next reconnect too.
            this.send({ v: 1, type: AUTH_FRAME_TYPE, token: normalizeDeviceToken(this.token) });
            this.authTimer = setTimeout(() => {
                if (this.state !== "authenticating" || this.socket !== socket) return;
                this.handlers.onError?.(new Error("WebSocket auth timed out"));
                this.dropSocket(socket);
                this.scheduleReconnect();
            }, this.authTimeoutMs);
        };

        socket.onmessage = (event) => {
            if (this.socket !== socket) return;
            this.handleMessage(event.data);
        };

        socket.onerror = () => {
            this.handlers.onError?.(new Error("WebSocket transport error"));
        };

        socket.onclose = (event) => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.clearAuthTimer();
            this.stopHeartbeat();
            if (this.manuallyClosed) {
                this.setState("closed");
                return;
            }
            this.handlers.onError?.(new Error(`WebSocket closed (${event.code ?? 1006})`));
            this.scheduleReconnect();
        };
    }

    private dropSocket(socket: WebSocketLike): void {
        if (this.socket === socket) this.socket = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        try {
            socket.close(4000, "client reset");
        } catch {
            /* already closed */
        }
    }

    private scheduleReconnect(): void {
        this.clearReconnectTimer();
        this.setState("reconnecting");
        const delay = Math.min(this.initialBackoffMs * this.backoffMultiplier ** this.attempt, this.maxBackoffMs);
        this.attempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.openSocket();
        }, delay);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private clearAuthTimer(): void {
        if (this.authTimer) {
            clearTimeout(this.authTimer);
            this.authTimer = null;
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        if (this.heartbeatMs <= 0) return;
        this.heartbeatTimer = setInterval(() => {
            if (this.state === "open") this.send({ v: 1, type: "ping" });
        }, this.heartbeatMs);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private send(frame: WsFrame): boolean {
        if (!this.socket) return false;
        try {
            this.socket.send(JSON.stringify(frame));
            return true;
        } catch (error) {
            this.handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
            return false;
        }
    }

    private sendSubscribe(sessionIds: string[]): void {
        if (!sessionIds.length) return;
        // The daemon accepts one `since` cursor per frame (protocol §3.3), so a
        // resumable session gets its own subscribe frame; the rest are batched.
        const fresh: string[] = [];
        for (const id of sessionIds) {
            const seq = this.lastSeq.get(id);
            const epoch = this.epochs.get(id);
            if (seq === undefined || epoch === undefined) {
                fresh.push(id);
                continue;
            }
            this.send({
                v: 1,
                type: "subscribe",
                payload: { sessionIds: [id], since: { sessionId: id, epoch, seq } },
            });
        }
        if (fresh.length) {
            this.send({ v: 1, type: "subscribe", payload: { sessionIds: fresh } });
        }
    }

    private flushSubscriptions(): void {
        if (this.subscriptions.size) this.sendSubscribe([...this.subscriptions]);
    }

    private handleMessage(raw: unknown): void {
        let frame: WsFrame;
        try {
            const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
            if (!isRecord(parsed) || typeof parsed.type !== "string") return;
            frame = parsed as WsFrame;
        } catch {
            return;
        }

        switch (frame.type) {
            case "hello_ack": {
                this.clearAuthTimer();
                this.attempt = 0;
                this.setState("open");
                this.startHeartbeat();
                this.handlers.onHelloAck?.();
                this.flushSubscriptions();
                break;
            }
            case "snapshot": {
                const sessionId = String(frame.sessionId ?? "");
                if (!sessionId) return;
                const seq = Number(frame.seq ?? 0);
                if (frame.epoch) this.epochs.set(sessionId, String(frame.epoch));
                this.lastSeq.set(sessionId, seq);
                this.handlers.onSnapshot?.({
                    sessionId,
                    epoch: frame.epoch ? String(frame.epoch) : undefined,
                    seq,
                    payload: frame.payload,
                });
                break;
            }
            case "event": {
                const sessionId = String(frame.sessionId ?? "");
                if (!sessionId) return;
                const seq = Number(frame.seq ?? 0);
                const previous = this.lastSeq.get(sessionId);
                if (previous !== undefined && Number.isFinite(seq) && seq <= previous) return;
                if (Number.isFinite(seq)) this.lastSeq.set(sessionId, seq);
                if (frame.epoch) this.epochs.set(sessionId, String(frame.epoch));
                this.handlers.onEvent?.({
                    sessionId,
                    epoch: frame.epoch ? String(frame.epoch) : undefined,
                    seq,
                    payload: frame.payload,
                    ts: typeof frame.ts === "number" ? frame.ts : undefined,
                });
                break;
            }
            case "resync_required": {
                const sessionId = String(frame.sessionId ?? "");
                if (sessionId) {
                    this.lastSeq.delete(sessionId);
                    this.epochs.delete(sessionId);
                }
                this.handlers.onResyncRequired?.(frame);
                break;
            }
            case "error": {
                const payload = isRecord(frame.payload) ? frame.payload : {};
                const code = String(payload.code ?? "E_UNKNOWN");
                const message = String(payload.message ?? code);
                this.handlers.onError?.(Object.assign(new Error(message), { code, frame }), frame);
                if (code === "E_UNAUTHORIZED" || code === "E_PROTOCOL_VERSION") {
                    this.manuallyClosed = true;
                    this.clearReconnectTimer();
                    this.close();
                }
                break;
            }
            case "pong":
            case "presence":
            case "dropped":
                break;
            default:
                break;
        }
    }
}

/** Build the default WS URL for the current origin (vite.config proxies /ws to the daemon). */
export function defaultWsUrl(path = "/ws"): string {
    if (typeof window === "undefined") return path;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}${path}`;
}
