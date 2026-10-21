/**
 * Listening with a bounded port retry.
 *
 * `pi2d` uses the default port 7676; when another process already owns it the
 * daemon walks `+1 … +9` instead of failing to start (the browser UI and the
 * `pi2` CLI both read the actual port from `runtime/daemon.json`, so a bump is
 * invisible to users). An explicitly configured port is never re-mapped: a
 * conflict there is a real error.
 */
import type { Config } from "../config.js";
import { startServer, type ServerDeps, type StartedServer } from "../daemon/server.js";

export interface ListenOptions {
    /** Extra port attempts after the first failure (0 = no retry). */
    retries?: number;
    onRetry?: (info: { from: number; to: number; error: Error }) => void;
}

function errorCode(error: unknown): string | undefined {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return typeof code === "string" ? code : undefined;
}

/** `EADDRINUSE` on either the HTTP server or an earlier await. */
export function isAddressInUse(error: unknown): boolean {
    return errorCode(error) === "EADDRINUSE";
}

/**
 * Rewrite the derived CORS origins when the effective port changes, mirroring
 * what `startServer` does for an ephemeral (`:0`) bind.
 */
export function withPort(config: Config, port: number): Config {
    if (port === config.port) return config;
    return {
        ...config,
        port,
        corsOrigins: config.corsOrigins.map((origin) =>
            origin.endsWith(`:${config.port}`) ? `${origin.slice(0, -String(config.port).length)}${port}` : origin,
        ),
    };
}

export async function listenWithRetry(
    config: Config,
    deps: ServerDeps,
    options: ListenOptions = {},
): Promise<StartedServer> {
    const retries = config.port === 0 ? 0 : Math.max(0, options.retries ?? 0);
    let port = config.port;

    for (let attempt = 0; ; attempt += 1) {
        try {
            return await startServer(withPort(config, port), deps);
        } catch (error) {
            if (!isAddressInUse(error) || attempt >= retries) throw error;
            if (port >= 65535) throw error;
            const next = port + 1;
            options.onRetry?.({ from: port, to: next, error: error instanceof Error ? error : new Error(String(error)) });
            port = next;
        }
    }
}
