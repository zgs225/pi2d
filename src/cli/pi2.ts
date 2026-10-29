#!/usr/bin/env node
/**
 * `pi2` — the user-facing CLI.
 *
 *   pi2 daemon [start]     run the web-console daemon (foreground)
 *   pi2 attach [path]      attach nvim to the workspace instance (or open nvim)
 *   pi2 status [--json]    daemon, instances, resources, health
 *   pi2 config [--json]    resolved configuration and sources
 *   pi2 doctor [--json]    environment checks
 *   pi2 pairing            create a pairing code for another device
 *   pi2 install-service    render/install a systemd user unit or LaunchAgent
 *   pi2 uninstall-service  remove it again
 *   pi2 service …          status/start/stop/enable/disable that unit
 *
 * Everything is discovered from the runtime dir: `daemon.json` carries the
 * bound port, `cli.token` the local admin token (see docs/deployment.md).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform as osPlatform } from "node:os";
import { runtimeDir } from "../core/paths.js";
import type { InstanceResourcesSnapshot } from "../core/interfaces.js";
import type { WorkspaceInfo } from "../protocol/types.js";
import { main as runDaemonMain } from "./daemon.js";
import { readDaemonJson, type DaemonLock } from "./lock.js";
import { cliTokenPath, readCliToken } from "./token.js";
import {
    boolFlag,
    CliError,
    errorMessage,
    formatBytes,
    formatTable,
    packageVersion,
    parseArgs,
    realpathOrSelf,
    stringFlag,
    UsageError,
} from "./util.js";
import {
    defaultServicePaths,
    renderService,
    serviceDir,
    type RenderedService,
    type ServicePaths,
    type ServicePlatform,
} from "./service.js";
import { diagnose, formatReport, reportToJson, type DoctorReport } from "./doctor.js";
import { runStop, STOP_USAGE, type StopOptions } from "./stop.js";
import { runConfig, CONFIG_USAGE, type RunConfigOptions } from "./config.js";
import {
    parseServiceArgs,
    runServiceCommand,
    SERVICE_USAGE,
    type ExecResult as ServiceExecResult,
    type ServiceAction,
} from "./service-control.js";

export { CliError } from "./util.js";
export { runStop, STOP_USAGE, type StopOptions } from "./stop.js";
export { runConfig, CONFIG_USAGE, type RunConfigOptions } from "./config.js";
export {
    SERVICE_ACTIONS,
    SERVICE_USAGE,
    parseServiceArgs,
    runServiceCommand,
    serviceArgv,
    serviceStatus,
    type ServiceStatus,
    type ServiceAction,
} from "./service-control.js";

export const USAGE = `pi2 — pi2 client

Usage:
  pi2 daemon [start] [options]       run the web-console daemon (foreground)
  pi2 daemon stop [options]          stop the running daemon
  pi2 stop [options]                 stop the running daemon (alias for daemon stop)
  pi2 attach [path]                  attach nvim to the workspace instance, else open nvim
  pi2 status [--json]                daemon info, instances, resources, health
  pi2 open [--print] [--no-browser]  open the web console signed in (local only)
  pi2 config [--json]                resolved configuration and sources
  pi2 doctor [--json]                environment checks
  pi2 pairing [--base <url>] [--json]   create a pairing code (URL + code + QR)
  pi2 install-service [--dry-run|--write]    systemd user unit / LaunchAgent
  pi2 uninstall-service [--dry-run|--write]  remove the unit
  pi2 service status|start|stop|enable|disable  control that unit (status [--json])
  pi2 --version | --help

\`pi2 stop\` / \`pi2 daemon stop\` flags: -f, --force sends SIGKILL if the daemon
does not exit in time; -t, --timeout <sec> configures the wait timeout (default 5s).
\`pi2 open\` flags: --print prints the URL only; --no-browser prints it instead
of launching a browser (--print implies --no-browser).
\`pi2 pairing\` flags: --base <url> pins the link to one of the addresses the
daemon advertises (it prints the alternatives; anything else is rejected);
--json prints the normalised mint payload ({url, code, expiresAt, qr, bases})
for tools and editor plugins instead of the human report.
The link prefers a phone-reachable address: the public URL when one is
configured, the primary LAN address, and loopback otherwise.

The daemon endpoint comes from $PI2_RUNTIME_DIR/daemon.json (port) and
$PI2_RUNTIME_DIR/cli.token (local admin token). Start it with \`pi2 daemon\`.
See docs/deployment.md.`;

export interface Endpoint {
    baseUrl: string;
    token: string;
    daemon: DaemonLock;
}

export interface DaemonClient {
    readonly baseUrl: string;
    readonly token: string;
    readonly daemon: DaemonLock;
    get<T>(path: string): Promise<T>;
    post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** Read `daemon.json` + `cli.token`; throws a helpful `CliError` when absent. */
export function resolveEndpoint(runtime: string = runtimeDir()): Endpoint {
    const daemon = readDaemonJson(resolve(runtime, "daemon.json"));
    if (daemon === undefined) {
        throw new CliError(
            `no running pi2 daemon (${resolve(runtime, "daemon.json")} missing). Start it with \`pi2 daemon\`.`,
        );
    }
    const token = readCliToken(cliTokenPath(runtime));
    if (token === undefined) {
        throw new CliError(`missing CLI token (${cliTokenPath(runtime)}). Restart the daemon (\`pi2 daemon\`).`);
    }
    return { baseUrl: `http://127.0.0.1:${daemon.port}`, token, daemon };
}

export interface ClientOptions {
    endpoint?: Endpoint;
    runtime?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
}

export function createClient(options: ClientOptions = {}): DaemonClient {
    const endpoint = options.endpoint ?? resolveEndpoint(options.runtime);
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 5_000;

    async function request(path: string, init: RequestInit): Promise<Response> {
        const url = `${endpoint.baseUrl}${path}`;
        try {
            return await fetchImpl(url, {
                ...init,
                headers: {
                    authorization: `Bearer ${endpoint.token}`,
                    "content-type": "application/json",
                    ...(init.headers ?? {}),
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new CliError(`cannot reach the pi2 daemon at ${endpoint.baseUrl}: ${errorMessage(error)}`);
        }
    }

    return {
        baseUrl: endpoint.baseUrl,
        token: endpoint.token,
        daemon: endpoint.daemon,
        async get<T>(path: string): Promise<T> {
            const response = await request(path, { method: "GET" });
            if (!response.ok) throw new CliError(`${path} failed: HTTP ${response.status} ${await safeText(response)}`);
            return (await response.json()) as T;
        },
        async post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
            const response = await request(path, { method: "POST", body: JSON.stringify(body) });
            const text = await safeText(response);
            let parsed: Record<string, unknown> = {};
            if (text.trim() !== "") {
                try {
                    parsed = JSON.parse(text) as Record<string, unknown>;
                } catch {
                    parsed = { raw: text };
                }
            }
            if (!response.ok) {
                const code = typeof parsed.code === "string" ? parsed.code : `HTTP ${response.status}`;
                const message = typeof parsed.message === "string" ? parsed.message : text;
                throw new CliError(`${path} failed: ${code} ${message}`.trim());
            }
            return { status: response.status, body: parsed };
        },
    };
}

async function safeText(response: Response): Promise<string> {
    try {
        return (await response.text()).trim();
    } catch {
        return "";
    }
}

// ---------------------------------------------------------------------------
// attach
// ---------------------------------------------------------------------------

export interface ExecOptions {
    cwd: string;
}

export interface AttachOptions {
    /** Directory to attach (defaults to `cwd`). */
    path?: string;
    cwd?: string;
    isTTY?: boolean;
    exec?: (command: string, args: string[], options: ExecOptions) => void;
    print?: (line: string) => void;
    warn?: (line: string) => void;
    client?: () => DaemonClient;
}

/** Replace this process with nvim (stdio inherited). */
export function execNvim(command: string, args: string[], options: ExecOptions): void {
    const result = spawnSync(command, args, { stdio: "inherit", cwd: options.cwd });
    if (result.error !== undefined && result.error !== null) {
        throw new CliError(`could not exec ${command}: ${result.error.message}`);
    }
    process.exit(result.status ?? 0);
}

/**
 * `pi2 attach`: if the workspace already has a managed instance with a UI
 * socket, attach to it with `--remote-ui`; otherwise start a plain `nvim`.
 * Never spawns a headless instance — the plugin registers itself.
 */
export async function runAttach(options: AttachOptions = {}): Promise<number> {
    const cwd = options.cwd ?? process.cwd();
    const target = realpathOrSelf(options.path === undefined ? cwd : resolve(cwd, options.path));
    const exec = options.exec ?? execNvim;
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
    const isTTY = options.isTTY ?? process.stdout.isTTY === true;

    const openPlainNvim = (): number => {
        exec("nvim", [], { cwd: target });
        return 0;
    };

    const factory = options.client ?? (() => createClient());
    let client: DaemonClient;
    try {
        client = factory();
    } catch (error) {
        // No daemon: nvim still works, the plugin just has nothing to dial.
        warn(`pi2: ${errorMessage(error)}`);
        return openPlainNvim();
    }

    let workspaces: WorkspaceInfo[];
    try {
        workspaces = await client.get<WorkspaceInfo[]>("/api/v1/workspaces");
    } catch (error) {
        warn(`pi2: ${errorMessage(error)}`);
        return openPlainNvim();
    }

    const workspace = workspaces.find((candidate) => realpathOrSelf(candidate.cwd) === target);
    const instance = workspace?.instance ?? null;
    if (instance != null && instance.listenAddr !== null && instance.status !== "stopped" && instance.status !== "stopping") {
        const args = ["--server", instance.listenAddr, "--remote-ui"];
        if (isTTY) {
            exec("nvim", args, { cwd: target });
        } else {
            print(`nvim ${args.join(" ")}`);
        }
        return 0;
    }

    return openPlainNvim();
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

interface InfoBody {
    v: number;
    daemonId: string;
    machineId: string;
    platform: string;
    capabilities: string[];
    limits: { maxBodyBytes: number; maxFrameBytes: number; maxConnections: number };
    host?: string;
    publicUrl?: string | null;
}

interface HealthBody {
    ok: boolean;
    items: { name: string; ok: boolean; detail: string }[];
}

export interface StatusOptions {
    json?: boolean;
    client: DaemonClient;
    print?: (line: string) => void;
}

export async function runStatus(options: StatusOptions): Promise<number> {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const client = options.client;
    const [info, workspaces, resources, health] = await Promise.all([
        client.get<InfoBody>("/api/v1/info"),
        client.get<WorkspaceInfo[]>("/api/v1/workspaces"),
        client.get<InstanceResourcesSnapshot>("/api/v1/resources"),
        client.get<HealthBody>("/api/v1/health"),
    ]);

    const instances = workspaces
        .filter((workspace) => workspace.instance != null)
        .map((workspace) => ({
            workspaceId: workspace.workspaceId,
            name: workspace.alias ?? workspace.name,
            cwd: workspace.cwd,
            status: workspace.instance?.status ?? "unknown",
            hasUI: workspace.instance?.hasUI ?? false,
            listenAddr: workspace.instance?.listenAddr ?? null,
            nvimPid: workspace.instance?.nvimPid ?? null,
            sessions: workspace.liveCount,
        }));

    if (options.json === true) {
        print(
            JSON.stringify(
                {
                    daemon: {
                        url: client.baseUrl,
                        ...info,
                        // Older daemons may not report them; daemon.json does.
                        host: info.host ?? client.daemon.host ?? null,
                        publicUrl: info.publicUrl ?? client.daemon.publicUrl ?? null,
                    },
                    instances,
                    resources,
                    health,
                },
                null,
                2,
            ),
        );
        return health.ok ? 0 : 1;
    }

    print(`daemon   ${client.baseUrl}  id ${info.daemonId}  v${info.v}  ${info.platform}`);
    print(`machine  ${info.machineId}   capabilities ${info.capabilities.join(",")}`);
    print("");

    if (instances.length === 0) {
        print("instances  (none — open nvim in a workspace to register one)");
    } else {
        print(
            formatTable(
                ["workspace", "cwd", "status", "ui", "sessions", "pid"],
                instances.map((instance) => [
                    instance.name,
                    instance.cwd,
                    instance.status,
                    instance.hasUI ? "yes" : "no",
                    String(instance.sessions),
                    instance.nvimPid === null ? "-" : String(instance.nvimPid),
                ]),
            ),
        );
    }
    print("");

    const rss = `${formatBytes(resources.totalRssBytes)} of ${formatBytes(resources.physicalMemoryBytes)}`;
    print(`resources  ${resources.instances.length} instance(s), rss ${rss}${resources.warn ? `  WARN: ${resources.reason ?? ""}` : ""}`);
    print(
        `health     ${health.ok ? "ok" : "degraded"}  ${health.items
            .map((item) => `${item.name}=${item.ok ? "ok" : "FAIL"}`)
            .join(" ")}`,
    );
    return health.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// pairing
// ---------------------------------------------------------------------------

export interface PairingOptions {
    client: DaemonClient;
    print?: (line: string) => void;
    /** `--base <url>`: pin the link to one of the addresses the daemon advertises. */
    base?: string | null;
    /** `--json`: emit the mint payload (url/code/expiry/QR matrix/bases) instead of a report. */
    json?: boolean;
}

/** One address the daemon says it is reachable on (`bases[]` in the mint response). */
export interface PairingBase {
    kind: string;
    name: string;
    address: string;
    url: string;
}

export interface PairingQr {
    version: number;
    ecc: string;
    mask: number;
    size: number;
    /** One string per module row, `1` = dark, without a quiet zone. */
    rows: string[];
}

export interface PairingResult {
    code: string;
    url: string;
    expiresAt?: number;
    nonce?: string;
    qr?: PairingQr;
    bases: PairingBase[];
}

/** Quiet zone around the terminal QR, in modules. */
const QR_QUIET_ZONE = 2;

/**
 * Render a QR matrix for a terminal: one character per module, two module rows
 * per text row via half blocks. The caller owns the width budget; a version 3
 * symbol (29 modules) plus the quiet zone stays well inside 80 columns.
 */
export function renderTerminalQr(rows: readonly string[]): string[] {
    const size = rows[0]?.length ?? 0;
    if (size === 0) return [];
    const width = size + QR_QUIET_ZONE * 2;
    const blank = "0".repeat(width);
    const frame = Array.from({ length: QR_QUIET_ZONE }, () => blank);
    const padded = [
        ...frame,
        ...rows.map((row) => `${"0".repeat(QR_QUIET_ZONE)}${row}${"0".repeat(QR_QUIET_ZONE)}`),
        ...frame,
    ];

    const lines: string[] = [];
    for (let index = 0; index < padded.length; index += 2) {
        const top = padded[index] ?? blank;
        const bottom = padded[index + 1] ?? blank;
        let line = "";
        for (let column = 0; column < width; column += 1) {
            const up = top[column] === "1";
            const down = bottom[column] === "1";
            line += up && down ? "█" : up ? "▀" : down ? "▄" : " ";
        }
        lines.push(line);
    }
    return lines;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function pairingQrOf(raw: unknown): PairingQr | undefined {
    const record = recordOf(raw);
    if (!record || !Array.isArray(record.rows) || record.rows.length === 0) return undefined;
    const rows = record.rows.filter((row: unknown): row is string => typeof row === "string");
    if (rows.length === 0) return undefined;
    return {
        version: typeof record.version === "number" ? record.version : 0,
        ecc: typeof record.ecc === "string" ? record.ecc : "M",
        mask: typeof record.mask === "number" ? record.mask : 0,
        size: typeof record.size === "number" ? record.size : (rows[0]?.length ?? 0),
        rows,
    };
}

function pairingBasesOf(raw: unknown): PairingBase[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value) => {
        const record = recordOf(value);
        if (!record || typeof record.url !== "string") return [];
        return [
            {
                kind: typeof record.kind === "string" ? record.kind : "other",
                name: typeof record.name === "string" ? record.name : "",
                address: typeof record.address === "string" ? record.address : "",
                url: record.url,
            },
        ];
    });
}

/**
 * `pi2 pairing` — mint a code and print a scannable link.
 *
 * The daemon owns the URL, the QR matrix and the list of usable bases (ADR
 * 0001); the CLI only renders them. `--base` narrows the choice, and the daemon
 * rejects anything it did not offer.
 */
export async function runPairing(options: PairingOptions): Promise<number> {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const base = options.base?.trim() ?? "";
    const response = await options.client.post("/api/v1/pair", base === "" ? {} : { base });

    const code = typeof response.body.code === "string" ? response.body.code : undefined;
    const url = typeof response.body.url === "string" ? response.body.url : undefined;
    if (code === undefined || url === undefined) throw new CliError("pairing failed: daemon returned no code");

    const expiresAt = typeof response.body.expiresAt === "number" ? response.body.expiresAt : undefined;
    const qr = pairingQrOf(response.body.qr);
    const bases = pairingBasesOf(response.body.bases);

    if (options.json === true) {
        // The same payload the HTTP mint returned, normalised: `:PiWebPair` in
        // pi2.nvim renders this instead of talking HTTP itself.
        print(
            JSON.stringify(
                {
                    url,
                    code,
                    ...(expiresAt === undefined ? {} : { expiresAt }),
                    ...(qr === undefined ? {} : { qr }),
                    bases,
                },
                null,
                2,
            ),
        );
        return 0;
    }

    print(`url     ${url}`);
    print(`code    ${code}`);
    if (expiresAt !== undefined) {
        const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        print(`expires in ${seconds}s (${new Date(expiresAt).toISOString()})`);
    }
    if (qr === undefined) {
        print("");
        print("note    the link is too long to encode as a QR code; open the url on the phone instead.");
    } else {
        print("");
        for (const line of renderTerminalQr(qr.rows)) print(line);
    }
    if (bases.length > 1) {
        print("");
        print("other addresses the phone could use (pi2 pairing --base <url>):");
        for (const candidate of bases) {
            print(`  ${candidate.kind.padEnd(9)} ${candidate.name.padEnd(12)} ${candidate.url}`);
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

export interface OpenOptions {
    client: DaemonClient;
    print?: (line: string) => void;
    /** `--print`: print the URL only and exit. */
    printOnly?: boolean;
    /** `--no-browser`: print the URL instead of launching one. */
    noBrowser?: boolean;
    /** Opener override; call `onError` when the launch fails. */
    openUrl?: (url: string, onError: () => void) => void;
}

/** Detached platform opener: `pi2 open` never waits for the browser. */
export function openInBrowser(url: string, onError: () => void): void {
    const command = osPlatform() === "darwin" ? "open" : "xdg-open";
    try {
        const child = spawn(command, [url], { detached: true, stdio: "ignore" });
        child.once("error", onError);
        child.unref();
    } catch {
        onError();
    }
}

/**
 * `pi2 open`: mint a loopback browser session and put the browser on it. The
 * token stays inside the returned URL (fragment), and only the URL is printed.
 */
export async function runOpen(options: OpenOptions): Promise<number> {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const result = await options.client.post("/api/v1/console/session", {});
    const url = typeof result.body.url === "string" ? result.body.url : undefined;
    if (url === undefined) throw new CliError("console session failed: daemon returned no url");

    if (options.printOnly === true || options.noBrowser === true) {
        print(url);
        return 0;
    }
    // A missing xdg-open only costs the auto-launch; the URL is still useful.
    (options.openUrl ?? openInBrowser)(url, () => print(url));
    return 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/** `pi2 doctor`: real probes, plus the live daemon when one is running. */
export async function runDoctorCommand(
    options: { runtime?: string; client?: () => DaemonClient } = {},
): Promise<DoctorReport> {
    const runtime = options.runtime;
    return diagnose({
        ...(runtime === undefined ? {} : { runtime }),
        daemonInfo: async () => {
            try {
                const client = options.client?.() ?? createClient({ ...(runtime === undefined ? {} : { runtime }) });
                const info = await client.get<{ v: number }>("/api/v1/info");
                return { port: client.daemon.port, protocolVersion: info.v };
            } catch (error) {
                return { error: error instanceof CliError ? error.message : errorMessage(error) };
            }
        },
    });
}

// ---------------------------------------------------------------------------
// install-service / uninstall-service
// ---------------------------------------------------------------------------
export interface ServiceCommandOptions {
    platform: ServicePlatform;
    paths: ServicePaths;
    write: boolean;
    print?: (line: string) => void;
    writeFile?: (path: string, content: string) => void;
    removeFile?: (path: string) => void;
}

function defaultWriteFile(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o644 });
}

function defaultRemoveFile(path: string): void {
    rmSync(path, { force: true });
}

export function runInstallService(options: ServiceCommandOptions): number {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const service = renderService(options.platform, options.paths);

    if (!options.write) {
        print(service.content);
        print(`# dry-run: would write ${service.path} (mode 0644)`);
        print(`# then run:\n${service.commands.map((command) => `#   ${command}`).join("\n")}`);
        return 0;
    }

    (options.writeFile ?? defaultWriteFile)(service.path, service.content);
    print(`wrote ${service.path} (mode 0644)`);
    print("enable it with:");
    for (const command of service.commands) print(`  ${command}`);
    return 0;
}

export function runUninstallService(options: ServiceCommandOptions): number {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const service: RenderedService = renderService(options.platform, options.paths);

    if (!options.write) {
        print(`# dry-run: would remove ${service.path}`);
        print(`# then run:\n${service.removeCommands.map((command) => `#   ${command}`).join("\n")}`);
        return 0;
    }

    (options.removeFile ?? defaultRemoveFile)(service.path);
    print(`removed ${service.path}`);
    print("finish with:");
    for (const command of service.removeCommands) print(`  ${command}`);
    return 0;
}

async function handleStop(argv: readonly string[], options: Pi2Options, out: (line: string) => void): Promise<number> {
    const parsed = parseArgs(argv, {
        values: ["--timeout", "-t"],
        booleans: ["--force", "--help"],
        aliases: { "-h": "--help", "-f": "--force", "-t": "--timeout" },
    });
    if (boolFlag(parsed.flags, "--help")) {
        out(STOP_USAGE);
        return 0;
    }
    if (parsed.positionals.length > 0) {
        throw new UsageError(`unexpected argument "${parsed.positionals[0]}"`, STOP_USAGE);
    }
    let timeoutSec: number | undefined;
    const timeout = stringFlag(parsed.flags, "--timeout");
    if (timeout !== undefined) {
        if (!/^\d+$/.test(timeout.trim())) {
            throw new UsageError(`--timeout must be a positive integer, got "${timeout}"`, STOP_USAGE);
        }
        const val = Number(timeout);
        if (!Number.isSafeInteger(val) || val <= 0) {
            throw new UsageError(`--timeout must be a positive integer, got "${timeout}"`, STOP_USAGE);
        }
        timeoutSec = val;
    }
    const runner = options.stopRunner ?? runStop;
    return await runner({
        runtime: options.runtime,
        force: boolFlag(parsed.flags, "--force"),
        ...(timeoutSec === undefined ? {} : { timeoutSec }),
        print: out,
        ...(options.isPidAlive === undefined ? {} : { isPidAlive: options.isPidAlive }),
        ...(options.kill === undefined ? {} : { kill: options.kill }),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.removeFile === undefined ? {} : { unlink: options.removeFile }),
    });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export interface Pi2Options {
    out?: (line: string) => void;
    err?: (line: string) => void;
    client?: () => DaemonClient;
    exec?: (command: string, args: string[], options: ExecOptions) => void;
    cwd?: string;
    isTTY?: boolean;
    doctor?: () => Promise<DoctorReport>;
    servicePaths?: ServicePaths;
    platform?: ServicePlatform;
    writeFile?: (path: string, content: string) => void;
    removeFile?: (path: string) => void;
    runtime?: string;
    env?: Record<string, string | undefined>;
    /** Injected `pi2 daemon` runner (defaults to `src/cli/daemon.ts:main`). */
    daemonMain?: (argv: readonly string[], io: { out: (line: string) => void; err: (line: string) => void }) => Promise<number>;
    stopRunner?: (options: StopOptions) => Promise<number>;
    isPidAlive?: (pid: number) => boolean;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    sleep?: (ms: number) => Promise<void>;
    /** Injected service manager runner (defaults to `spawnSync`). */
    serviceExec?: (argv: string[]) => ServiceExecResult;
    /** Injected unit-file existence probe (defaults to `fs.existsSync`). */
    serviceExists?: (path: string) => boolean;
    serviceUid?: number;
    serviceUser?: string;
}

export async function main(argv: readonly string[], options: Pi2Options = {}): Promise<number> {
    const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
    const err = options.err ?? ((line: string) => process.stderr.write(`${line}\n`));
    const [command, ...rest] = argv;

    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
        out(USAGE);
        return 0;
    }
    if (command === "--version" || command === "-V" || command === "version") {
        out(`pi2 ${packageVersion()}`);
        return 0;
    }

    try {
        switch (command) {
            case "daemon": {
                if (rest[0] === "stop") {
                    return await handleStop(rest.slice(1), options, out);
                }
                // `pi2 daemon` and `pi2 daemon start` are the same thing; the
                // optional `start` word is consumed here so the daemon parser
                // only ever sees flags.
                const argv = rest[0] === "start" ? rest.slice(1) : rest;
                return await (options.daemonMain ?? runDaemonMain)(argv, { out, err });
            }
            case "stop": {
                return await handleStop(rest, options, out);
            }
            case "attach": {
                const parsed = parseArgs(rest, { booleans: ["--help"], aliases: { "-h": "--help" } });
                if (boolFlag(parsed.flags, "--help")) {
                    out(USAGE);
                    return 0;
                }
                if (parsed.positionals.length > 1) throw new UsageError("attach takes at most one path");
                return await runAttach({
                    ...(parsed.positionals[0] === undefined ? {} : { path: parsed.positionals[0] }),
                    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                    ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }),
                    ...(options.exec === undefined ? {} : { exec: options.exec }),
                    ...(options.client === undefined ? {} : { client: options.client }),
                    print: out,
                    warn: err,
                });
            }
            case "status": {
                const parsed = parseArgs(rest, { booleans: ["--json", "--help"], aliases: { "-h": "--help" } });
                if (boolFlag(parsed.flags, "--help")) {
                    out(USAGE);
                    return 0;
                }
                const client = (options.client ?? (() => createClient({ ...(options.runtime === undefined ? {} : { runtime: options.runtime }) })))();
                return await runStatus({ client, json: boolFlag(parsed.flags, "--json"), print: out });
            }
            case "open": {
                const parsed = parseArgs(rest, {
                    booleans: ["--print", "--no-browser", "--help"],
                    aliases: { "-h": "--help" },
                });
                if (boolFlag(parsed.flags, "--help")) {
                    out(USAGE);
                    return 0;
                }
                if (parsed.positionals.length > 0) throw new UsageError("open takes no arguments");
                const client = (options.client ?? (() => createClient({ ...(options.runtime === undefined ? {} : { runtime: options.runtime }) })))();
                return await runOpen({
                    client,
                    print: out,
                    printOnly: boolFlag(parsed.flags, "--print"),
                    noBrowser: boolFlag(parsed.flags, "--no-browser"),
                });
            }
            case "config": {
                let parsed;
                try {
                    parsed = parseArgs(rest, { booleans: ["--json", "--help"], aliases: { "-h": "--help" } });
                } catch (error) {
                    if (error instanceof UsageError) {
                        throw new UsageError(error.message, CONFIG_USAGE);
                    }
                    throw error;
                }
                if (boolFlag(parsed.flags, "--help")) {
                    out(CONFIG_USAGE);
                    return 0;
                }
                if (parsed.positionals.length > 0) {
                    throw new UsageError(`unexpected argument "${parsed.positionals[0]}"`, CONFIG_USAGE);
                }
                return runConfig({
                    env: options.env ?? process.env,
                    ...(options.platform === undefined ? {} : { platform: options.platform }),
                    json: boolFlag(parsed.flags, "--json"),
                    print: out,
                });
            }
            case "doctor": {
                const parsed = parseArgs(rest, { booleans: ["--json", "--help"], aliases: { "-h": "--help" } });
                if (boolFlag(parsed.flags, "--help")) {
                    out(USAGE);
                    return 0;
                }
                const report = await (options.doctor ?? (() => runDoctorCommand(options)))();
                out(boolFlag(parsed.flags, "--json") ? reportToJson(report) : formatReport(report));
                return report.ok ? 0 : 1;
            }
            case "pairing":
            case "pair": {
                const parsed = parseArgs(rest, {
                    values: ["--base"],
                    booleans: ["--json", "--help"],
                    aliases: { "-h": "--help" },
                });
                if (boolFlag(parsed.flags, "--help")) {
                    out(USAGE);
                    return 0;
                }
                const client = (options.client ?? (() => createClient({ ...(options.runtime === undefined ? {} : { runtime: options.runtime }) })))();
                return await runPairing({
                    client,
                    print: out,
                    base: stringFlag(parsed.flags, "--base"),
                    json: boolFlag(parsed.flags, "--json"),
                });
            }
            case "install-service":
            case "uninstall-service": {
                const parsed = parseArgs(rest, { booleans: ["--dry-run", "--write", "--help"], aliases: { "-h": "--help" } });
                if (boolFlag(parsed.flags, "--help")) {
                    out(USAGE);
                    return 0;
                }
                const platform = options.platform ?? (osPlatform() === "darwin" ? "darwin" : "linux");
                const paths = options.servicePaths ?? defaultServicePaths();
                const serviceOptions: ServiceCommandOptions = {
                    platform,
                    paths,
                    write: boolFlag(parsed.flags, "--write"),
                    print: out,
                    ...(options.writeFile === undefined ? {} : { writeFile: options.writeFile }),
                    ...(options.removeFile === undefined ? {} : { removeFile: options.removeFile }),
                };
                return command === "install-service" ? runInstallService(serviceOptions) : runUninstallService(serviceOptions);
            }
            case "service": {
                const parsed = parseServiceArgs(rest);
                if (parsed.help) {
                    out(SERVICE_USAGE);
                    return 0;
                }
                const platform = options.platform ?? (osPlatform() === "darwin" ? "darwin" : "linux");
                const paths = options.servicePaths ?? defaultServicePaths();
                return await runServiceCommand(parsed.action as ServiceAction, {
                    platform,
                    paths,
                    print: out,
                    json: parsed.json,
                    ...(options.env === undefined ? {} : { env: options.env }),
                    ...(options.serviceExec === undefined ? {} : { exec: options.serviceExec }),
                    ...(options.serviceExists === undefined ? {} : { exists: options.serviceExists }),
                    ...(options.serviceUid === undefined ? {} : { uid: options.serviceUid }),
                    ...(options.serviceUser === undefined ? {} : { user: options.serviceUser }),
                });
            }
            default:
                err(`pi2: unknown command "${command}"`);
                err(USAGE);
                return 2;
        }
    } catch (error) {
        if (error instanceof UsageError) {
            err(`pi2: ${error.message}`);
            err(error.usage ?? USAGE);
            return 2;
        }
        if (error instanceof CliError) {
            err(`pi2: ${error.message}`);
            return error.code;
        }
        err(`pi2: ${errorMessage(error)}`);
        return 1;
    }
}

function isDirectRun(): boolean {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    try {
        return realpathOrSelf(entry) === realpathOrSelf(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isDirectRun()) {
    void main(process.argv.slice(2)).then(
        (code) => {
            if (code !== 0) process.exitCode = code;
        },
        (error: unknown) => {
            process.stderr.write(`pi2: ${errorMessage(error)}\n`);
            process.exitCode = 1;
        },
    );
}

/** Exposed so `service.test.ts` can check the same rendering the command uses. */
export { renderService, serviceDir };
