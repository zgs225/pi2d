/**
 * Daemon configuration.
 *
 * Defaults follow `docs/protocol.md`; deployment-specific values come from the
 * environment so `pi2 daemon` can be started without a config file.
 *
 * The daemon binds `0.0.0.0` by default: the console is meant to be opened from
 * a phone as well as from the desktop, and access is gated by the pairing code
 * and the device token — never by the bind address. `PI2_HOST` narrows the bind
 * (e.g. `127.0.0.1` for a loopback-only daemon), `PI2_PUBLIC_URL` adds the
 * external base used behind `tailscale serve`, and `PI2_ORIGINS` is *additive*.
 *
 * The CORS allowlist is derived by `core/network` from the addresses the daemon
 * is actually reachable on, so it always matches the pairing link.
 */
import type { NetworkInterfaceInfo } from "node:os";
import { defaultStaticDir } from "./core/install.js";
import { isLoopbackHost, isWildcardHost, localOrigins } from "./core/network.js";
import { daemonTokenPath, dataDir } from "./core/paths.js";

export const DEFAULT_PORT = 7676;
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CONNECTIONS = 64;

/** Wildcard bind: reachable from the desktop, the LAN and a tailnet. */
export const DEFAULT_HOST = "0.0.0.0";

export interface Limits {
    maxBodyBytes: number;
    maxFrameBytes: number;
    maxConnections: number;
}

export interface Config {
    host: string;
    /** TCP port; `0` asks the OS for an ephemeral port (tests). */
    port: number;
    /** built web UI — PI2_STATIC_DIR wins, else the install layout (<prefix>/share/pi2d/web/dist for the compiled binary, web/dist for an npm/dev checkout). */
    staticDir: string;
    corsOrigins: string[];
    limits: Limits;
    tokenPath: string;
    deviceStorePath: string;
    /** External base URL (no trailing slash), e.g. `https://host.tail1234.ts.net`. */
    publicUrl: string | null;
}

export type ConfigEnv = Record<string, string | undefined>;

export interface ConfigOptions {
    /** Network interfaces used to derive the CORS origins; overridable in tests. */
    interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

export function parsePort(raw: string | undefined): number {
    if (raw === undefined || raw.trim() === "") return DEFAULT_PORT;
    if (!/^\d+$/.test(raw.trim())) throw new Error(`PI2_PORT must be an integer, got "${raw}"`);
    const port = Number(raw);
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
        throw new Error(`PI2_PORT must be between 0 and 65535, got "${raw}"`);
    }
    return port;
}

/** Trailing slashes and empty strings are not meaningful origins. */
function normalizeOrigin(raw: string): string | null {
    const value = raw.trim().replace(/\/+$/, "");
    return value === "" ? null : value;
}

export function normalizePublicUrl(raw: string | undefined): string | null {
    if (raw === undefined) return null;
    return normalizeOrigin(raw);
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

export function loadConfig(env: ConfigEnv = process.env, options: ConfigOptions = {}): Config {
    const port = parsePort(env.PI2_PORT);
    const publicUrl = normalizePublicUrl(env.PI2_PUBLIC_URL);
    const host = env.PI2_HOST?.trim() || DEFAULT_HOST;
    const derived = localOrigins({
        port,
        bindHost: host,
        publicUrl,
        ...(options.interfaces === undefined ? {} : { interfaces: options.interfaces }),
    });

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
        publicUrl,
    };
}

/** Human-readable bind summary, shared by `pi2 status` and `pi2 doctor`. */
export function describeHost(host: string): string {
    if (isWildcardHost(host)) return "all interfaces";
    if (isLoopbackHost(host)) return "loopback only";
    return host;
}
