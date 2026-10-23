/**
 * Daemon configuration.
 *
 * Defaults follow `docs/protocol.md`; deployment-specific values come from the
 * environment so `pi2 daemon` can be started without a config file.
 *
 * `PI2_ACCESS_MODE` picks the bind address and the derived CORS origins:
 * `local` is loopback-only, `lan` adds the detected LAN address and
 * `tailscale` adds the origin of `PI2_PUBLIC_URL`. `PI2_ORIGINS` is *additive*
 * to the derived list; it never replaces it.
 */
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { daemonTokenPath, dataDir } from "./core/paths.js";

export const DEFAULT_PORT = 7676;
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CONNECTIONS = 64;

export type AccessMode = "local" | "lan" | "tailscale";
export const ACCESS_MODES: readonly AccessMode[] = ["local", "lan", "tailscale"];

export interface Limits {
    maxBodyBytes: number;
    maxFrameBytes: number;
    maxConnections: number;
}

export interface Config {
    host: string;
    /** TCP port; `0` asks the OS for an ephemeral port (tests). */
    port: number;
    /** Built web UI (`<repo>/web/dist` by default). */
    staticDir: string;
    corsOrigins: string[];
    limits: Limits;
    tokenPath: string;
    deviceStorePath: string;
    access: AccessMode;
    /** External base URL (no trailing slash), e.g. `https://host.tail1234.ts.net`. */
    publicUrl: string | null;
}

export type ConfigEnv = Record<string, string | undefined>;

export interface ConfigOptions {
    /** LAN address probe for `PI2_ACCESS_MODE=lan`; overridable in tests. */
    detectLanIp?: () => string | null;
}

function defaultStaticDir(): string {
    return fileURLToPath(new URL("../web/dist", import.meta.url));
}

function parsePort(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
    if (!/^\d+$/.test(raw.trim())) throw new Error(`PI2_PORT must be an integer, got "${raw}"`);
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new Error(`PI2_PORT must be between 0 and 65535, got "${raw}"`);
    }
    return port;
}

/** Unknown modes fail fast; the daemon prints the message as a one-line `pi2: ` error. */
export function parseAccessMode(raw: string | undefined): AccessMode {
    const value = raw?.trim() ?? "";
    if (value === "") return "local";
    if ((ACCESS_MODES as readonly string[]).includes(value)) return value as AccessMode;
    throw new Error("PI2_ACCESS_MODE must be local, lan or tailscale");
}

/** Trailing slashes and empty strings are not meaningful origins. */
function normalizeOrigin(raw: string): string | null {
    const value = raw.trim().replace(/\/+$/, "");
    return value === "" ? null : value;
}

function normalizePublicUrl(raw: string | undefined): string | null {
    if (raw === undefined) return null;
    return normalizeOrigin(raw);
}

/** `https://host/path?q=1` → `https://host`; unparsable values fall back verbatim. */
function originOf(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return normalizeOrigin(url);
    }
}

function parseOrigins(raw: string | undefined): string[] {
    if (raw === undefined) return [];
    return raw
        .split(",")
        .map((origin) => normalizeOrigin(origin))
        .filter((origin): origin is string => origin !== null);
}

function dedupe(origins: readonly string[]): string[] {
    return [...new Set(origins)];
}

function defaultHostFor(access: AccessMode): string {
    return access === "lan" ? "0.0.0.0" : "127.0.0.1";
}

function loopbackOrigins(port: number): string[] {
    return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

/**
 * First non-internal IPv4 address, best effort: `lan` mode only *adds* an
 * origin, and an unknown address just leaves the loopback list in place.
 */
export function detectLanIp(): string | null {
    try {
        for (const addresses of Object.values(networkInterfaces())) {
            for (const address of addresses ?? []) {
                if (address.family !== "IPv4" || address.internal) continue;
                if (address.address.startsWith("169.254.")) continue;
                return address.address;
            }
        }
    } catch {
        // best effort only
    }
    return null;
}

function derivedOrigins(
    access: AccessMode,
    port: number,
    publicUrl: string | null,
    detect: () => string | null,
): string[] {
    const origins = loopbackOrigins(port);
    if (access === "lan") {
        let lanIp: string | null = null;
        try {
            lanIp = detect();
        } catch {
            lanIp = null;
        }
        if (lanIp !== null && lanIp.trim() !== "") origins.push(`http://${lanIp.trim()}:${port}`);
    } else if (access === "tailscale" && publicUrl !== null) {
        const origin = originOf(publicUrl);
        if (origin !== null) origins.push(origin);
    }
    return origins;
}

export function loadConfig(env: ConfigEnv = process.env, options: ConfigOptions = {}): Config {
    const port = parsePort(env.PI2_PORT);
    const access = parseAccessMode(env.PI2_ACCESS_MODE);
    const publicUrl = normalizePublicUrl(env.PI2_PUBLIC_URL);
    const host = env.PI2_HOST?.trim() || defaultHostFor(access);
    const derived = derivedOrigins(access, port, publicUrl, options.detectLanIp ?? detectLanIp);

    return {
        host,
        port,
        staticDir: env.PI2_STATIC_DIR?.trim() || defaultStaticDir(),
        corsOrigins: dedupe([...derived, ...parseOrigins(env.PI2_ORIGINS)]),
        limits: {
            maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
            maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
            maxConnections: DEFAULT_MAX_CONNECTIONS,
        },
        tokenPath: daemonTokenPath(),
        deviceStorePath: `${dataDir()}/devices.json`,
        access,
        publicUrl,
    };
}
