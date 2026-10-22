/**
 * Daemon configuration.
 *
 * Defaults follow `docs/protocol.md`; deployment-specific values come from the
 * environment so `pi2 daemon` can be started without a config file.
 */
import { fileURLToPath } from "node:url";
import { daemonTokenPath, dataDir } from "./core/paths.js";

export const DEFAULT_PORT = 7676;
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CONNECTIONS = 64;

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
}

export type ConfigEnv = Record<string, string | undefined>;

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

function parseOrigins(raw: string | undefined, port: number): string[] {
    if (raw !== undefined) {
        return raw
            .split(",")
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0);
    }
    return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

export function loadConfig(env: ConfigEnv = process.env): Config {
    const port = parsePort(env.PI2_PORT);
    const host = env.PI2_HOST?.trim() || "127.0.0.1";
    return {
        host,
        port,
        staticDir: env.PI2_STATIC_DIR?.trim() || defaultStaticDir(),
        corsOrigins: parseOrigins(env.PI2_ORIGINS, port),
        limits: {
            maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
            maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
            maxConnections: DEFAULT_MAX_CONNECTIONS,
        },
        tokenPath: daemonTokenPath(),
        deviceStorePath: `${dataDir()}/devices.json`,
    };
}
