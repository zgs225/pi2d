import { ApiError, apiRequest, type InfoResponse } from "@/lib/api";

export const PAIR_META_KEY = "pi2-pair-meta";
export const PAIR_SCOPES = ["read", "steer", "apply"] as const;

export type DeviceKind = "phone" | "laptop" | "tablet";

export interface PairMeta {
    scopes: string[];
    deviceName?: string;
    kind?: DeviceKind;
    server?: Partial<InfoResponse> & { name?: string; hostname?: string; version?: string; pluginVersion?: string };
    pairedAt?: number;
}

export interface PairTarget {
    endpoint: string;
    code: string;
    name: string;
    hostname: string;
    port: number;
}

export interface RedeemResult {
    token: string;
    scopes: string[];
    deviceId?: string;
    server?: PairMeta["server"];
    raw: unknown;
}

export interface ParsedEndpoint {
    endpoint: string;
    hostname: string;
    port: number;
    protocol: "http" | "https";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function firstString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Accepts `host`, `host:port` and `http(s)://host[:port][/path]`.
 * A non-http scheme (e.g. a pi2:// pairing link pasted into the host field)
 * is rejected so the caller can show the failure rail.
 */
export function parseEndpoint(hostRaw: string, portRaw: string): ParsedEndpoint | { error: "host" | "port" | "scheme" } {
    const raw = String(hostRaw || "").trim().replace(/\/+$/, "");
    if (!raw) return { error: "host" };

    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
    let hostname: string;
    let portText: string;
    let protocol: "http" | "https" = "http";

    if (scheme) {
        const name = (scheme[1] ?? "").toLowerCase();
        if (name !== "http" && name !== "https") return { error: "scheme" };
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            return { error: "host" };
        }
        hostname = url.hostname;
        portText = url.port || String(portRaw || "").trim();
        protocol = name;
    } else {
        const match = /^([^/\s?#:]+)(?::(\d+))?$/.exec(raw);
        if (!match) return { error: "host" };
        hostname = match[1] ?? "";
        portText = match[2] || String(portRaw || "").trim();
    }

    if (!hostname) return { error: "host" };
    if (!/^\d+$/.test(portText)) return { error: "port" };
    const port = Number(portText);
    if (!(port >= 1 && port <= 65535)) return { error: "port" };
    return { endpoint: `${protocol}://${hostname}:${port}`, hostname, port, protocol };
}

function endpointFrom(value: string | null | undefined): ParsedEndpoint | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        const protocol = url.protocol === "https:" ? "https" : "http";
        const port = url.port ? Number(url.port) : protocol === "https" ? 443 : 80;
        if (!url.hostname) return null;
        return { endpoint: `${protocol}://${url.hostname}:${port}`, hostname: url.hostname, port, protocol };
    } catch {
        return null;
    }
}

/**
 * Parse the QR payload. Supported forms:
 *   `https://host:port/#pair=CODE`
 *   `#pair=CODE` (resolved against the current/typed endpoint)
 *   `pi2://pair?host=…&port=…&code=…` (design prototype compatibility)
 */
export function parsePairLink(raw: string, fallbackEndpoint?: string | null): PairTarget | null {
    const text = String(raw || "").trim();
    if (!text) return null;

    if (/^pi2:\/\/pair\b/i.test(text)) {
        let url: URL;
        try {
            url = new URL(text);
        } catch {
            return null;
        }
        if (url.protocol !== "pi2:") return null;
        const params = url.searchParams;
        const hostname = (params.get("host") || "").trim();
        if (!hostname) return null;
        const portNum = Number(params.get("port"));
        const port = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : 4321;
        const protocol = (params.get("proto") || "").toLowerCase() === "https" ? "https" : "http";
        const code = (params.get("code") || params.get("token") || "").trim();
        if (!code) return null;
        return {
            endpoint: `${protocol}://${hostname}:${port}`,
            code,
            name: params.get("name") || hostname,
            hostname,
            port,
        };
    }

    let url: URL;
    try {
        const base =
            endpointFrom(fallbackEndpoint)?.endpoint ||
            (typeof window !== "undefined" ? window.location.origin : "http://localhost");
        url = new URL(text, base);
    } catch {
        return null;
    }

    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const code = (hash.get("pair") || hash.get("code") || url.searchParams.get("pair") || "").trim();
    if (!code) return null;

    const base = endpointFrom(fallbackEndpoint) ?? endpointFrom(url.origin);
    if (!base) return null;
    const isAbsolute = /^https?:\/\//i.test(text);
    const endpoint = isAbsolute ? endpointFrom(url.origin) : base;
    if (!endpoint) return null;

    return {
        endpoint: endpoint.endpoint,
        code,
        name: hash.get("name") || url.searchParams.get("name") || endpoint.hostname,
        hostname: endpoint.hostname,
        port: endpoint.port,
    };
}

export function maskSecret(value: string): string {
    const text = String(value || "");
    if (!text) return "—";
    if (text.includes("…")) return text;
    if (text.length <= 8) return `…${text.slice(-3)}`;
    return `${text.slice(0, 7)}…${text.slice(-4)}`;
}

export function detectDeviceKind(): DeviceKind {
    if (typeof navigator === "undefined") return "laptop";
    const ua = navigator.userAgent || "";
    if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return "tablet";
    if (/Mobi|Android|iPhone/i.test(ua)) return "phone";
    return "laptop";
}

/** POST /api/v1/cmd pair.redeem against the selected origin. */
export async function redeemPairing(input: {
    endpoint: string;
    code: string;
    deviceName: string;
    kind?: DeviceKind;
    signal?: AbortSignal;
}): Promise<RedeemResult> {
    const endpoint = input.endpoint.replace(/\/+$/, "");
    const response = await apiRequest<Record<string, unknown>>("/api/v1/cmd", {
        method: "POST",
        baseUrl: endpoint,
        body: {
            method: "pair.redeem",
            params: {
                code: input.code,
                deviceName: input.deviceName,
                kind: input.kind ?? detectDeviceKind(),
            },
        },
        signal: input.signal,
    });

    const payload = asRecord(response.payload);
    const result = asRecord(response.result);
    const device = asRecord(response.device);
    const token = firstString(response.token, response.deviceToken, payload?.token, result?.token, device?.token);
    if (!token) {
        throw new ApiError({
            code: "E_UNAUTHORIZED",
            message: "pair.redeem returned no device token",
            status: 401,
        });
    }

    const server = asRecord(response.server) as PairMeta["server"] | undefined;
    return {
        token,
        scopes: stringList(response.scopes).length
            ? stringList(response.scopes)
            : stringList(result?.scopes).length
              ? stringList(result?.scopes)
              : ["read"],
        deviceId: firstString(response.deviceId, result?.deviceId, device?.deviceId),
        server,
        raw: response,
    };
}

export function readPairMeta(): PairMeta | null {
    try {
        const raw = localStorage.getItem(PAIR_META_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        const record = asRecord(parsed);
        if (!record) return null;
        return {
            scopes: stringList(record.scopes),
            deviceName: typeof record.deviceName === "string" ? record.deviceName : undefined,
            kind: record.kind === "phone" || record.kind === "laptop" || record.kind === "tablet" ? record.kind : undefined,
            server: asRecord(record.server) as PairMeta["server"] | undefined,
            pairedAt: typeof record.pairedAt === "number" ? record.pairedAt : undefined,
        };
    } catch {
        return null;
    }
}

export function writePairMeta(meta: PairMeta): void {
    try {
        localStorage.setItem(PAIR_META_KEY, JSON.stringify(meta));
    } catch {
        /* private mode */
    }
}

export function clearPairMeta(): void {
    try {
        localStorage.removeItem(PAIR_META_KEY);
    } catch {
        /* private mode */
    }
}

/** The connection redirect may target only the three navigation pages. */
export function safePairNext(raw: string | null | undefined): string {
    if (!raw) return "/workspaces";
    try {
        const url = new URL(String(raw), "http://pi2.local");
        if (url.pathname === "/workspaces" || url.pathname === "/chat" || url.pathname === "/status") {
            return `${url.pathname}${url.search}`;
        }
    } catch {
        /* fall through */
    }
    return "/workspaces";
}

export function scopesForIdentity(meta: PairMeta | null, info: InfoResponse | null | undefined): string[] {
    if (meta?.scopes.length) return meta.scopes;
    const capabilities = Array.isArray(info?.capabilities) ? info.capabilities : [];
    return capabilities.filter((capability) => (PAIR_SCOPES as readonly string[]).includes(capability));
}
