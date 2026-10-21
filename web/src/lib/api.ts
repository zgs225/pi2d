import type {
    ContextUsage,
    Entry,
    ErrorBody,
    ModelRef,
    SessionState,
    TaskItem,
    TodoItem,
    UsageTotals,
    WorkspaceInfo,
} from "./protocol";

/** Storage key shared with the prototype and the pairing flow. */
export const TOKEN_STORAGE_KEY = "pi2-device-token";

export function getDeviceToken(): string | null {
    try {
        return localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
        return null;
    }
}

export function setDeviceToken(token: string | null): void {
    try {
        if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`);
        else localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
        /* private mode */
    }
}

/** Bearer header value; accepts a token with or without the `Bearer ` prefix. */
function authHeader(): Record<string, string> {
    const raw = getDeviceToken()?.replace(/^Bearer\s+/i, "").trim();
    return raw ? { Authorization: `Bearer ${raw}` } : {};
}

export class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
    readonly details?: Record<string, unknown>;

    constructor(input: { code: string; message: string; status: number; retryable?: boolean; details?: Record<string, unknown> }) {
        super(input.message);
        this.name = "ApiError";
        this.code = input.code;
        this.status = input.status;
        this.retryable = input.retryable ?? false;
        this.details = input.details;
    }
}

/**
 * Stable error code → i18n key. The daemon's `message` is English/debug only;
 * the browser translates the code (docs/protocol.md §3).
 */
export const ERROR_I18N_KEYS: Record<string, string> = {
    E_BAD_REQUEST: "errors.badRequest",
    E_UNAUTHORIZED: "errors.unauthorized",
    E_FORBIDDEN: "errors.forbidden",
    E_NOT_FOUND: "errors.notFound",
    E_METHOD_NOT_ALLOWED: "errors.methodNotAllowed",
    E_PROTOCOL_VERSION: "errors.protocolVersion",
    E_PAYLOAD_TOO_LARGE: "errors.payloadTooLarge",
    E_RATE_LIMITED: "errors.rateLimited",
    E_INSTANCE_STARTING: "errors.instanceStarting",
    E_INSTANCE_UNMANAGED: "errors.instanceUnmanaged",
    E_INSTANCE_UNAVAILABLE: "errors.instanceUnavailable",
    E_LEASE: "errors.lease",
    E_EXTERNAL_SESSION: "errors.externalSession",
    E_SESSION_NOT_FOUND: "errors.sessionNotFound",
    E_ATTENTION_RESOLVED: "errors.attentionResolved",
    E_UNSUPPORTED: "errors.unsupported",
    E_INTERNAL: "errors.internal",
    E_NETWORK: "errors.network",
    E_TIMEOUT: "errors.timeout",
    E_UNKNOWN: "errors.unknown",
};

export function errorI18nKey(code: string | undefined): string {
    return (code && ERROR_I18N_KEYS[code]) || "errors.unknown";
}

function statusCode(status: number): string {
    switch (status) {
        case 400:
            return "E_BAD_REQUEST";
        case 401:
            return "E_UNAUTHORIZED";
        case 403:
            return "E_FORBIDDEN";
        case 404:
            return "E_NOT_FOUND";
        case 405:
            return "E_METHOD_NOT_ALLOWED";
        case 409:
            return "E_LEASE";
        case 413:
            return "E_PAYLOAD_TOO_LARGE";
        case 429:
            return "E_RATE_LIMITED";
        case 426:
            return "E_PROTOCOL_VERSION";
        case 501:
            return "E_UNSUPPORTED";
        default:
            return status >= 500 ? "E_INTERNAL" : "E_UNKNOWN";
    }
}

interface RequestOptions {
    method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    /** Absolute URL for pairing (before a device token exists). */
    baseUrl?: string;
    timeoutMs?: number;
    /**
     * A 401 on this request must not clear the connection. Pairing requests use
     * `baseUrl` and may legitimately answer 401 for a wrong code while another
     * device token is already stored.
     */
    skipAuthReset?: boolean;
}

export type UnauthorizedHandler = (error: ApiError) => void;

const unauthorizedHandlers = new Set<UnauthorizedHandler>();

/**
 * Subscribe to authenticated-request 401s (`E_UNAUTHORIZED`) so the shell can
 * clear a stale device token and bounce the user back to `/connect`.
 */
export function onUnauthorized(handler: UnauthorizedHandler): () => void {
    unauthorizedHandlers.add(handler);
    return () => {
        unauthorizedHandlers.delete(handler);
    };
}

function notifyUnauthorized(error: ApiError): void {
    for (const handler of [...unauthorizedHandlers]) {
        try {
            handler(error);
        } catch {
            /* a listener must never break the request path */
        }
    }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", body, signal, headers = {}, baseUrl = "", timeoutMs = 20_000, skipAuthReset } = options;
    // Only same-origin API calls authenticate as the stored device token.
    const resetsAuthOn401 = skipAuthReset ? false : baseUrl === "";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
        const response = await fetch(`${baseUrl}${path}`, {
            method,
            credentials: "same-origin",
            headers: {
                Accept: "application/json",
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                ...authHeader(),
                ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });

        if (response.status === 204) return undefined as T;

        const contentType = response.headers.get("content-type") ?? "";
        const payload: unknown = contentType.includes("application/json") ? await response.json() : await response.text();

        if (!response.ok) {
            const errorBody = extractErrorBody(payload);
            const error = new ApiError({
                code: errorBody?.code ?? statusCode(response.status),
                message: errorBody?.message ?? (response.statusText || `HTTP ${response.status}`),
                status: response.status,
                retryable: errorBody?.retryable ?? response.status >= 500,
                details: errorBody?.details,
            });
            if (resetsAuthOn401 && (response.status === 401 || error.code === "E_UNAUTHORIZED")) {
                notifyUnauthorized(error);
            }
            throw error;
        }

        return payload as T;
    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
            throw new ApiError({ code: "E_TIMEOUT", message: "Request aborted", status: 0, retryable: true });
        }
        throw new ApiError({
            code: "E_NETWORK",
            message: error instanceof Error ? error.message : String(error),
            status: 0,
            retryable: true,
        });
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
    }
}

function extractErrorBody(payload: unknown): (ErrorBody & { error?: ErrorBody }) | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    const nested = record.error;
    if (nested && typeof nested === "object") {
        const err = nested as Record<string, unknown>;
        return {
            code: String(err.code ?? "E_UNKNOWN"),
            message: String(err.message ?? ""),
            retryable: Boolean(err.retryable),
            details: err.details as Record<string, unknown> | undefined,
        };
    }
    if (typeof record.code === "string") {
        return {
            code: record.code,
            message: String(record.message ?? ""),
            retryable: Boolean(record.retryable),
            details: record.details as Record<string, unknown> | undefined,
        };
    }
    return undefined;
}

/* ------------------------------------------------------------------ */
/* Wire responses                                                      */
/* ------------------------------------------------------------------ */

export interface InfoResponse {
    v?: number;
    daemonId?: string;
    machineId?: string;
    platform?: string;
    capabilities?: string[];
    limits?: Record<string, number>;
    /** Optional identity fields the status page shows when the daemon provides them. */
    name?: string;
    hostname?: string;
    version?: string;
    pluginVersion?: string;
    host?: string;
    port?: number;
    /** Additive identity fields (daemon ≥ 0.2): OS label and process uptime. */
    os?: string;
    uptimeMs?: number;
    status?: "online" | "degraded" | "offline";
}

export interface ServerLike {
    name: string;
    hostname: string;
    host: string;
    port: number;
    version: string;
    pluginVersion: string;
    status: "online" | "degraded" | "offline";
}

export interface HealthResponse {
    ok?: boolean;
    checkedAt?: number;
    items: { name: string; ok: boolean; detail?: string }[];
}

export interface DeviceInfo {
    deviceId: string;
    name: string;
    kind: "phone" | "laptop" | "tablet";
    scopes: string[];
    lastActiveAt: number | null;
}

export interface ModelInfo {
    provider: string;
    models: { id: string; contextWindow: number; reasoning: boolean }[];
}

export interface ResourcesResponse {
    instances: { workspaceId: string; instanceId: string; nvimPid: number | null; rssBytes: number | null; sessions: number; hasUI: boolean }[];
    totalRssBytes: number;
    physicalMemoryBytes: number;
    warn: boolean;
    reason?: string;
}

export interface DiagnosticsResponse {
    connections?: unknown[];
    instances?: unknown[];
    [key: string]: unknown;
}

export interface PairRequest {
    code?: string;
    token?: string;
    deviceName?: string;
}

export interface PairResponse {
    token?: string;
    deviceId?: string;
    scopes?: string[];
    server?: Partial<InfoResponse>;
    [key: string]: unknown;
}

export type { ContextUsage, Entry, ModelRef, SessionState, TaskItem, TodoItem, UsageTotals, WorkspaceInfo };

/* ------------------------------------------------------------------ */
/* Endpoints (docs/protocol.md §3.1/§3.2)                              */
/* ------------------------------------------------------------------ */

export const api = {
    info: (signal?: AbortSignal) => request<InfoResponse>("/api/v1/info", { signal }),
    health: (signal?: AbortSignal) => request<HealthResponse>("/api/v1/health", { signal }),
    workspaces: (signal?: AbortSignal) => request<WorkspaceInfo[]>("/api/v1/workspaces", { signal }),
    sessions: (workspaceId: string, signal?: AbortSignal) =>
        request<SessionState[]>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`, { signal }),
    entries: (sessionId: string, options: { before?: number; limit?: number; signal?: AbortSignal } = {}) => {
        const params = new URLSearchParams();
        if (options.before !== undefined) params.set("before", String(options.before));
        if (options.limit !== undefined) params.set("limit", String(options.limit));
        const query = params.size ? `?${params.toString()}` : "";
        return request<Entry[]>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/entries${query}`, { signal: options.signal });
    },
    attention: (workspaceId: string, signal?: AbortSignal) =>
        request<unknown[]>(`/api/v1/attention?workspaceId=${encodeURIComponent(workspaceId)}`, { signal }),
    devices: (signal?: AbortSignal) => request<DeviceInfo[]>("/api/v1/devices", { signal }),
    revokeDevice: (deviceId: string, signal?: AbortSignal) =>
        request<void>(`/api/v1/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", signal }),
    models: (workspaceId: string, signal?: AbortSignal) =>
        request<ModelInfo[]>(`/api/v1/models?workspaceId=${encodeURIComponent(workspaceId)}`, { signal }),
    resources: (signal?: AbortSignal) => request<ResourcesResponse>("/api/v1/resources", { signal }),
    diagnostics: (signal?: AbortSignal) => request<DiagnosticsResponse>("/api/v1/diagnostics", { signal }),
    command: (body: { method: string; params?: Record<string, unknown>; sessionId?: string; clientRequestId?: string }, signal?: AbortSignal) =>
        request<{ accepted: boolean; disposition?: string }>("/api/v1/cmd", { method: "POST", body, signal }),
    pairCreate: (baseUrl?: string, signal?: AbortSignal) =>
        request<PairResponse>("/api/v1/pair", { method: "POST", body: {}, baseUrl, signal }),
    /** Public redeem endpoint (no bearer required): `{code,kind,deviceName}` → `{token,device}`. */
    pairRedeem: (body: PairRequest, baseUrl?: string, signal?: AbortSignal) =>
        request<PairResponse>("/api/v1/pair", { method: "POST", body, baseUrl, signal, skipAuthReset: true }),
};

export { request as apiRequest };
