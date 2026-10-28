/**
 * `pi2 doctor` — environment checks with injectable probes.
 *
 * Every input the checks need lives in a `DoctorContext`; `defaultProbes(ctx)`
 * turns that context into the check list and `runDoctor()` executes it. Tests
 * build a context directly instead of poking at the real machine.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEFAULT_HOST, DEFAULT_PORT, describeHost, loadConfig } from "../config.js";
import { defaultStaticDir, executablePath, isBundledRuntime, runtimeDescription } from "../core/install.js";
import { isLoopbackHost } from "../core/network.js";
import { daemonSocketPath, expandTilde, runtimeDir } from "../core/paths.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import {
    defaultServicePaths,
    launchAgentDir,
    LAUNCHD_PLIST_NAME,
    systemdUserDir,
    SYSTEMD_UNIT_NAME,
} from "./service.js";
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

export interface BindContext {
    host: string;
    port: number;
    publicUrl: string | null;
}

export interface UnitProbe {
    path: string;
    exists: boolean;
    content?: string;
    pathExists?: (path: string) => boolean;
}

export interface DoctorContext {
    platform: NodeJS.Platform;
    nodeVersion: string;
    bundled?: boolean;
    nvim: BinaryProbe;
    pi: BinaryProbe;
    curl: BinaryProbe;
    plugin: { dir: string | undefined; bridgeFound: boolean; hostFound?: boolean };
    runtime: { path: string; exists: boolean; mode: number | undefined };
    cliToken: { path: string; exists: boolean; mode: number | undefined };
    socket: { path: string; exists: boolean };
    daemon: { reachable: boolean; port?: number; protocolVersion?: number; error?: string };
    port: { configured: number; bound: boolean };
    bind: BindContext;
    serviceManager: { name: "systemd" | "launchd"; available: boolean; detail?: string };
    linger: { checked: boolean; enabled?: boolean; detail?: string };
    unit?: UnitProbe;
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

/** `curl 8.7.1 (x86_64-pc-linux-gnu) …` (first line of `curl --version`) → `8.7.1`. */
export function parseCurlVersion(output: string | undefined): string | undefined {
    if (output === undefined) return undefined;
    const match = /^curl\s+v?(\d+\.\d+\.\d+)/.exec(output.trim());
    return match?.[1];
}

export const MIN_NODE: readonly [number, number, number] = [20, 0, 0];
export const MIN_NVIM: readonly [number, number, number] = [0, 9, 0];

/** Built web UI, matching `loadConfig()`'s default. */
export function defaultWebDist(): string {
    return defaultStaticDir();
}

export function checkNode(version: string, bundled = false): DoctorCheck {
    if (bundled) {
        return {
            name: "node",
            status: "ok",
            detail: `${runtimeDescription()} — bundled runtime, no separate node needed`,
        };
    }
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

/**
 * `curl`: `:PiWeb`'s login handshake shells out to curl (Neovim has no HTTP
 * client), so a missing binary only breaks local sign-in — warn, never fail.
 */
export function checkCurl(probe: BinaryProbe): DoctorCheck {
    if (!probe.found) {
        return {
            name: "curl",
            status: "warn",
            detail: "not found on PATH (:PiWeb cannot sign the browser in automatically; pair instead)",
        };
    }
    const version = parseCurlVersion(probe.version);
    if (version === undefined) {
        return { name: "curl", status: "warn", detail: `could not parse version of ${probe.path ?? "curl"}` };
    }
    return { name: "curl", status: "ok", detail: `${version} (${probe.path ?? "curl"})` };
}

export function checkPlugin(probe: DoctorContext["plugin"]): DoctorCheck {
    if (probe.bridgeFound) {
        // The daemon spawns headless hosts with `lua require("pi.host").start()`,
        // so a plugin without `lua/pi/host.lua` cannot serve the web console.
        if (probe.hostFound === true) {
            return { name: "plugin", status: "ok", detail: `${probe.dir ?? "pi2.nvim"} (pi2.nvim host-capable)` };
        }
        return {
            name: "plugin",
            status: "warn",
            detail: `pi2.nvim at ${probe.dir ?? "~/.local/share/nvim/lazy/pi2.nvim"} has no lua/pi/host.lua — update the plugin; the daemon cannot start a workspace from the web console`,
        };
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

/**
 * `bind`: where the daemon listens. Loopback is private; anything else is
 * reachable from the LAN, which is the point of the console — so a non-loopback
 * bind only *warns*. Access is gated by pairing codes and per-device tokens,
 * and an `https:` public URL (e.g. behind `tailscale serve`) covers TLS.
 */
export function checkBind(probe: BindContext): DoctorCheck {
    const suffix = probe.publicUrl === null ? "" : `, public ${probe.publicUrl}`;
    if (isLoopbackHost(probe.host)) {
        return { name: "bind", status: "ok", detail: `${probe.host}/${probe.port} (loopback only)${suffix}` };
    }
    const detail = `${describeHost(probe.host)}/${probe.port}${suffix}`;
    const tls = probe.publicUrl !== null && probe.publicUrl.startsWith("https:");
    if (tls) return { name: "bind", status: "ok", detail };
    return {
        name: "bind",
        status: "warn",
        detail: `${detail} — no TLS; pairing codes gate access, set PI2_HOST=127.0.0.1 to restrict`,
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

export function defaultUnitPath(platform: NodeJS.Platform, home: string, configHome?: string): string {
    const paths = defaultServicePaths({ homeDir: home, ...(configHome !== undefined ? { configHome } : {}) });
    return platform === "darwin"
        ? join(launchAgentDir(paths), LAUNCHD_PLIST_NAME)
        : join(systemdUserDir(paths), SYSTEMD_UNIT_NAME);
}

export function tokenizeCommandLine(cmd: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inQuote: '"' | "'" | null = null;
    let escape = false;

    for (let index = 0; index < cmd.length; index += 1) {
        const char = cmd[index]!;
        if (escape) {
            current += char;
            escape = false;
        } else if (char === "\\") {
            escape = true;
        } else if (inQuote !== null) {
            if (char === inQuote) {
                inQuote = null;
            } else {
                current += char;
            }
        } else if (char === '"' || char === "'") {
            inQuote = char;
        } else if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = "";
            }
        } else {
            current += char;
        }
    }
    if (current.length > 0) {
        tokens.push(current);
    }
    return tokens;
}

export function parsePlistProgramArguments(content: string): string[] {
    const arrayMatch = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content);
    if (!arrayMatch) return [];
    const strings: string[] = [];
    const stringRegex = /<string>([\s\S]*?)<\/string>/g;
    let match: RegExpExecArray | null;
    while ((match = stringRegex.exec(arrayMatch[1] ?? "")) !== null) {
        const val = match[1];
        if (val !== undefined) {
            const unescaped = val
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&amp;/g, "&");
            strings.push(unescaped.trim());
        }
    }
    return strings;
}

export function isNodeExecutable(path: string): boolean {
    return /(?:^|\/)node(?:\.exe)?$/.test(path);
}

export function checkUnit(
    probe: UnitProbe | undefined,
    bundled: boolean = isBundledRuntime(),
    platform: NodeJS.Platform = osPlatform(),
): DoctorCheck {
    if (probe === undefined || !probe.exists) {
        return {
            name: "unit",
            status: "ok",
            detail: "no service unit installed (run `pi2 install-service --write` to keep the daemon running)",
        };
    }

    let content = probe.content;
    if (content === undefined && probe.path) {
        try {
            content = readFileSync(probe.path, "utf8");
        } catch {
            content = undefined;
        }
    }

    if (content === undefined) {
        return {
            name: "unit",
            status: "warn",
            detail: `could not read unit file ${probe.path}; re-run \`pi2 install-service --write\``,
        };
    }

    const isDarwin = platform === "darwin" || probe.path.endsWith(".plist") || content.includes("<plist");
    let executable: string | undefined;
    const pathsToCheck: string[] = [];

    if (isDarwin) {
        const args = parsePlistProgramArguments(content);
        executable = args[0];
        if (executable !== undefined) {
            pathsToCheck.push(executable);
        }
    } else {
        const lines = content.split("\n");
        let lastExecStart: string | undefined;
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("ExecStart=")) {
                const val = trimmed.slice("ExecStart=".length).trim();
                if (val.length > 0) {
                    lastExecStart = val;
                }
            }
        }
        if (lastExecStart !== undefined) {
            const tokens = tokenizeCommandLine(lastExecStart);
            const first = tokens[0]?.replace(/^[-+!@]+(?=\/)/, "");
            if (first !== undefined && first.length > 0) {
                executable = first;
                for (const token of tokens) {
                    if (token === "daemon" || token.startsWith("-")) break;
                    pathsToCheck.push(token.replace(/^[-+!@]+(?=\/)/, ""));
                }
            }
        }
    }

    if (executable === undefined || pathsToCheck.length === 0) {
        return {
            name: "unit",
            status: "warn",
            detail: `could not parse executable from ${probe.path}; re-run \`pi2 install-service --write\``,
        };
    }

    const checkExists = probe.pathExists ?? existsSync;
    for (const targetPath of pathsToCheck) {
        if (!checkExists(targetPath)) {
            return {
                name: "unit",
                status: "warn",
                detail: `${targetPath} missing; re-run \`pi2 install-service --write\``,
            };
        }
    }

    const isNode = isNodeExecutable(executable);
    if ((bundled && isNode) || (!bundled && !isNode)) {
        return {
            name: "unit",
            status: "warn",
            detail: "unit was rendered for a different install shape; re-run pi2 install-service --write",
        };
    }

    return {
        name: "unit",
        status: "ok",
        detail: executable,
    };
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
        { name: "node", run: () => checkNode(ctx.nodeVersion, ctx.bundled ?? isBundledRuntime()) },
        { name: "nvim", run: () => checkNvim(ctx.nvim) },
        { name: "pi", run: () => checkPi(ctx.pi) },
        { name: "curl", run: () => checkCurl(ctx.curl) },
        { name: "plugin", run: () => checkPlugin(ctx.plugin) },
        { name: "runtime-dir", run: () => checkRuntimeDir(ctx.runtime) },
        { name: "cli-token", run: () => checkCliToken(ctx.cliToken) },
        { name: "socket", run: () => checkSocket(ctx.socket, ctx.daemon.reachable) },
        { name: "daemon", run: () => checkDaemon(ctx.daemon) },
        { name: "port", run: () => checkPort(ctx.port) },
        { name: "bind", run: () => checkBind(ctx.bind) },
        { name: "service-manager", run: () => checkServiceManager(ctx.serviceManager) },
        ...(isLinux ? [{ name: "linger", run: () => checkLinger(ctx.linger) }] : []),
        { name: "unit", run: () => checkUnit(ctx.unit, ctx.bundled ?? isBundledRuntime(), ctx.platform) },
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
    unit?: Partial<UnitProbe>;
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

/** Best-effort bind context; an unparsable environment reports the default bind. */
function bindContext(env: NodeJS.ProcessEnv, port: number): BindContext {
    try {
        const config = loadConfig(env);
        return { host: config.host, port, publicUrl: config.publicUrl };
    } catch {
        return {
            host: env.PI2_HOST?.trim() || DEFAULT_HOST,
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

/** `PI2_PLUGIN_DIR` → plugin root; `~`/`~/…` expand against the resolved home. */
function pluginHome(raw: string | undefined, home: string): string {
    const configured = raw?.trim();
    if (configured === undefined || configured === "") return join(home, ".local", "share", "nvim", "lazy", "pi2.nvim");
    return expandTilde(configured, home) ?? configured;
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
    const curl = await binaryProbe("curl", ["--version"], options, env);

    const pluginDir = pluginHome(env.PI2_PLUGIN_DIR, home);
    const bridgeFound = existsSync(join(pluginDir, "lua", "pi", "web", "bridge.lua"));
    const hostFound = existsSync(join(pluginDir, "lua", "pi", "host.lua"));

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

    const defaultPath = defaultUnitPath(platform, home, env.XDG_CONFIG_HOME?.trim() || undefined);
    const unitPath = options.unit?.path ?? defaultPath;
    const unitExists = options.unit?.exists ?? existsSync(unitPath);
    let unitContent = options.unit?.content;
    if (unitContent === undefined && unitExists) {
        try {
            unitContent = readFileSync(unitPath, "utf8");
        } catch {
            unitContent = undefined;
        }
    }
    const unit: UnitProbe = {
        path: unitPath,
        exists: unitExists,
        ...(unitContent !== undefined ? { content: unitContent } : {}),
        ...(options.unit?.pathExists !== undefined ? { pathExists: options.unit.pathExists } : {}),
    };

    return {
        platform,
        nodeVersion: process.version,
        bundled: isBundledRuntime(),
        nvim,
        pi,
        curl,
        plugin: { dir: pluginDir, bridgeFound, hostFound },
        runtime: { path: runtime, exists: runtimeStat.exists, mode: runtimeStat.mode },
        cliToken: { path: cliTokenPath, exists: tokenStat.exists, mode: tokenStat.mode },
        socket: { path: socketPath, exists: existsSync(socketPath) },
        daemon,
        port: { configured: daemon.port ?? configuredPort, bound: daemon.reachable },
        bind: bindContext(env, daemon.port ?? configuredPort),
        serviceManager,
        linger,
        unit,
        webDist: { path: env.PI2_STATIC_DIR?.trim() || defaultWebDist(), exists: existsSync(env.PI2_STATIC_DIR?.trim() || defaultWebDist()) },
    };
}

/** Full run against the real machine (with optional injectable overrides). */
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorReport> {
    const ctx = await collectContext(options);
    return runDoctor(defaultProbes(ctx));
}
