import { ApiError, apiRequest, type InfoResponse } from "@/lib/api";
import { NEXT_FALLBACK, safeNext } from "@/lib/routing";

export const PAIR_META_KEY = "pi2-pair-meta";

/** Public redeem endpoint: no bearer token required (docs/protocol.md §3.2). */
export const PAIR_REDEEM_PATH = "/api/v1/pair/redeem";
/** The daemon mints 8-character uppercase alphanumeric pairing codes. */
export const PAIR_CODE_LENGTH = 8;
export const PAIR_CODE_PATTERN = /^[A-Z0-9]{8}$/;

export type DeviceKind = "phone" | "laptop" | "tablet";

export interface PairMeta {
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
    deviceId?: string;
    deviceName?: string;
    kind?: DeviceKind;
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


/**
 * Uppercase and drop everything that is not `[A-Z0-9]` — pairing codes are
 * printed in small groups (`ABCD-1234`) but the daemon only accepts 8 chars.
 */
export function normalizePairCode(value: string | null | undefined): string {
    return String(value ?? "")
        .replace(/[^a-z0-9]/gi, "")
        .toUpperCase()
        .slice(0, PAIR_CODE_LENGTH + 8);
}

/** True when the (normalized) value is a well-formed pairing code. */
export function isPairCode(value: string | null | undefined): boolean {
    return PAIR_CODE_PATTERN.test(normalizePairCode(value));
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

function browserOrigin(): string | null {
    if (typeof window === "undefined") return null;
    return window.location?.origin ?? null;
}

function pairTarget(target: ParsedEndpoint, code: string, name?: string | null): PairTarget {
    return {
        endpoint: target.endpoint,
        code,
        name: name?.trim() || target.hostname,
        hostname: target.hostname,
        port: target.port,
    };
}

/** First non-empty pairing code among the query/hash/path candidates. */
function extractPairCode(url: URL): string {
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const pathCode = /^\/pair\/([^/?#]+)\/?$/i.exec(url.pathname)?.[1];
    const raw =
        hash.get("pair") ??
        hash.get("code") ??
        url.searchParams.get("pair") ??
        url.searchParams.get("code") ??
        pathCode;
    return normalizePairCode(raw ?? "");
}

/** `pi2://pair?host=…&port=…&code=…` (design prototype / QR deep link). */
function parsePi2PairLink(text: string, fallbackEndpoint?: string | null): PairTarget | null {
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (url.protocol !== "pi2:") return null;

    const params = url.searchParams;
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const pathCode = /^\/+([^/]+)$/.exec(url.pathname)?.[1];
    const code = normalizePairCode(
        params.get("code") ?? params.get("token") ?? hash.get("code") ?? hash.get("pair") ?? pathCode ?? "",
    );
    if (!code) return null;

    const hostParam = firstString(params.get("host"), params.get("hostname"), params.get("endpoint"));
    const proto = firstString(params.get("proto"), params.get("protocol"))?.toLowerCase();
    // A link without a port resolves against the port this console was served
    // from, falling back to the scheme default — never a literal.
    const portParam = firstString(params.get("port")) ?? defaultPairPort(proto === "https" ? "https" : "http");

    let target: ParsedEndpoint | null = null;
    if (hostParam) {
        const hostText =
            proto === "https" && !/^https?:\/\//i.test(hostParam) ? `https://${hostParam}` : hostParam;
        const parsed = parseEndpoint(hostText, portParam);
        target = "error" in parsed ? null : parsed;
    }
    // A pi2:// link without a host only makes sense against a known endpoint
    // (the caller passes the stored one); never guess from the browser origin.
    target ??= endpointFrom(fallbackEndpoint);
    if (!target) return null;

    return pairTarget(target, code, params.get("name") ?? hash.get("name"));
}

/**
 * Parse a pairing payload. Supported forms:
 *   `pi2://pair?host=…&port=…&code=…` (also `proto=https` and `host=host:port`)
 *   `https://host:port/pair/CODE`
 *   `https://host:port/#pair=CODE`
 *   `https://host:port/?pair=CODE` / `?code=CODE`
 *   `#pair=CODE` / `?code=CODE` / `/pair/CODE` (resolved against the current/typed endpoint)
 */
export function parsePairLink(raw: string, fallbackEndpoint?: string | null): PairTarget | null {
    const text = String(raw || "").trim();
    if (!text) return null;

    if (/^pi2:/i.test(text)) return parsePi2PairLink(text, fallbackEndpoint);

    let url: URL;
    try {
        const base = endpointFrom(fallbackEndpoint)?.endpoint ?? browserOrigin() ?? "http://localhost";
        url = new URL(text, base);
    } catch {
        return null;
    }

    const code = extractPairCode(url);
    if (!code) return null;

    const isAbsolute = /^https?:\/\//i.test(text);
    const endpoint = isAbsolute
        ? (endpointFrom(url.origin) ?? endpointFrom(fallbackEndpoint) ?? endpointFrom(browserOrigin()))
        : (endpointFrom(fallbackEndpoint) ?? endpointFrom(url.origin) ?? endpointFrom(browserOrigin()));
    if (!endpoint) return null;

    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    return pairTarget(endpoint, code, hash.get("name") ?? url.searchParams.get("name"));
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

/** Origin (scheme + host + port) of a stored endpoint; the redeem path is appended to it. */
export function pairingOrigin(endpoint: string): string {
    const parsed = endpointFrom(String(endpoint || "").trim());
    if (parsed) return parsed.endpoint;
    return String(endpoint || "")
        .trim()
        .replace(/\/+$/, "");
}

/** Port this console was served from, else the scheme default (`443`/`80`). */
function defaultPairPort(protocol: "http" | "https"): string {
    if (typeof window !== "undefined" && window.location.port) return window.location.port;
    return protocol === "https" ? "443" : "80";
}

/**
 * Redeem a pairing code against the public `POST <origin>/api/v1/pair/redeem`
 * endpoint: `{code,kind,deviceName}` → `{token,device}`.
 */
export async function redeemPairing(input: {
    endpoint: string;
    code: string;
    deviceName: string;
    kind?: DeviceKind;
    signal?: AbortSignal;
}): Promise<RedeemResult> {
    const origin = pairingOrigin(input.endpoint);
    const code = normalizePairCode(input.code);
    const deviceName = input.deviceName.trim();
    const kind = input.kind ?? detectDeviceKind();

    const response = await apiRequest<Record<string, unknown>>(PAIR_REDEEM_PATH, {
        method: "POST",
        baseUrl: origin,
        body: { code, kind, deviceName },
        skipAuthReset: true,
        signal: input.signal,
    });

    // 文档契约只有 `{token,device:{id,name,kind}}`，不再兜底历史别名。
    const body = asRecord(response) ?? {};
    const device = asRecord(body.device);
    const token = firstString(body.token);
    if (!token) {
        throw new ApiError({
            code: "E_UNAUTHORIZED",
            message: "pair redeem returned no device token",
            status: 401,
        });
    }

    return {
        token,
        deviceId: firstString(device?.id),
        deviceName: firstString(device?.name) ?? deviceName,
        kind: (firstString(device?.kind) as DeviceKind | undefined) ?? kind,
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

/**
 * Post-pairing redirect target. Shares `safeNext`'s allow-list so a paired deep
 * link such as `/chat/<sid>?workspace=…` survives the round trip.
 */
export function safePairNext(raw: string | null | undefined): string {
    return safeNext(raw, NEXT_FALLBACK);
}
