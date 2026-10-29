/**
 * `pi2 service status|start|stop|enable|disable` — user-service control.
 *
 * `pi2 install-service --write` renders the unit file and stops there
 * (`src/cli/service.ts` is pure string generation). This module is the explicit
 * counterpart: it talks to systemd / launchd, but only when the user asks for it
 * (ADR 0002 §2.2). The Neovim plugin never shells out to a service manager
 * itself — it calls `pi2 service …`, so the platform knowledge stays here.
 *
 * Two properties the callers depend on:
 *   1. `status` never fails: no manager, no unit and a dead service are all
 *      reports, not errors (`--json` is the machine-readable form).
 *   2. `start|stop|enable|disable` are the only paths that mutate state, and a
 *      manager refusal becomes a `CliError` with the manager's own first line.
 *
 * Everything is injected (`exec`, `exists`, `platform`, `paths`, `uid`, `user`,
 * `env`) so the tests stay hermetic: nothing here runs a real systemctl.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
    defaultServicePaths,
    LAUNCHD_LABEL,
    LAUNCHD_PLIST_NAME,
    launchAgentDir,
    SYSTEMD_UNIT_NAME,
    systemdUserDir,
    type ServicePaths,
    type ServicePlatform,
} from "./service.js";
import { CliError, parseArgs, type FlagValue, UsageError } from "./util.js";

export type ServiceAction = "status" | "start" | "stop" | "enable" | "disable";

/** Every action the dispatcher accepts, in help order. */
export const SERVICE_ACTIONS: readonly ServiceAction[] = ["status", "start", "stop", "enable", "disable"];

export const SERVICE_USAGE = `pi2 service — control the user service that runs the daemon

Usage:
  pi2 service status [--json]   report the unit, enablement, activity and linger
  pi2 service start             start the installed unit
  pi2 service stop              stop it (disable the unit to keep it down)
  pi2 service enable            enable it (systemd: --now; launchd: bootstrap+enable)
  pi2 service disable           disable it (systemd: --now; launchd: bootout)

The unit is the one \`pi2 install-service --write\` renders
(\`pi2.service\` on Linux, \`com.pi2.daemon.plist\` on macOS).
\`--json\` is only valid for \`service status\`.`;

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

/** One `systemctl`/`launchctl` invocation, injectable in tests. */
export type ServiceExec = (argv: string[]) => ExecResult;

export interface ServiceStatus {
    platform: ServicePlatform;
    manager: "systemd" | "launchd" | "none";
    unit: { name: string; path: string; installed: boolean };
    enabled: boolean | null;
    active: boolean | null;
    linger: boolean | null;
    error: string | null;
}

export interface ServiceContext {
    platform: ServicePlatform;
    paths: ServicePaths;
    uid: number;
    user: string;
    env: Record<string, string | undefined>;
}

export interface ServiceControlOptions {
    platform?: ServicePlatform;
    paths?: ServicePaths;
    exec?: ServiceExec;
    exists?: (path: string) => boolean;
    uid?: number;
    user?: string;
    env?: Record<string, string | undefined>;
    print?: (line: string) => void;
    json?: boolean;
}

/** `spawnSync` wrapper: a missing binary is `code 127`, never a throw. */
export function defaultServiceExec(argv: string[]): ExecResult {
    const [command, ...args] = argv;
    if (command === undefined) {
        return { code: 127, stdout: "", stderr: "empty command" };
    }
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error !== undefined) {
        return { code: 127, stdout: "", stderr: result.error.message };
    }
    return {
        code: result.status ?? (result.signal === null ? 1 : 1),
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

/** Resolve the platform-specific bits once, honouring every injection point. */
export function serviceContext(options: ServiceControlOptions = {}): ServiceContext {
    const platform =
        options.platform ?? ((process.platform === "darwin" ? "darwin" : "linux") as ServicePlatform);
    const paths = options.paths ?? defaultServicePaths();
    const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    const user = options.user ?? (process.env.USER ?? process.env.LOGNAME ?? safeUserInfo());
    const env = options.env ?? process.env;
    return { platform, paths, uid, user, env };
}

function safeUserInfo(): string {
    try {
        return userInfo().username;
    } catch {
        return "user";
    }
}

/** Unit name + absolute path for the platform (the file `install-service` writes). */
export function serviceUnit(ctx: ServiceContext): { name: string; path: string } {
    if (ctx.platform === "darwin") {
        return { name: LAUNCHD_PLIST_NAME, path: join(launchAgentDir(ctx.paths), LAUNCHD_PLIST_NAME) };
    }
    return { name: SYSTEMD_UNIT_NAME, path: join(systemdUserDir(ctx.paths), SYSTEMD_UNIT_NAME) };
}

/** `gui/<uid>/com.pi2.daemon` — the launchd job target. */
function launchdTarget(ctx: ServiceContext): string {
    return `gui/${ctx.uid}/${LAUNCHD_LABEL}`;
}

/**
 * The commands one action runs, in order. Pure: no process is started here, so
 * the tests assert argv directly. `status` is a probe set, not a command list,
 * and therefore returns `[]`.
 */
export function serviceArgv(action: ServiceAction, ctx: ServiceContext): string[][] {
    if (action === "status") {
        return [];
    }
    const unit = serviceUnit(ctx);
    if (ctx.platform === "darwin") {
        switch (action) {
            case "start":
                return [["launchctl", "kickstart", "-k", launchdTarget(ctx)]];
            case "stop":
                return [["launchctl", "kill", "TERM", launchdTarget(ctx)]];
            case "enable":
                // `bootstrap` registers a plist that is not loaded yet; the
                // second call makes sure the job is also enabled at login.
                return [
                    ["launchctl", "bootstrap", `gui/${ctx.uid}`, unit.path],
                    ["launchctl", "enable", launchdTarget(ctx)],
                ];
            case "disable":
                return [["launchctl", "bootout", `gui/${ctx.uid}`]];
        }
    }
    switch (action) {
        case "start":
            return [["systemctl", "--user", "start", unit.name]];
        case "stop":
            return [["systemctl", "--user", "stop", unit.name]];
        case "enable":
            return [["systemctl", "--user", "enable", "--now", unit.name]];
        case "disable":
            return [["systemctl", "--user", "disable", "--now", unit.name]];
    }
}

/** First non-empty line of stderr, else stdout, else a generic message. */
function firstLine(...texts: string[]): string {
    for (const text of texts) {
        const line = text
            .split("\n")
            .map((entry) => entry.trim())
            .find((entry) => entry !== "");
        if (line !== undefined) {
            return line;
        }
    }
    return "";
}

function shellLine(argv: string[]): string {
    return argv.join(" ");
}

/** `Linger=yes` → true, `Linger=no` → false, anything else → null. */
function parseLinger(result: ExecResult): boolean | null {
    if (result.code !== 0) {
        return null;
    }
    const match = /^Linger=(yes|no)$/m.exec(result.stdout);
    if (match === null) {
        return null;
    }
    return match[1] === "yes";
}

/**
 * Probe the unit without mutating anything. Never throws: an unavailable
 * service manager yields `manager: "none"`, `null` flags and a one-line error.
 */
export function serviceStatus(options: ServiceControlOptions = {}): ServiceStatus {
    const ctx = serviceContext(options);
    const exec = options.exec ?? defaultServiceExec;
    const exists = options.exists ?? existsSync;
    const unit = serviceUnit(ctx);
    const installed = exists(unit.path);

    if (ctx.platform === "darwin") {
        const probe = exec(["launchctl", "print", launchdTarget(ctx)]);
        const managerMissing = probe.code === 127;
        return {
            platform: "darwin",
            manager: managerMissing ? "none" : "launchd",
            unit: { ...unit, installed },
            enabled: managerMissing ? null : installed,
            active: managerMissing ? null : probe.code === 0,
            linger: null,
            error: managerMissing ? firstLine(probe.stderr) || "launchctl not found on PATH" : null,
        };
    }

    const available = exec(["systemctl", "--version"]);
    if (available.code !== 0) {
        return {
            platform: "linux",
            manager: "none",
            unit: { ...unit, installed },
            enabled: null,
            active: null,
            linger: null,
            error: firstLine(available.stderr) || "systemctl not found on PATH",
        };
    }

    const enabledProbe = exec(["systemctl", "--user", "is-enabled", unit.name]);
    const activeProbe = exec(["systemctl", "--user", "is-active", unit.name]);
    const lingerProbe = exec(["loginctl", "show-user", ctx.user, "-p", "Linger"]);
    return {
        platform: "linux",
        manager: "systemd",
        unit: { ...unit, installed },
        // is-enabled exits 0 for enabled, non-zero for disabled/static/masked;
        // a 127 here would mean systemd vanished between the two calls.
        enabled: enabledProbe.code === 127 ? null : enabledProbe.code === 0,
        active: activeProbe.code === 127 ? null : activeProbe.code === 0,
        linger: parseLinger(lingerProbe),
        error: null,
    };
}

/** Human-readable `service status` report, one fact per line. */
export function formatServiceStatus(status: ServiceStatus): string[] {
    const lines: string[] = [];
    const manager = status.manager === "none" ? "none (no service manager available)" : status.manager;
    lines.push(`manager    ${manager}`);
    lines.push(`unit       ${status.unit.path}${status.unit.installed ? "" : " (missing)"}`);
    const flag = (value: boolean | null): string => (value === null ? "unknown" : value ? "yes" : "no");
    lines.push(`installed  ${status.unit.installed ? "yes" : "no"}`);
    lines.push(`enabled    ${flag(status.enabled)}`);
    lines.push(`active     ${flag(status.active)}`);
    if (status.platform === "linux") {
        lines.push(`linger     ${flag(status.linger)}`);
    }
    if (status.error !== null) {
        lines.push(`error      ${status.error}`);
    }
    if (!status.unit.installed) {
        lines.push("# next: pi2 install-service --write, then pi2 service enable");
    } else if (status.enabled !== true || status.active !== true) {
        lines.push("# next: pi2 service enable");
    }
    return lines;
}

/** Machine-readable `service status --json` body. */
export function formatServiceStatusJson(status: ServiceStatus): string {
    return JSON.stringify(status, null, 2);
}

/**
 * Run one action.
 *
 * `status` prints a report and returns 0 whatever the state of the world.
 * The four mutating actions return 0 on success and throw a `CliError` when a
 * manager command fails (with that manager's first stderr line).
 */
export async function runServiceCommand(
    action: ServiceAction,
    options: ServiceControlOptions = {},
): Promise<number> {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const ctx = serviceContext(options);

    if (action === "status") {
        const status = serviceStatus(options);
        if (options.json === true) {
            print(formatServiceStatusJson(status));
        } else {
            for (const line of formatServiceStatus(status)) {
                print(line);
            }
        }
        return 0;
    }

    const unit = serviceUnit(ctx);
    const exists = options.exists ?? existsSync;
    if (!exists(unit.path)) {
        throw new CliError(
            `no service unit at ${unit.path} — run \`pi2 install-service --write\` first`,
        );
    }

    const exec = options.exec ?? defaultServiceExec;
    const argvList = serviceArgv(action, ctx);
    for (const argv of argvList) {
        const result = exec(argv);
        if (result.code !== 0) {
            const detail = firstLine(result.stderr, result.stdout);
            throw new CliError(
                detail !== ""
                    ? `${shellLine(argv)} failed: ${detail}`
                    : `${shellLine(argv)} failed (exit ${result.code})`,
            );
        }
    }

    print(`service ${action}: ${argvList.map(shellLine).join(" && ")}`);
    if (action === "stop") {
        print("# the unit is still enabled; run `pi2 service disable` to keep it down");
    }
    return 0;
}

// ---------------------------------------------------------------------------
// dispatcher glue
// ---------------------------------------------------------------------------

/** Parse `pi2 service …` argv into an action + flags. Throws `UsageError`. */
export function parseServiceArgs(argv: readonly string[]): { action: ServiceAction; json: boolean; help: boolean } {
    const parsed = parseArgs(argv, {
        booleans: ["--json", "--help"],
        aliases: { "-h": "--help" },
    });
    const flags: Record<string, FlagValue> = parsed.flags;
    const help = flags["--help"] === true;
    const json = flags["--json"] === true;
    if (help) {
        return { action: "status", json, help };
    }
    const raw = parsed.positionals[0] ?? "status";
    if (!SERVICE_ACTIONS.includes(raw as ServiceAction)) {
        throw new UsageError(`unknown service action "${raw}"`, SERVICE_USAGE);
    }
    if (parsed.positionals.length > 1) {
        throw new UsageError(`unexpected argument "${parsed.positionals[1]}"`, SERVICE_USAGE);
    }
    if (json && raw !== "status") {
        throw new UsageError("--json is only valid for `pi2 service status`", SERVICE_USAGE);
    }
    return { action: raw as ServiceAction, json, help };
}
