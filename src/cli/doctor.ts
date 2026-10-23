/**
 * `pi2 doctor` — environment checks with injectable probes.
 *
 * Every input the checks need lives in a `DoctorContext`; `defaultProbes(ctx)`
 * turns that context into the check list and `runDoctor()` executes it. Tests
 * build a context directly instead of poking at the real machine.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, loadConfig, type AccessMode } from "../config.js";
import { daemonSocketPath, runtimeDir } from "../core/paths.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import { formatTable } from "./util.js";

const execFileAsync = promisify(execFile);

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
    name: string;
    status: CheckStatus;
    detail: string;
}

export interface DoctorProbe {
    name: string;
    run(): DoctorCheck | Promise<DoctorCheck>;
}

export interface DoctorReport {
    ok: boolean;
    checks: DoctorCheck[];
}

export interface BinaryProbe {
    found: boolean;
    path?: string;
    version?: string;
    error?: string;
}

export interface AccessModeContext {
    mode: AccessMode;
    host: string;
    port: number;
    publicUrl: string | null;
}

export interface DoctorContext {
    platform: NodeJS.Platform;
    nodeVersion: string;
    nvim: BinaryProbe;
    pi: BinaryProbe;
    plugin: { dir: string | undefined; bridgeFound: boolean };
    runtime: { path: string; exists: boolean; mode: number | undefined };
    cliToken: { path: string; exists: boolean; mode: number | undefined };
    socket: { path: string; exists: boolean };
    daemon: { reachable: boolean; port?: number; protocolVersion?: number; error?: string };
    port: { configured: number; bound: boolean };
    access: AccessModeContext;
    serviceManager: { name: "systemd" | "launchd"; available: boolean; detail?: string };
    linger: { checked: boolean; enabled?: boolean; detail?: string };
    webDist: { path: string; exists: boolean };
}

/** `v22.1.0` / `22.1.0` → `[22,1,0]`. */
export function parseVersion(raw: string | undefined): [number, number, number] | undefined {
    if (raw === undefined) return undefined;
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function versionAtLeast(version: readonly [number, number, number], minimum: readonly [number, number, number]): boolean {
    for (let index = 0; index < 3; index += 1) {
        const left = version[index] ?? 0;
        const right = minimum[index] ?? 0;
        if (left !== right) return left > right;
    }
    return true;
}

/** `NVIM v0.10.2` (first line of `nvim --version`) → `0.10.2`. */
export function parseNvimVersion(output: string): string | undefined {
    const match = /NVIM v(\d+\.\d+\.\d+)/.exec(output);
    return match?.[1];
}

export const MIN_NODE: readonly [number, number, number] = [22, 0, 0];
export const MIN_NVIM: readonly [number, number, number] = [0, 9, 0];

/** `<repo>/web/dist`, matching `loadConfig()`'s default. */
export function defaultWebDist(): string {
    return fileURLToPath(new URL("../../web/dist", import.meta.url));
}

export function checkNode(version: string): DoctorCheck {
    const parsed = parseVersion(version);
    if (parsed === undefined) return { name: "node", status: "fail", detail: `unparsable version "${version}"` };
    const ok = versionAtLeast(parsed, MIN_NODE);
    return {
        name: "node",
        status: ok ? "ok" : "fail",
        detail: `${version}${ok ? "" : ` (< ${MIN_NODE.join(".")})`}`,
    };
}

export function checkNvim(probe: BinaryProbe): DoctorCheck {
    if (!probe.found) {
        return { name: "nvim", status: "fail", detail: probe.error ?? "nvim not found on PATH" };
    }
    const version = parseVersion(probe.version);
    if (version === undefined) {
        return { name: "nvim", status: "warn", detail: `could not parse version of ${probe.path ?? "nvim"}` };
    }
    const ok = versionAtLeast(version, MIN_NVIM);
    return {
        name: "nvim",
        status: ok ? "ok" : "fail",
        detail: `${probe.version?.trim() ?? version.join(".")} (${probe.path ?? "nvim"})${ok ? "" : ` < ${MIN_NVIM.join(".")} for --remote-ui`}`,
    };
}

export function checkPi(probe: BinaryProbe): DoctorCheck {
    if (!probe.found) return { name: "pi", status: "warn", detail: probe.error ?? "pi not found on PATH (plugin-only sessions still work)" };
    return { name: "pi", status: "ok", detail: `${probe.version?.trim() ?? "unknown version"} (${probe.path ?? "pi"})` };
}

export function checkPlugin(probe: DoctorContext["plugin"]): DoctorCheck {
    if (probe.bridgeFound) {
        return { name: "plugin", status: "ok", detail: `${probe.dir ?? "pi2.nvim"} (lua/pi/web/bridge.lua)` };
    }
    return {
        name: "plugin",
        status: "fail",
        detail: `pi2.nvim not found (set PI2_PLUGIN_DIR or install it); looked in ${probe.dir ?? "~/.local/share/nvim/lazy/pi2.nvim"}`,
    };
}

function permsDetail(mode: number | undefined): string {
    return mode === undefined ? "mode unknown" : `mode ${mode.toString(8).padStart(4, "0")}`;
}

export function checkRuntimeDir(probe: DoctorContext["runtime"]): DoctorCheck {
    if (!probe.exists) return { name: "runtime-dir", status: "fail", detail: `${probe.path} missing` };
    const ok = probe.mode !== undefined && (probe.mode & 0o077) === 0;
    return {
        name: "runtime-dir",
        status: ok ? "ok" : "warn",
        detail: `${probe.path} (${permsDetail(probe.mode)}${ok ? "" : ", expected 0700"})`,
    };
}

export function checkCliToken(probe: DoctorContext["cliToken"]): DoctorCheck {
    if (!probe.exists) {
        return { name: "cli-token", status: "warn", detail: `${probe.path} missing (start the daemon with \`pi2 daemon\`)` };
    }
    const ok = probe.mode !== undefined && (probe.mode & 0o077) === 0;
    return {
        name: "cli-token",
        status: ok ? "ok" : "fail",
        detail: `${probe.path} (${permsDetail(probe.mode)}${ok ? "" : ", expected 0600"})`,
    };
}

export function checkSocket(probe: DoctorContext["socket"], daemonReachable: boolean): DoctorCheck {
    if (!probe.exists) {
        return {
            name: "socket",
            status: daemonReachable ? "warn" : "fail",
            detail: `${probe.path} missing`,
        };
    }
    return { name: "socket", status: "ok", detail: `${probe.path} present` };
}

export function checkDaemon(probe: DoctorContext["daemon"]): DoctorCheck {
    if (!probe.reachable) {
        return { name: "daemon", status: "fail", detail: probe.error ?? "not reachable (is the daemon running?)" };
    }
    return { name: "daemon", status: "ok", detail: `http://127.0.0.1:${probe.port ?? "?"} reachable` };
}

export function checkPort(probe: DoctorContext["port"]): DoctorCheck {
    if (probe.bound) return { name: "port", status: "ok", detail: `${probe.configured} bound by the daemon` };
    return { name: "port", status: "ok", detail: `${probe.configured} free` };
}

function isLoopbackHost(host: string): boolean {
    return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * `access`: local is fine; lan/tailscale warn because the daemon has no TLS of
 * its own, and fail when a non-loopback bind is exposed without a public URL.
 */
export function checkAccess(probe: AccessModeContext): DoctorCheck {
    if (probe.mode === "local") return { name: "access", status: "ok", detail: "local (loopback only)" };

    const publicSuffix = probe.publicUrl === null ? "" : `, public ${probe.publicUrl}`;
    const detail = `${probe.mode} (bind ${probe.host}/${probe.port}${publicSuffix})`;
    if (probe.publicUrl === null && !isLoopbackHost(probe.host)) {
        return { name: "access", status: "fail", detail };
    }
    const tls = probe.publicUrl !== null && probe.publicUrl.startsWith("https:");
    return {
        name: "access",
        status: "warn",
        detail: tls ? detail : `${detail} — no TLS, prefer \`tailscale serve\``,
    };
}

export function checkServiceManager(probe: DoctorContext["serviceManager"]): DoctorCheck {
    return {
        name: "service-manager",
        status: probe.available ? "ok" : "warn",
        detail: probe.detail ?? (probe.available ? `${probe.name} available` : `${probe.name} not reachable`),
    };
}

export function checkLinger(probe: DoctorContext["linger"]): DoctorCheck {
    if (!probe.checked) return { name: "linger", status: "ok", detail: "not applicable" };
    const detail = probe.detail ?? (probe.enabled === true ? "Linger=yes" : "Linger=no (enable with loginctl enable-linger)");
    return { name: "linger", status: probe.enabled === true ? "ok" : "warn", detail };
}

export function checkWebDist(probe: DoctorContext["webDist"]): DoctorCheck {
    if (probe.exists) return { name: "web-dist", status: "ok", detail: probe.path };
    return { name: "web-dist", status: "warn", detail: `${probe.path} missing (build the web UI for the browser console)` };
}

export function checkProtocol(probe: DoctorContext["daemon"]): DoctorCheck {
    if (!probe.reachable) return { name: "protocol", status: "fail", detail: "no daemon to compare against" };
    if (probe.protocolVersion === PROTOCOL_VERSION) {
        return { name: "protocol", status: "ok", detail: `v${PROTOCOL_VERSION}` };
    }
    return {
        name: "protocol",
        status: "fail",
        detail: `daemon speaks v${String(probe.protocolVersion)}, CLI expects v${PROTOCOL_VERSION}`,
    };
}

/** The canonical check list, in display order. */
export function defaultProbes(ctx: DoctorContext): DoctorProbe[] {
    const isLinux = ctx.platform === "linux";
    return [
        { name: "node", run: () => checkNode(ctx.nodeVersion) },
        { name: "nvim", run: () => checkNvim(ctx.nvim) },
        { name: "pi", run: () => checkPi(ctx.pi) },
        { name: "plugin", run: () => checkPlugin(ctx.plugin) },
        { name: "runtime-dir", run: () => checkRuntimeDir(ctx.runtime) },
        { name: "cli-token", run: () => checkCliToken(ctx.cliToken) },
        { name: "socket", run: () => checkSocket(ctx.socket, ctx.daemon.reachable) },
        { name: "daemon", run: () => checkDaemon(ctx.daemon) },
        { name: "port", run: () => checkPort(ctx.port) },
        { name: "access", run: () => checkAccess(ctx.access) },
        { name: "service-manager", run: () => checkServiceManager(ctx.serviceManager) },
        ...(isLinux ? [{ name: "linger", run: () => checkLinger(ctx.linger) }] : []),
        { name: "web-dist", run: () => checkWebDist(ctx.webDist) },
        { name: "protocol", run: () => checkProtocol(ctx.daemon) },
    ];
}

export async function runDoctor(probes: readonly DoctorProbe[]): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    for (const probe of probes) {
        try {
            checks.push(await probe.run());
        } catch (error) {
            checks.push({
                name: probe.name,
                status: "fail",
                detail: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { ok: checks.every((check) => check.status !== "fail"), checks };
}

const MARKS: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

export function formatReport(report: DoctorReport): string {
    const rows = report.checks.map((check) => [MARKS[check.status], check.name, check.detail]);
    return [formatTable(["", "check", "detail"], rows), "", `overall: ${report.ok ? "ok" : "FAILED"}`].join("\n");
}

export function reportToJson(report: DoctorReport): string {
    return `${JSON.stringify({ ok: report.ok, checks: report.checks }, null, 2)}`;
}

// ---------------------------------------------------------------------------
// Real-environment context
// ---------------------------------------------------------------------------

export interface RunLike {
    (command: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

export interface DoctorOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    runtime?: string;
    home?: string;
    uid?: number;
    /** Reachable daemon info (`/api/v1/info`), or the reason it is not reachable. */
    daemonInfo?: () => Promise<{ port: number; protocolVersion: number } | { error: string }>;
    run?: RunLike;
    which?: (command: string) => string | undefined;
    now?: () => number;
}

async function defaultRun(command: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execFileAsync(command, [...args], { timeout: 5_000, encoding: "utf8" });
        return { ok: true, stdout, stderr };
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
        return { ok: false, stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message ?? "" };
    }
}

function whichSync(command: string, env: NodeJS.ProcessEnv): string | undefined {
    const path = env.PATH ?? "";
    for (const dir of path.split(":")) {
        if (dir === "") continue;
        const candidate = join(dir, command);
        if (existsSync(candidate)) return candidate;
    }
    return undefined;
}

function statOrUndefined(path: string): { exists: boolean; mode: number | undefined } {
    try {
        return { exists: true, mode: statSync(path).mode & 0o777 };
    } catch {
        return { exists: false, mode: undefined };
    }
}

/** Best-effort access context; an unparsable environment reports `local`. */
function accessContext(env: NodeJS.ProcessEnv, port: number): AccessModeContext {
    try {
        const config = loadConfig(env);
        return { mode: config.access, host: config.host, port, publicUrl: config.publicUrl };
    } catch {
        return {
            mode: "local",
            host: env.PI2_HOST?.trim() || "127.0.0.1",
            port,
            publicUrl: env.PI2_PUBLIC_URL?.trim().replace(/\/+$/, "") || null,
        };
    }
}

async function binaryProbe(command: string, args: readonly string[], options: DoctorOptions, env: NodeJS.ProcessEnv): Promise<BinaryProbe> {
    const path = (options.which ?? ((name: string) => whichSync(name, env)))(command);
    if (path === undefined) return { found: false, error: `${command} not found on PATH` };
    const run = options.run ?? defaultRun;
    const result = await run(command, args);
    if (!result.ok) {
        return { found: true, path, ...(result.stderr.trim() === "" ? {} : { error: result.stderr.trim() }) };
    }
    const version = result.stdout.trim().split("\n")[0] ?? "";
    return { found: true, path, version };
}

export async function collectContext(options: DoctorOptions = {}): Promise<DoctorContext> {
    const env = options.env ?? process.env;
    const platform = options.platform ?? osPlatform();
    const runtime = options.runtime ?? runtimeDir();
    const home = options.home ?? homedir();
    const run = options.run ?? defaultRun;
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);

    const nvim = await binaryProbe("nvim", ["--version"], options, env);
    if (nvim.found && nvim.version !== undefined) {
        const parsed = parseNvimVersion(nvim.version);
        if (parsed !== undefined) nvim.version = `v${parsed}`;
    }
    const pi = await binaryProbe("pi", ["--version"], options, env);

    const pluginDir = env.PI2_PLUGIN_DIR?.trim() || join(home, ".local", "share", "nvim", "lazy", "pi2.nvim");
    const bridgeFound = existsSync(join(pluginDir, "lua", "pi", "web", "bridge.lua"));

    const runtimeStat = statOrUndefined(runtime);
    const cliTokenPath = join(runtime, "cli.token");
    const tokenStat = statOrUndefined(cliTokenPath);
    const socketPath = daemonSocketPath();
    const configuredPort = Number(env.PI2_PORT ?? DEFAULT_PORT) || DEFAULT_PORT;

    let daemon: DoctorContext["daemon"];
    if (options.daemonInfo !== undefined) {
        try {
            const info = await options.daemonInfo();
            daemon =
                "error" in info
                    ? { reachable: false, error: info.error }
                    : { reachable: true, port: info.port, protocolVersion: info.protocolVersion };
        } catch (error) {
            daemon = { reachable: false, error: error instanceof Error ? error.message : String(error) };
        }
    } else {
        daemon = { reachable: false, error: "no daemon reachable (is the daemon running?)" };
    }

    const serviceManager: DoctorContext["serviceManager"] =
        platform === "darwin"
            ? {
                  name: "launchd",
                  available: (options.which ?? ((name: string) => whichSync(name, env)))("launchctl") !== undefined,
              }
            : { name: "systemd", available: (options.which ?? ((name: string) => whichSync(name, env)))("systemctl") !== undefined };

    let linger: DoctorContext["linger"] = { checked: false };
    if (platform === "linux") {
        const result = await run("loginctl", ["show-user", String(uid), "-p", "Linger"]);
        if (result.ok) {
            const value = /Linger=(\w+)/.exec(result.stdout)?.[1];
            linger = {
                checked: true,
                enabled: value === "yes",
                detail: `Linger=${value ?? "unknown"}`,
            };
        } else {
            linger = { checked: true, enabled: undefined, detail: "loginctl unavailable" };
        }
    }

    return {
        platform,
        nodeVersion: process.version,
        nvim,
        pi,
        plugin: { dir: pluginDir, bridgeFound },
        runtime: { path: runtime, exists: runtimeStat.exists, mode: runtimeStat.mode },
        cliToken: { path: cliTokenPath, exists: tokenStat.exists, mode: tokenStat.mode },
        socket: { path: socketPath, exists: existsSync(socketPath) },
        daemon,
        port: { configured: daemon.port ?? configuredPort, bound: daemon.reachable },
        access: accessContext(env, daemon.port ?? configuredPort),
        serviceManager,
        linger,
        webDist: { path: env.PI2_STATIC_DIR?.trim() || defaultWebDist(), exists: existsSync(env.PI2_STATIC_DIR?.trim() || defaultWebDist()) },
    };
}

/** Full run against the real machine (with optional injectable overrides). */
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorReport> {
    const ctx = await collectContext(options);
    return runDoctor(defaultProbes(ctx));
}
