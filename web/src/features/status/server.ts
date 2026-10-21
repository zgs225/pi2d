import type { InfoResponse } from "@/lib/api";
import type { WsConnectionState } from "@/lib/ws";

/**
 * Optional identity fields the daemon may expose beyond the minimal /info
 * contract (`{v,daemonId,machineId,platform,hostname,os,version,uptimeMs,
 * capabilities,limits}`). The status page degrades to `—` when they are missing.
 */
export interface InfoExtras extends InfoResponse {
    pid?: number;
    kernel?: string;
    uptimeSec?: number;
    lastHeartbeat?: number;
    mdns?: string;
    cpu?: number;
    mem?: number;
    disk?: number;
    addresses?: { local?: string; network?: string };
    pairing?: { code?: string; expiresIn?: number };
    pairingCode?: string;
}

export interface ServerIdentity {
    name: string;
    hostname: string;
    daemonId: string;
    machineId: string;
    platform: string;
    port: number | null;
    endpoint: string;
    bindAddress: string;
    os: string;
    piVersion: string;
    pluginVersion: string;
    kernel: string;
    uptimeSec: number | null;
    uptimeMs: number | null;
    pid: number | null;
    status: "online" | "degraded" | "offline";
    wsConnected: boolean;
    wsProto: string;
    lastHeartbeatAt: number | null;
    localAddress: string;
    networkAddress: string;
    mdns: string;
    pairingCode: string;
    cpu: number | null;
    mem: number | null;
    disk: number | null;
}

function text(value: string | null | undefined, fallback = "—"): string {
    const trimmed = String(value ?? "").trim();
    return trimmed || fallback;
}

function finite(value: number | null | undefined): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseUrl(value: string | null | undefined): URL | null {
    if (!value) return null;
    try {
        return new URL(value);
    } catch {
        return null;
    }
}

function browserLocation(): { hostname: string; port: string; protocol: string; origin: string } {
    if (typeof window === "undefined") {
        return { hostname: "localhost", port: "", protocol: "http:", origin: "http://localhost" };
    }
    return {
        hostname: window.location.hostname || "localhost",
        port: window.location.port,
        protocol: window.location.protocol,
        origin: window.location.origin,
    };
}

export interface DeriveServerInput {
    info?: InfoExtras | null;
    endpoint?: string | null;
    wsState?: WsConnectionState;
    fetchedAt?: number | null;
    nameFallback?: string | null;
    status?: "online" | "degraded" | "offline" | null;
}

/** Resolve the single server's identity from /info + the locally stored endpoint. */
export function deriveServerIdentity({
    info,
    endpoint,
    wsState,
    fetchedAt,
    nameFallback,
    status,
}: DeriveServerInput): ServerIdentity {
    const extras: InfoExtras = info ?? {};
    const browser = browserLocation();
    const url = parseUrl(endpoint) ?? parseUrl(browser.origin);
    const protocol = url?.protocol ?? browser.protocol;
    const portText = extras.port != null ? String(extras.port) : url?.port || browser.port;
    const port = portText ? Number(portText) : protocol === "https:" ? 443 : 80;
    const hostname = extras.hostname?.trim() || url?.hostname || browser.hostname;
    const name = extras.name?.trim() || nameFallback?.trim() || hostname;
    const endpointOrigin = extras.host
        ? `${protocol}//${extras.host}:${port}`
        : url?.origin ?? browser.origin;
    const localAddress = extras.addresses?.local || `http://127.0.0.1:${port}`;
    const networkAddress = extras.addresses?.network || endpointOrigin;
    const resolvedStatus = status ?? extras.status ?? (info ? "online" : "offline");
    const uptimeMs = finite(extras.uptimeMs);
    const uptimeSec =
        uptimeMs != null ? Math.floor(uptimeMs / 1000) : typeof extras.uptimeSec === "number" ? extras.uptimeSec : null;

    return {
        name,
        hostname,
        daemonId: text(extras.daemonId),
        machineId: text(extras.machineId),
        platform: text(extras.platform),
        port,
        endpoint: endpointOrigin,
        bindAddress: text(extras.host, hostname),
        os: text(extras.os || extras.platform),
        piVersion: text(extras.version),
        pluginVersion: text(extras.pluginVersion),
        kernel: text(extras.kernel),
        uptimeSec,
        uptimeMs,
        pid: finite(extras.pid),
        status: resolvedStatus,
        wsConnected: wsState === "open",
        wsProto: info?.v ? `v${info.v}` : "v1",
        lastHeartbeatAt: extras.lastHeartbeat ?? fetchedAt ?? null,
        localAddress,
        networkAddress,
        mdns: text(extras.mdns, `${hostname}.local`),
        pairingCode: extras.pairingCode || extras.pairing?.code || "—",
        cpu: finite(extras.cpu),
        mem: finite(extras.mem),
        disk: finite(extras.disk),
    };
}

export function formatUptime(seconds: number | null | undefined): string {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    return `${hours}h ${minutes}m`;
}

export function formatBytes(bytes: number | null | undefined): string {
    if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatContextWindow(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens <= 0) return "—";
    if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
    return `${Math.round(tokens / 1000)}k`;
}

export function formatDuration(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.round(seconds % 60);
    return `${minutes}m ${rest}s`;
}
