/** Node HTTP server wiring: Hono fetch handler + WS upgrade on the same port. */
import { createServer, type Server } from "node:http";
import { getRequestListener, type HttpBindings } from "@hono/node-server";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import type { AppDeps } from "./http.js";
import { createApp } from "./http.js";
import { attachWsServer, type WsServerHandle } from "./ws.js";

export interface WsServerOverrides {
    heartbeatMs?: number;
    authTimeoutMs?: number;
    maxBufferedBytes?: number;
    closeBufferedBytes?: number;
    maxConnections?: number;
    measureBufferedAmount?: (socket: import("ws").WebSocket) => number;
}

export type ServerDeps = Omit<AppDeps, "config" | "metrics"> & {
    heartbeatMs?: number;
    ws?: WsServerOverrides;
};

export interface StartedServer {
    server: Server;
    url: string;
    port: number;
    config: Config;
    ws: WsServerHandle;
    close(): Promise<void>;
}

function hostForUrl(host: string): string {
    if (host === "" || host === "0.0.0.0" || host === "::") return "127.0.0.1";
    return host.includes(":") ? `[${host}]` : host;
}

export async function startServer(config: Config, deps: ServerDeps): Promise<StartedServer> {
    let app: Hono<{ Bindings: HttpBindings }> | undefined;
    const listener = getRequestListener((request, env) => {
        if (!app) return new Response("daemon starting", { status: 503 });
        return app.fetch(request, env as never);
    });
    const server = createServer(listener);

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off("listening", onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off("error", onError);
            resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(config.port, config.host);
    });

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    const effectiveConfig: Config =
        port === config.port
            ? config
            : {
                  ...config,
                  port,
                  corsOrigins: config.corsOrigins.map((origin) =>
                      origin.endsWith(`:${config.port}`) ? `${origin.slice(0, -String(config.port).length)}${port}` : origin,
                  ),
              };

    const wsOverrides = deps.ws ?? {};
    const ws = attachWsServer({
        server,
        config: effectiveConfig,
        auth: deps.auth,
        instances: deps.instances,
        bus: deps.bus,
        logger: deps.logger,
        daemonId: deps.daemonId,
        now: deps.now,
        heartbeatMs: wsOverrides.heartbeatMs ?? deps.heartbeatMs,
        authTimeoutMs: wsOverrides.authTimeoutMs,
        maxBufferedBytes: wsOverrides.maxBufferedBytes,
        closeBufferedBytes: wsOverrides.closeBufferedBytes,
        maxConnections: wsOverrides.maxConnections,
        measureBufferedAmount: wsOverrides.measureBufferedAmount,
    });

    app = createApp({
        config: effectiveConfig,
        auth: deps.auth,
        instances: deps.instances,
        workspaces: deps.workspaces,
        bus: deps.bus,
        logger: deps.logger,
        daemonId: deps.daemonId,
        machineId: deps.machineId,
        startedAt: deps.startedAt,
        now: deps.now,
        metrics: () => ({ connections: ws.connections(), eventsSent: ws.eventsSent() }),
    });

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
        if (closing) return closing;
        closing = (async () => {
            await ws.close();
            const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
            server.closeAllConnections();
            await stopped;
        })();
        return closing;
    };

    return {
        server,
        url: `http://${hostForUrl(config.host)}:${port}`,
        port,
        config: effectiveConfig,
        ws,
        close,
    };
}
