#!/usr/bin/env node
/**
 * `pi2` — the user-facing CLI.
 *
 *   pi2 attach [path]      attach nvim to the workspace instance (or open nvim)
 *   pi2 status [--json]    daemon, instances, resources, health
 *   pi2 doctor [--json]    environment checks
 *   pi2 pairing            create a pairing code for another device
 *   pi2 install-service    render/install a systemd user unit or LaunchAgent
 *   pi2 uninstall-service  remove it again
 *
 * Everything is discovered from the runtime dir: `daemon.json` carries the
 * bound port, `cli.token` the local admin token (see docs/deployment.md).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform as osPlatform } from "node:os";
import { runtimeDir } from "../core/paths.js";
import type { InstanceResourcesSnapshot } from "../core/interfaces.js";
import type { WorkspaceInfo } from "../protocol/types.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import { readDaemonJson, type DaemonLock } from "./lock.js";
import { cliTokenPath, readCliToken } from "./token.js";
import {
    boolFlag,
    errorMessage,
    formatBytes,
    formatTable,
    packageVersion,
    parseArgs,
    realpathOrSelf,
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

export const USAGE = `pi2 — pi2 client

Usage:
  pi2 attach [path]                  attach nvim to the workspace instance, else open nvim
  pi2 status [--json]                daemon info, instances, resources, health
  pi2 doctor [--json]                environment checks
  pi2 pairing                        create a pairing code (URL + code + QR payload)
  pi2 install-service [--dry-run|--write]    systemd user unit / LaunchAgent
  pi2 uninstall-service [--dry-run|--write]  remove the unit
  pi2 --version | --help

The daemon endpoint comes from $PI2_RUNTIME_DIR/daemon.json (port) and
$PI2_RUNTIME_DIR/cli.token (local admin token). Start it with \`pi2d\`.
See docs/deployment.md.`;

/** A user-facing failure: printed as-is, exits with `code`. */
export class CliError extends Error {
    readonly code: number;

    constructor(message: string, code = 1) {
        super(message);
        this.name = "CliError";
        this.code = code;
    }
}

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
            `no running pi2d (${resolve(runtime, "daemon.json")} missing). Start it with \`pi2d --foreground\`.`,
        );
    }
    const token = readCliToken(cliTokenPath(runtime));
    if (token === undefined) {
        throw new CliError(`missing CLI token (${cliTokenPath(runtime)}). Restart \`pi2d\`.`);
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
            throw new CliError(`cannot reach pi2d at ${endpoint.baseUrl}: ${errorMessage(error)}`);
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
                    daemon: { url: client.baseUrl, ...info },
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
}

export async function runPairing(options: PairingOptions): Promise<number> {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const result = await options.client.post("/api/v1/pair", {});
    const code = typeof result.body.code === "string" ? result.body.code : undefined;
    if (code === undefined) throw new CliError("pairing failed: daemon returned no code");
    const expiresAt = typeof result.body.expiresAt === "number" ? result.body.expiresAt : undefined;
    const nonce = typeof result.body.nonce === "string" ? result.body.nonce : undefined;
    // Rebuild the URL from the *actual* base URL: the daemon's own `url` field is
    // derived from the configured port, which is stale after a retry or `--port 0`.
    const url = `${options.client.baseUrl}/pair/${code}`;
    const payload = JSON.stringify({ v: PROTOCOL_VERSION, code, url, ...(expiresAt === undefined ? {} : { expiresAt }), ...(nonce === undefined ? {} : { nonce }) });

    print(`url     ${url}`);
    print(`code    ${code}`);
    if (expiresAt !== undefined) {
        print(`expires ${new Date(expiresAt).toISOString()} (${Math.max(0, Math.round((expiresAt - Date.now()) / 1000))}s)`);
    }
    print(`qr      ${payload}`);
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
                parseArgs(rest, { booleans: ["--help"], aliases: { "-h": "--help" } });
                const client = (options.client ?? (() => createClient({ ...(options.runtime === undefined ? {} : { runtime: options.runtime }) })))();
                return await runPairing({ client, print: out });
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
