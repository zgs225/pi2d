/**
 * `pi2 uninstall` — remove what pi2 wrote to this machine.
 *
 * Every other removal path owns one slice and knows nothing about the others:
 * `npm rm -g`, `brew uninstall`, `install.sh --uninstall` own a binary tree,
 * `pi2 uninstall-service` owns the unit file, and none of them touches the
 * runtime/data/state directories. Deleting the binary while the daemon still
 * runs also leaves an orphan process. This command owns the *state* for every
 * channel, and prints the channel's own command for the binary tree instead of
 * deleting a tree a package manager tracks.
 *
 * The layout is the one `docs/deployment.md` documents:
 *
 *   runtime  sockets, `cli.token`, `daemon.lock`        always removed
 *   data     `devices.json`, `workspaces.json`          `--purge`
 *   state    instance logs, host-init, update cache     `--purge`
 *   config   `~/.config/pi2/env`                        `--purge-config`
 *   unit     systemd/launchd file                       removed unless --keep-service
 *   install  `<prefix>` on the curl channel             `--purge` (last: we run from it)
 *
 * Destructive by design, so: a plan is printed first, nothing happens without
 * `--yes` (or an interactive `y`), and everything a reinstall would silently
 * lose is an explicit opt-in.
 *
 * Every side effect is injected (`removeDir`, `removeFile`, `disableService`,
 * `removeService`, `stopDaemon`, `daemonPid`, `serviceInstalled`, `channel`,
 * `confirm`) so the tests never touch the filesystem, systemd or a process.
 */
import { existsSync, rmSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join, sep } from "node:path";
import { isBundledRuntime, versionedLayoutFor } from "../core/install.js";
import { dataDir, realpathSafe, runtimeDir, stateDir } from "../core/paths.js";
import { channelUninstallCommand } from "../core/release.js";
import {
    assessLock,
    DAEMON_JSON_FILE,
    isPidAlive,
    LOCK_FILE,
    readBootId,
    readDaemonJson,
    readLockFile,
} from "./lock.js";
import { defaultServicePaths, renderService, type ServicePaths, type ServicePlatform } from "./service.js";
import { runServiceCommand } from "./service-control.js";
import { runStop } from "./stop.js";
import { CliError, errorMessage } from "./util.js";

export const UNINSTALL_USAGE = `pi2 uninstall — remove pi2's local state

Usage:
  pi2 uninstall [options]

Stops the daemon, disables and removes the user service unit when one is
installed, and deletes the runtime directory (sockets, CLI token, lock).
Everything a reinstall would silently lose is opt-in:

  --purge         also delete the data dir (paired devices, workspace trust)
                  and the state dir (instance logs, host-init, update cache)
  --purge-config  also delete the env file (~/.config/pi2/env)

On the standalone channel (curl installer) \`--purge\` also removes the install
tree. It goes last, because the running binary lives inside it.

Options:
  --dry-run        print the plan, change nothing
  -y, --yes        do not ask for confirmation (required when stdin is not a TTY)
  --purge          also remove the data and state directories
  --purge-config   also remove the env file
  --keep-service   leave the user service unit installed
  --keep-install   never remove the curl-installer tree, even with --purge
  -h, --help       print this help and exit

The binaries themselves belong to the channel that installed them (npm, brew,
the AUR, or \`install.sh --uninstall\`); this command prints that command rather
than deleting a tree it does not own.

Environment:
  PI2_RUNTIME_DIR  runtime directory (default: $XDG_RUNTIME_DIR/pi2)
  PI2_DATA_DIR     data directory (default: ~/.local/share/pi2)
  PI2_STATE_DIR    state directory (default: ~/.local/state/pi2)
  XDG_CONFIG_HOME  locates the env file (default: ~/.config/pi2/env)`;

export type UninstallTarget = "service" | "daemon" | "runtime" | "data" | "state" | "config" | "install";

/** One line of the plan; `remove: false` is the "kept, and here is the flag" case. */
export interface UninstallStep {
    target: UninstallTarget;
    /** Absolute paths this step deletes. Empty for `daemon`. */
    paths: string[];
    remove: boolean;
    /** `pid 4242` for the daemon step. */
    detail?: string;
}

export type UninstallChannelName = "curl" | "brew" | "aur" | "npm" | "unknown";

export interface UninstallChannel {
    installer: UninstallChannelName;
    /** curl-installer layout only: `<prefix>` holding `versions/` and `current`. */
    prefix?: string;
}

/**
 * Which channel owns the binary tree. The versioned layout is unambiguous (only
 * `install.sh` writes `<prefix>/versions/<version>/bin/pi2`); the rest is a
 * best-effort read of where the executable sits, used only for the hint text.
 */
export function detectUninstallChannel(execPath: string, bundled: boolean): UninstallChannel {
    const layout = versionedLayoutFor(execPath);
    if (layout !== undefined) return { installer: "curl", prefix: layout.prefix };
    if (!bundled) return { installer: "npm" };
    if (execPath.includes("/Cellar/") || execPath.includes("/homebrew/")) return { installer: "brew" };
    if (execPath.startsWith("/usr/")) return { installer: "aur" };
    return { installer: "unknown" };
}

/** `$XDG_CONFIG_HOME/pi2/env` — the `EnvironmentFile=` a systemd unit points at. */
export function configEnvPath(
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): string {
    return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "pi2", "env");
}

const TARGET_LABEL: Record<UninstallTarget, string> = {
    service: "service unit",
    daemon: "daemon",
    runtime: "runtime dir",
    data: "data dir",
    state: "state dir",
    config: "config file",
    install: "install tree",
};

/** Why a kept path is kept — the flag that would remove it. */
const TARGET_HINT: Partial<Record<UninstallTarget, string>> = {
    data: "--purge",
    state: "--purge",
    config: "--purge-config",
    install: "--purge",
    service: "--keep-service",
};

export interface UninstallPlanOptions {
    runtime: string;
    data: string;
    state: string;
    configEnv: string;
    /** The unit file path (`renderService(...).path`). */
    serviceUnit: string;
    purge: boolean;
    purgeConfig: boolean;
    keepService?: boolean;
    keepInstall?: boolean;
    serviceInstalled: boolean;
    daemonPid?: number;
    channel: UninstallChannel;
    /** Injected in tests; `existsSync` otherwise. */
    exists?: (path: string) => boolean;
}

/** Pure: what would be touched, in execution order. */
export function planUninstall(options: UninstallPlanOptions): UninstallStep[] {
    const exists = options.exists ?? existsSync;
    const steps: UninstallStep[] = [];

    if (options.serviceInstalled) {
        steps.push({
            target: "service",
            paths: [options.serviceUnit],
            remove: options.keepService !== true,
        });
    }
    if (options.daemonPid !== undefined) {
        steps.push({ target: "daemon", paths: [], remove: true, detail: `pid ${options.daemonPid}` });
    }
    if (exists(options.runtime)) {
        steps.push({ target: "runtime", paths: [options.runtime], remove: true });
    }

    const optional: [UninstallTarget, string, boolean][] = [
        ["data", options.data, options.purge],
        ["state", options.state, options.purge],
        ["config", options.configEnv, options.purgeConfig],
    ];
    for (const [target, path, remove] of optional) {
        if (!exists(path)) continue;
        steps.push({ target, paths: [path], remove });
    }

    // Only the tree pi2 itself wrote can be deleted here; npm/brew/AUR own theirs.
    if (
        options.purge &&
        options.channel.installer === "curl" &&
        options.channel.prefix !== undefined &&
        exists(options.channel.prefix)
    ) {
        steps.push({
            target: "install",
            paths: [options.channel.prefix],
            remove: options.keepInstall !== true,
        });
    }

    return steps;
}

/** One plan line: verb, target label, path (or pid), and the flag that keeps it. */
export function formatUninstallStep(step: UninstallStep, dryRun = false): string {
    const verb = step.remove
        ? dryRun
            ? step.target === "daemon"
                ? "would stop"
                : "would remove"
            : step.target === "daemon"
              ? "stop"
              : "remove"
        : "keep";
    const target = step.detail ?? step.paths.join(", ");
    // The hint names the flag that would change the outcome, so it only makes
    // sense on a kept step.
    const hint = step.remove ? undefined : TARGET_HINT[step.target];
    return `  ${verb.padEnd(14)}${TARGET_LABEL[step.target].padEnd(14)}${target}${hint === undefined ? "" : `  (${hint})`}`;
}

/** `~/.local/bin/pi2`, when it is a symlink into the curl-installer prefix. */
export function installerBinSymlink(prefix: string, home: string = homedir()): string | undefined {
    const candidate = join(home, ".local", "bin", "pi2");
    if (!existsSync(candidate)) return undefined;
    return realpathSafe(candidate).startsWith(`${prefix}${sep}`) ? candidate : undefined;
}

export interface UninstallOptions {
    runtime?: string;
    data?: string;
    state?: string;
    configEnv?: string;
    purge?: boolean;
    purgeConfig?: boolean;
    keepService?: boolean;
    keepInstall?: boolean;
    dryRun?: boolean;
    yes?: boolean;
    platform?: ServicePlatform;
    servicePaths?: ServicePaths;
    execPath?: string;
    isBundled?: boolean;
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
    isTTY?: boolean;
    print?: (line: string) => void;
    warn?: (line: string) => void;
    confirm?: (question: string) => Promise<boolean>;
    exists?: (path: string) => boolean;
    removeDir?: (path: string) => void;
    removeFile?: (path: string) => void;
    /** Live daemon pid, `undefined` when none is running. */
    daemonPid?: (runtime: string) => number | undefined;
    serviceInstalled?: (unitPath: string) => boolean;
    stopDaemon?: (runtime: string) => Promise<void>;
    disableService?: () => Promise<void>;
    removeService?: (unitPath: string) => void;
    channel?: UninstallChannel;
}

function defaultDaemonPid(runtime: string): number | undefined {
    const lock = readDaemonJson(join(runtime, DAEMON_JSON_FILE)) ?? readLockFile(join(runtime, LOCK_FILE));
    if (lock === undefined) return undefined;
    return assessLock(lock, { isPidAlive, bootId: readBootId }).live ? lock.pid : undefined;
}

/** `pi2 stop`, with "there is nothing to stop" treated as success. */
async function defaultStopDaemon(runtime: string): Promise<void> {
    try {
        await runStop({ runtime, print: () => undefined });
    } catch (error) {
        if (error instanceof CliError && error.message.includes("no running pi2 daemon")) return;
        throw error;
    }
}

/** A single `y`/`yes` on stdin; everything else (including EOF) is a no. */
function defaultConfirm(question: string): Promise<boolean> {
    return new Promise((resolve) => {
        process.stdout.write(question);
        const finish = (answer: boolean): void => {
            process.stdin.pause();
            process.stdin.removeListener("data", onData);
            process.stdin.removeListener("end", onEnd);
            resolve(answer);
        };
        const onData = (chunk: Buffer | string): void => finish(/^y(es)?$/i.test(String(chunk).trim()));
        // EOF (Ctrl-D, a closed pipe) is a no, never a hang.
        const onEnd = (): void => finish(false);
        process.stdin.resume();
        process.stdin.once("data", onData);
        process.stdin.once("end", onEnd);
    });
}

/** The commands that finish the job on the channel that owns the binaries. */
export function uninstallNextSteps(
    steps: readonly UninstallStep[],
    channel: UninstallChannel,
): string[] {
    const lines: string[] = [];
    const installRemoved = steps.some((step) => step.target === "install" && step.remove);
    if (!installRemoved) {
        lines.push(`remove the binaries (${channel.installer} channel): ${channelUninstallCommand(channel.installer)}`);
    }
    const kept = steps.filter((step) => !step.remove && step.target !== "service");
    const keptDirs = kept.filter((step) => step.target !== "config").flatMap((step) => step.paths);

    lines.push("clear the console's site data in the browser — it caches the paired device token");
    lines.push('remove the plugin-private daemon copy, if `:PiWebInstall` ran: rm -rf <nvim stdpath("data")>/pi2d');
    if (keptDirs.length > 0) {
        lines.push(`rm -rf ${keptDirs.join(" ")}`);
    }
    return lines;
}

/** Kept service unit → the command that takes it down, platform-specific. */
export function keptServiceHint(platform: ServicePlatform, paths: ServicePaths): string | undefined {
    return renderService(platform, paths).removeCommands[0];
}

/**
 * Remove the daemon's local state.
 *
 * Returns 0 when there was nothing to do or everything succeeded, 1 when the
 * confirmation was declined or any removal failed (each failure is reported on
 * `warn` and does not stop the remaining steps).
 */
export async function runUninstall(options: UninstallOptions = {}): Promise<number> {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const warn = options.warn ?? ((line: string) => process.stderr.write(`pi2: ${line}\n`));
    const exists = options.exists ?? existsSync;
    const removeDir = options.removeDir ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
    const removeFile = options.removeFile ?? ((path: string) => rmSync(path, { force: true }));
    const home = options.homeDir ?? homedir();
    const platform = options.platform ?? (osPlatform() === "darwin" ? "darwin" : "linux");
    const servicePaths = options.servicePaths ?? defaultServicePaths();
    const service = renderService(platform, servicePaths);
    const channel =
        options.channel ??
        detectUninstallChannel(
            options.execPath ?? process.execPath,
            options.isBundled ?? isBundledRuntime(),
        );
    const dryRun = options.dryRun === true;
    const paths = {
        runtime: options.runtime ?? runtimeDir(),
        data: options.data ?? dataDir(),
        state: options.state ?? stateDir(),
        configEnv: options.configEnv ?? configEnvPath(options.env ?? process.env, home),
    };

    const steps = planUninstall({
        ...paths,
        serviceUnit: service.path,
        purge: options.purge === true,
        purgeConfig: options.purgeConfig === true,
        ...(options.keepService === undefined ? {} : { keepService: options.keepService }),
        ...(options.keepInstall === undefined ? {} : { keepInstall: options.keepInstall }),
        serviceInstalled: (options.serviceInstalled ?? exists)(service.path),
        ...(options.daemonPid === undefined
            ? { daemonPid: defaultDaemonPid(paths.runtime) }
            : { daemonPid: options.daemonPid(paths.runtime) }),
        channel,
        exists,
    });

    const installStep = steps.find((step) => step.target === "install");
    if (installStep !== undefined && channel.prefix !== undefined) {
        const link = installerBinSymlink(channel.prefix, home);
        if (link !== undefined) installStep.paths.push(link);
    }

    print(dryRun ? "pi2 uninstall — dry run, nothing will be changed" : "pi2 uninstall");
    for (const step of steps) print(formatUninstallStep(step, dryRun));

    const removable = steps.filter((step) => step.remove);
    if (removable.length === 0) {
        print("nothing to remove: pi2 keeps no state for this user");
        printNextSteps(print, steps, channel, keptServiceHint(platform, servicePaths));
        return 0;
    }

    if (dryRun) {
        printNextSteps(print, steps, channel, keptServiceHint(platform, servicePaths));
        return 0;
    }

    if (options.yes !== true) {
        const isTTY = options.isTTY ?? process.stdin.isTTY === true;
        if (!isTTY && options.confirm === undefined) {
            throw new CliError(
                "refusing to remove anything without confirmation.\n" +
                    "  re-run with --yes (scripts), or --dry-run to inspect the plan first.",
            );
        }
        const confirmed = await (options.confirm ?? defaultConfirm)(`Remove these ${removable.length} item(s)? [y/N] `);
        if (!confirmed) {
            print("aborted — nothing was removed");
            return 1;
        }
    }

    let removed = 0;
    let failures = 0;
    let stopped: number | undefined;
    const stopDaemon = options.stopDaemon ?? defaultStopDaemon;
    const disableService = options.disableService ?? (() => defaultDisableService(platform, servicePaths));
    const removeService = options.removeService ?? ((path: string) => removeFile(path));

    for (const step of removable) {
        if (step.target === "service") {
            try {
                await disableService();
            } catch (error) {
                warn(`could not disable ${service.name}: ${errorMessage(error)}`);
            }
            try {
                removeService(service.path);
                removed += 1;
            } catch (error) {
                failures += 1;
                warn(`could not remove ${service.path}: ${errorMessage(error)}`);
            }
            continue;
        }

        if (step.target === "daemon") {
            try {
                await stopDaemon(paths.runtime);
                stopped = 1;
            } catch (error) {
                failures += 1;
                warn(`could not stop the daemon: ${errorMessage(error)}`);
            }
            continue;
        }

        for (const path of step.paths) {
            try {
                if (step.target === "config") removeFile(path);
                else removeDir(path);
                removed += 1;
            } catch (error) {
                failures += 1;
                warn(`could not remove ${path}: ${errorMessage(error)}`);
            }
        }
    }

    const parts = [`removed ${removed} path(s)`];
    if (stopped !== undefined) parts.push("stopped the daemon");
    if (failures > 0) parts.push(`${failures} failure(s)`);
    print(parts.join(", "));
    printNextSteps(print, steps, channel, keptServiceHint(platform, servicePaths));
    return failures > 0 ? 1 : 0;
}

function printNextSteps(
    print: (line: string) => void,
    steps: readonly UninstallStep[],
    channel: UninstallChannel,
    serviceHint?: string,
): void {
    const lines = uninstallNextSteps(steps, channel);
    const keptService = steps.some((step) => step.target === "service" && !step.remove);
    if (keptService && serviceHint !== undefined) {
        lines.push(`the service unit is still enabled: ${serviceHint}`);
    }
    if (lines.length === 0) return;
    print("");
    print("Next:");
    for (const line of lines) print(`  - ${line}`);
}

/** `pi2 service disable` — a missing manager is a warning, not a failure. */
async function defaultDisableService(platform: ServicePlatform, paths: ServicePaths): Promise<void> {
    await runServiceCommand("disable", { platform, paths, print: () => undefined });
}
