/**
 * `pi2 daemon` — the pi2 web-console daemon entry point.
 *
 * Responsibilities (and nothing else):
 *   1. parse args / apply `--port|--host|--static-dir` to the config env
 *   2. take the singleton lock (`<runtime>/daemon.lock`, stale-aware, `--force`)
 *   3. only once the lock is ours, mint `<runtime>/cli.token` (32-byte hex, 0600)
 *      for local CLI access — a second daemon must never rotate the live token
 *   4. wire the real dependencies and listen (port 0 allowed, +1..+9 on a busy
 *      default port), then publish `<runtime>/daemon.json`
 *   5. print exactly one line: `pi2 daemon listening on http://host:port`
 *   6. on SIGINT/SIGTERM close http + the plugin socket and release the lock —
 *      **without** stopping nvim instances (they reconnect on the next start)
 *
 * This module is not an entry point: `src/cli/pi2.ts` dispatches `pi2 daemon`
 * (optionally `pi2 daemon start`) to `main()`.
 */
import { randomUUID } from "node:crypto";
import { loadConfig, DEFAULT_HOST, DEFAULT_PORT, type Config } from "../config.js";
import { ensureDir, runtimeDir } from "../core/paths.js";
import type { Logger } from "../core/interfaces.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";
import { createLogger } from "./logger.js";
import { acquireLock, writeDaemonJson, type DaemonLockHandle } from "./lock.js";
import { cliTokenPath, writeCliToken } from "./token.js";
import { boolFlag, errorMessage, packageVersion, parseArgs, stringFlag, UsageError } from "./util.js";
import { wireDaemon, type StartedServer, type WiredDaemon } from "./wiring.js";

/** Extra attempts when the *default* port is taken (7676 → 7677 … 7685). */
export const DEFAULT_PORT_RETRIES = 9;

export const USAGE = `pi2 daemon — pi2 daemon

Usage: pi2 daemon [start] [options]

Options:
  --port <n>         TCP port (default ${DEFAULT_PORT}; 0 = ephemeral)
  --host <addr>      bind address (default ${DEFAULT_HOST} (all interfaces))
  --static-dir <p>   built web UI (default <repo>/web/dist)
  --force            override a live daemon.lock
  --foreground       stay in the foreground (default; kept for unit files)
  --version          print the version and exit
  --help             print this help and exit

Environment:
  PI2_PORT, PI2_HOST (${DEFAULT_HOST} (all interfaces)), PI2_STATIC_DIR,
  PI2_ORIGINS, PI2_RUNTIME_DIR, PI2_DATA_DIR, PI2_STATE_DIR,
  PI2_LOG_LEVEL, PI2_WORKSPACE_ROOTS, PI2_PUBLIC_URL
Managed instances:
  PI2_NVIM_BIN=<path>       nvim binary on the daemon's PATH (default nvim)
  PI2_NVIM_INIT=<file>      -u <file>; "user" loads your own config; unset = generated init
  PI2_PLUGIN_DIR=<dir>      pi2.nvim checkout the generated init prepends
  PI2_ENSURE_TIMEOUT_MS=<n> spawn hello timeout in ms (default 10000)

Runtime files ($PI2_RUNTIME_DIR):
  d.sock         plugin unix socket (nvim → daemon)
  d.sock.token   plugin handshake token
  daemon.lock    singleton lock (pid + bootId)
  daemon.json    discovery file for the pi2 CLI / tools
  cli.token      local admin token for the pi2 CLI

See docs/deployment.md.`;

export interface DaemonArgs {
    port?: number;
    host?: string;
    staticDir?: string;
    force: boolean;
    foreground: boolean;
    help: boolean;
    version: boolean;
}

export function parseDaemonArgs(argv: readonly string[]): DaemonArgs {
    const { flags, positionals } = parseArgs(argv, {
        values: ["--port", "--host", "--static-dir"],
        booleans: ["--force", "--foreground", "--help", "--version"],
        aliases: { "-h": "--help", "-V": "--version", "-p": "--port", "-f": "--force" },
    });
    if (positionals.length > 0) {
        throw new UsageError(`unexpected argument ${positionals[0]}`, USAGE);
    }

    const args: DaemonArgs = {
        force: boolFlag(flags, "--force"),
        foreground: boolFlag(flags, "--foreground"),
        help: boolFlag(flags, "--help"),
        version: boolFlag(flags, "--version"),
    };

    const port = stringFlag(flags, "--port");
    if (port !== undefined) {
        if (!/^\d+$/.test(port.trim())) throw new UsageError(`--port must be an integer, got "${port}"`, USAGE);
        const value = Number(port);
        if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
            throw new UsageError(`--port must be between 0 and 65535, got "${port}"`, USAGE);
        }
        args.port = value;
    }
    const host = stringFlag(flags, "--host");
    if (host !== undefined) args.host = host;
    const staticDir = stringFlag(flags, "--static-dir");
    if (staticDir !== undefined) args.staticDir = staticDir;

    return args;
}

export interface CliIo {
    out(line: string): void;
    err(line: string): void;
}

function defaultIo(): CliIo {
    return {
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
    };
}

export function startupLine(host: string, port: number): string {
    return `pi2 daemon listening on http://${host}:${port}`;
}

export interface RunDaemonOptions {
    out?: (line: string) => void;
    err?: (line: string) => void;
    logger?: Logger;
    onStarted?: (handle: { server: StartedServer; wired: WiredDaemon; close: () => Promise<void> }) => void | Promise<void>;
}

/**
 * Start the daemon. Resolves `0` once the server is listening (the process then
 * stays alive) and `1`/`2` on failure — the caller decides whether to exit.
 */
export async function main(argv: readonly string[], ioOptions: RunDaemonOptions = {}): Promise<number> {
    const defaults = defaultIo();
    const io: CliIo = { out: ioOptions.out ?? defaults.out, err: ioOptions.err ?? defaults.err };
    const options = ioOptions;
    let args: DaemonArgs;
    try {
        args = parseDaemonArgs(argv);
    } catch (error) {
        if (error instanceof UsageError) {
            io.err(`pi2: ${error.message}`);
            io.err(error.usage ?? USAGE);
            return 2;
        }
        throw error;
    }

    if (args.help) {
        io.out(USAGE);
        return 0;
    }
    if (args.version) {
        io.out(`pi2 ${packageVersion()}`);
        return 0;
    }

    // The daemon process is the single consumer of these values; child nvim
    // instances then inherit a consistent environment.
    if (args.port !== undefined) process.env.PI2_PORT = String(args.port);
    if (args.host !== undefined) process.env.PI2_HOST = args.host;
    if (args.staticDir !== undefined) process.env.PI2_STATIC_DIR = args.staticDir;

    const portIsDefault = args.port === undefined && (process.env.PI2_PORT ?? "").trim() === "";
    const logger = options.logger ?? createLogger();

    let config: Config;
    try {
        config = loadConfig();
    } catch (error) {
        io.err(`pi2: ${errorMessage(error)}`);
        return 1;
    }

    let lock: DaemonLockHandle | undefined;
    let wired: WiredDaemon | undefined;
    let server: Awaited<ReturnType<WiredDaemon["start"]>> | undefined;
    let stopping = false;

    try {
        const runtime = runtimeDir();
        ensureDir(runtime, 0o700);

        const daemonId = `d-${randomUUID()}`;
        lock = acquireLock({
            force: args.force,
            payload: {
                port: config.port,
                daemonId,
                startedAt: Date.now(),
                protocolVersion: PROTOCOL_VERSION,
                host: config.host,
                publicUrl: config.publicUrl,
            },
        });
        // Rotate the local CLI token only when this process owns the lock:
        // otherwise a rejected second daemon would invalidate the live one.
        writeCliToken(cliTokenPath(runtime));

        wired = await wireDaemon({ config, runtime, logger, daemonId });
        server = await wired.start({
            retries: portIsDefault ? DEFAULT_PORT_RETRIES : 0,
            onRetry: (info) => logger.warn("port busy, trying next", { from: info.from, to: info.to }),
        });

        lock.update({ port: server.port });
        writeDaemonJson(lock.lock);
        // One machine-readable line; every log record goes to stderr.
        io.out(startupLine(config.host, server.port));
    } catch (error) {
        io.err(`pi2: ${errorMessage(error)}`);
        lock?.release();
        if (wired !== undefined) await wired.close().catch(() => undefined);
        return 1;
    }

    const shutdown = async (signal: string): Promise<void> => {
        if (stopping) return;
        stopping = true;
        logger.info("shutting down", { signal });
        try {
            if (server !== undefined) await server.close();
        } catch (error) {
            logger.warn("http close failed", { error: errorMessage(error) });
        }
        try {
            // Only the plugin socket: managed nvim instances must survive a
            // daemon restart and reconnect on the next start (protocol §5).
            await wired?.instanceManager.pluginServer.close();
        } catch (error) {
            logger.warn("plugin socket close failed", { error: errorMessage(error) });
        }
        lock?.release();
        process.exit(0);
    };

    const cleanups: (() => void)[] = [];
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        const handler = (): void => {
            void shutdown(signal).catch((error: unknown) => {
                io.err(`pi2: shutdown failed: ${errorMessage(error)}`);
                process.exit(1);
            });
        };
        process.once(signal, handler);
        cleanups.push(() => process.off(signal, handler));
    }

    if (options.onStarted !== undefined && server !== undefined && wired !== undefined && lock !== undefined) {
        const activeLock = lock;
        const activeServer = server;
        const activeWired = wired;
        await options.onStarted({
            server: activeServer,
            wired: activeWired,
            close: async () => {
                for (const off of cleanups) off();
                try {
                    await activeServer.close();
                } catch {
                    // ignore
                }
                try {
                    await activeWired.close();
                } catch {
                    // ignore
                }
                activeLock.release();
            },
        });
    }

    return 0;
}
