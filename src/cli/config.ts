/**
 * `pi2 config` — print the resolved configuration and the source (environment
 * variable or default) that produced each value.
 *
 * Read-only: no running daemon required, no network, and safe to execute before
 * any runtime directories have been created on disk.
 */
import { homedir, platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT, normalizePublicUrl, parsePort } from "../config.js";
import { defaultStaticDir, isBundledRuntime, runtimeDescription, version } from "../core/install.js";
import { rootsFromEnv } from "../workspaces/index.js";
import { formatTable } from "./util.js";

export const CONFIG_USAGE = `pi2 config — print resolved configuration and sources

Usage:
  pi2 config [options]

Options:
  --json       emit machine-readable JSON object
  -h, --help   print this help and exit`;

export interface ResolvedConfig {
    port: number;
    host: string;
    publicUrl: string | null;
    staticDir: string;
    runtimeDir: string;
    dataDir: string;
    stateDir: string;
    codingAgentDir: string;
    workspaceRoots: string[];
    logLevel: string;
    version: string;
    platform: string;
    runtime: string;
    installShape: string;
}

export type ConfigKey = keyof ResolvedConfig;

export type ConfigSources = Record<ConfigKey, string>;

export interface ConfigResolution {
    config: ResolvedConfig;
    sources: ConfigSources;
}

export type ConfigJsonOutput = ResolvedConfig & {
    sources: ConfigSources;
};

export const CONFIG_KEYS: readonly ConfigKey[] = [
    "port",
    "host",
    "publicUrl",
    "staticDir",
    "runtimeDir",
    "dataDir",
    "stateDir",
    "codingAgentDir",
    "workspaceRoots",
    "logLevel",
    "version",
    "platform",
    "runtime",
    "installShape",
] as const;

export interface ResolveConfigOptions {
    env?: Record<string, string | undefined>;
    platform?: string;
    home?: string;
    uid?: number;
    version?: string;
    runtime?: string;
    installShape?: string;
    staticDir?: string;
}

function resolveRuntimeDir(
    env: Record<string, string | undefined>,
    platform: string,
    home: string,
    uid: number,
): { value: string; source: string } {
    if (env.PI2_RUNTIME_DIR !== undefined && env.PI2_RUNTIME_DIR.trim() !== "") {
        return { value: env.PI2_RUNTIME_DIR.trim(), source: "PI2_RUNTIME_DIR" };
    }
    if (platform === "darwin") {
        return { value: join(home, "Library", "Caches", "pi2", "run"), source: "default" };
    }
    return { value: join(env.XDG_RUNTIME_DIR ?? join(tmpdir(), `pi2-${uid}`), "pi2"), source: "default" };
}

function resolveDataDir(
    env: Record<string, string | undefined>,
    platform: string,
    home: string,
): { value: string; source: string } {
    if (env.PI2_DATA_DIR !== undefined && env.PI2_DATA_DIR.trim() !== "") {
        return { value: env.PI2_DATA_DIR.trim(), source: "PI2_DATA_DIR" };
    }
    if (platform === "darwin") {
        return { value: join(home, "Library", "Application Support", "pi2"), source: "default" };
    }
    return { value: join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "pi2"), source: "default" };
}

function resolveStateDir(
    env: Record<string, string | undefined>,
    platform: string,
    home: string,
): { value: string; source: string } {
    if (env.PI2_STATE_DIR !== undefined && env.PI2_STATE_DIR.trim() !== "") {
        return { value: env.PI2_STATE_DIR.trim(), source: "PI2_STATE_DIR" };
    }
    if (platform === "darwin") {
        return { value: join(home, "Library", "Logs", "pi2"), source: "default" };
    }
    return { value: join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "pi2"), source: "default" };
}

export function resolveConfig(options: ResolveConfigOptions = {}): ConfigResolution {
    const env = options.env ?? process.env;
    const platform = options.platform ?? osPlatform();
    const home = options.home ?? env.HOME ?? homedir();
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);

    const port =
        env.PI2_PORT !== undefined && env.PI2_PORT.trim() !== ""
            ? { value: parsePort(env.PI2_PORT), source: "PI2_PORT" }
            : { value: DEFAULT_PORT, source: "default" };

    const host =
        env.PI2_HOST !== undefined && env.PI2_HOST.trim() !== ""
            ? { value: env.PI2_HOST.trim(), source: "PI2_HOST" }
            : { value: DEFAULT_HOST, source: "default" };

    const publicUrl =
        env.PI2_PUBLIC_URL !== undefined && env.PI2_PUBLIC_URL.trim() !== ""
            ? { value: normalizePublicUrl(env.PI2_PUBLIC_URL), source: "PI2_PUBLIC_URL" }
            : { value: null, source: "default" };

    const staticDir =
        env.PI2_STATIC_DIR !== undefined && env.PI2_STATIC_DIR.trim() !== ""
            ? { value: env.PI2_STATIC_DIR.trim(), source: "PI2_STATIC_DIR" }
            : { value: options.staticDir ?? defaultStaticDir(), source: "install layout" };

    const runtimeDir = resolveRuntimeDir(env, platform, home, uid);
    const dataDir = resolveDataDir(env, platform, home);
    const stateDir = resolveStateDir(env, platform, home);

    const codingAgentDir =
        env.PI2_CODING_AGENT_DIR !== undefined && env.PI2_CODING_AGENT_DIR.trim() !== ""
            ? { value: env.PI2_CODING_AGENT_DIR.trim(), source: "PI2_CODING_AGENT_DIR" }
            : env.PI_CODING_AGENT_DIR !== undefined && env.PI_CODING_AGENT_DIR.trim() !== ""
              ? { value: env.PI_CODING_AGENT_DIR.trim(), source: "PI_CODING_AGENT_DIR" }
              : { value: join(home, ".pi", "agent"), source: "default" };

    const workspaceRoots =
        env.PI2_WORKSPACE_ROOTS !== undefined && env.PI2_WORKSPACE_ROOTS.trim() !== ""
            ? { value: rootsFromEnv(env.PI2_WORKSPACE_ROOTS, home), source: "PI2_WORKSPACE_ROOTS" }
            : { value: rootsFromEnv(undefined, home), source: "default" };

    const logLevel =
        env.PI2_LOG_LEVEL !== undefined && env.PI2_LOG_LEVEL.trim() !== ""
            ? { value: env.PI2_LOG_LEVEL.trim().toLowerCase(), source: "PI2_LOG_LEVEL" }
            : { value: "info", source: "default" };

    const versionVal = { value: options.version ?? version(), source: "install layout" };
    const platformVal = { value: platform, source: "system" };
    const runtimeVal = { value: options.runtime ?? runtimeDescription(), source: "runtime" };
    const installShapeVal = {
        value: options.installShape ?? (isBundledRuntime() ? "bundled" : "node"),
        source: "install layout",
    };

    return {
        config: {
            port: port.value,
            host: host.value,
            publicUrl: publicUrl.value,
            staticDir: staticDir.value,
            runtimeDir: runtimeDir.value,
            dataDir: dataDir.value,
            stateDir: stateDir.value,
            codingAgentDir: codingAgentDir.value,
            workspaceRoots: workspaceRoots.value,
            logLevel: logLevel.value,
            version: versionVal.value,
            platform: platformVal.value,
            runtime: runtimeVal.value,
            installShape: installShapeVal.value,
        },
        sources: {
            port: port.source,
            host: host.source,
            publicUrl: publicUrl.source,
            staticDir: staticDir.source,
            runtimeDir: runtimeDir.source,
            dataDir: dataDir.source,
            stateDir: stateDir.source,
            codingAgentDir: codingAgentDir.source,
            workspaceRoots: workspaceRoots.source,
            logLevel: logLevel.source,
            version: versionVal.source,
            platform: platformVal.source,
            runtime: runtimeVal.source,
            installShape: installShapeVal.source,
        },
    };
}

export function formatTableValue(key: ConfigKey, value: unknown): string {
    if (value === null || value === undefined) return "-";
    if (Array.isArray(value)) {
        return value.length === 0 ? "-" : value.join(", ");
    }
    return String(value);
}

export function formatConfigTable(resolution: ConfigResolution): string {
    const rows = CONFIG_KEYS.map((key) => [
        key,
        formatTableValue(key, resolution.config[key]),
        resolution.sources[key],
    ]);
    return formatTable(["key", "value", "source"], rows);
}

export function configToJson(resolution: ConfigResolution): string {
    const jsonOutput: ConfigJsonOutput = {
        ...resolution.config,
        sources: resolution.sources,
    };
    return JSON.stringify(jsonOutput, null, 2);
}

export interface RunConfigOptions extends ResolveConfigOptions {
    json?: boolean;
    print?: (line: string) => void;
}

export function runConfig(options: RunConfigOptions = {}): number {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const resolution = resolveConfig(options);
    if (options.json) {
        print(configToJson(resolution));
    } else {
        print(formatConfigTable(resolution));
    }
    return 0;
}
