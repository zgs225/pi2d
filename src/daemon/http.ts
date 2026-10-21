/** Hono application factory for the daemon HTTP surface. */
import { existsSync } from "node:fs";
import { Hono, type Context } from "hono";
import type { HttpBindings } from "@hono/node-server";
import type { Bus, InstanceManager, Logger, WorkspaceStore } from "../core/interfaces.js";
import { ERROR_CODES, errorBody } from "../protocol/errors.js";
import { PROTOCOL_VERSION, type CommandRequest } from "../protocol/types.js";
import type { Config } from "../config.js";
import type { AuthStore, DevicePublic } from "./auth.js";
import { isAllowedOrigin } from "./auth.js";
import { DaemonError, toErrorPayload } from "./errors.js";
import { CommandRouter } from "./router.js";
import { createSseHandler } from "./sse.js";
import { serveStatic } from "./static.js";

type Env = { Bindings: HttpBindings };

export interface DaemonMetrics {
    connections: number;
    eventsSent?: number;
    eventRate?: number;
    slowQueries?: number;
}

export interface AppDeps {
    config: Config;
    auth: AuthStore;
    instances: InstanceManager;
    workspaces: WorkspaceStore;
    bus: Bus;
    logger?: Logger;
    daemonId: string;
    machineId?: string;
    startedAt?: number;
    now?: () => number;
    metrics?: () => DaemonMetrics;
}

function bearer(c: Context<Env>): string | undefined {
    const header = c.req.header("authorization");
    if (!header) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim();
}

function isLoopback(c: Context<Env>): boolean {
    const address = c.env?.incoming?.socket?.remoteAddress;
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
}

async function readJsonBody(c: Context<Env>, maxBytes: number): Promise<Record<string, unknown>> {
    const declared = c.req.header("content-length");
    if (declared !== undefined) {
        const length = Number(declared);
        if (Number.isFinite(length) && length > maxBytes) {
            throw DaemonError.payloadTooLarge(`body exceeds ${maxBytes} bytes`);
        }
    }
    const text = await c.req.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
        throw DaemonError.payloadTooLarge(`body exceeds ${maxBytes} bytes`);
    }
    if (text.trim() === "") throw DaemonError.badRequest("request body is required");
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw DaemonError.badRequest("malformed JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw DaemonError.badRequest("body must be a JSON object");
    }
    return parsed as Record<string, unknown>;
}

function commandRequest(body: Record<string, unknown>): CommandRequest {
    if (typeof body.method !== "string" || body.method.trim() === "") {
        throw DaemonError.badRequest("method is required");
    }
    if (typeof body.v === "number" && body.v !== PROTOCOL_VERSION) {
        throw new DaemonError(ERROR_CODES.PROTOCOL_VERSION, `unsupported protocol version ${body.v}`);
    }
    const request: CommandRequest = { method: body.method };
    if (body.params !== undefined) {
        if (typeof body.params !== "object" || body.params === null || Array.isArray(body.params)) {
            throw DaemonError.badRequest("params must be an object");
        }
        request.params = body.params as Record<string, unknown>;
    }
    if (typeof body.sessionId === "string") request.sessionId = body.sessionId;
    if (typeof body.clientRequestId === "string") request.clientRequestId = body.clientRequestId;
    return request;
}

function publicDeviceOrThrow(c: Context<Env>, auth: AuthStore): DevicePublic {
    const token = bearer(c);
    const device = token ? auth.verifyToken(token) : null;
    if (!device) throw DaemonError.unauthorized();
    auth.touchDevice(device.id);
    return device;
}

export function createApp(deps: AppDeps): Hono<Env> {
    const { config, auth, instances, workspaces, bus, logger } = deps;
    const now = deps.now ?? Date.now;
    const startedAt = deps.startedAt ?? now();
    const app = new Hono<Env>();
    const router = new CommandRouter({ auth, instances, workspaces, logger, now, daemonId: deps.daemonId });

    // Origin check + CORS. Applies to every surface, including SSE.
    app.use("*", async (c, next) => {
        const origin = c.req.header("origin");
        if (!isAllowedOrigin(origin, config.corsOrigins)) {
            return json(403, errorBody(ERROR_CODES.FORBIDDEN, "origin is not allowed"));
        }
        if (origin) {
            c.header("Access-Control-Allow-Origin", origin);
            c.header("Vary", "Origin");
        }
        if (c.req.method.toUpperCase() === "OPTIONS") {
            c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
            c.header("Access-Control-Allow-Headers", "authorization, content-type");
            c.header("Access-Control-Max-Age", "600");
            return c.body(null, 204);
        }
        await next();
    });

    app.use("/api/*", async (c, next) => {
        const path = new URL(c.req.url).pathname;
        if (path === "/api/v1/info" || path === "/api/v1/health") {
            if (isLoopback(c)) return next();
        }
        // Pairing redeem is public; pair.create enforces auth in its handler.
        if (path === "/api/v1/pair") return next();
        const token = bearer(c);
        const device = token ? auth.verifyToken(token) : null;
        if (!device) {
            return json(401, errorBody(ERROR_CODES.UNAUTHORIZED, "missing or invalid device token"));
        }
        auth.touchDevice(device.id);
        await next();
    });

    app.get("/api/v1/info", (c) =>
        c.json({
            v: PROTOCOL_VERSION,
            daemonId: deps.daemonId,
            machineId: deps.machineId ?? deps.daemonId,
            platform: process.platform,
            capabilities: ["ws", "sse", "devices", "attention"],
            limits: config.limits,
        }),
    );

    const health = (c: Context<Env>) => {
        const items = [
            { name: "instances", ok: true, detail: `${instances.list().length} connected` },
            { name: "workspaces", ok: true, detail: `${workspaces.list().length} registered` },
            { name: "auth", ok: true, detail: `${auth.listDevices().length} devices` },
            { name: "static", ok: existsSync(config.staticDir), detail: config.staticDir },
        ];
        return c.json({ ok: items.every((item) => item.ok), items });
    };
    app.get("/api/v1/health", health);
    app.get("/health", health);

    app.get("/api/v1/workspaces", (c) => c.json(workspaces.list()));

    app.get("/api/v1/workspaces/:id/sessions", async (c) => {
        const workspaceId = c.req.param("id");
        if (!workspaces.get(workspaceId)) throw DaemonError.notFound(`unknown workspace ${workspaceId}`);
        const ack = await router.relayWorkspaceQuery(workspaceId, "sessions");
        return json(200, ack);
    });

    app.get("/api/v1/sessions/:sid/entries", async (c) => {
        const params: Record<string, unknown> = {};
        const before = c.req.query("before");
        if (before !== undefined) params.before = before;
        const limit = Number(c.req.query("limit"));
        if (Number.isFinite(limit) && limit > 0) params.limit = Math.min(500, Math.floor(limit));
        const ack = await router.relaySessionQuery(c.req.param("sid"), "session.entries", params);
        return json(200, ack);
    });

    app.get("/api/v1/attention", async (c) => {
        const workspaceId = c.req.query("workspaceId");
        if (!workspaceId) throw DaemonError.badRequest("workspaceId is required");
        if (!workspaces.get(workspaceId)) throw DaemonError.notFound(`unknown workspace ${workspaceId}`);
        const ack = await router.relayWorkspaceQuery(workspaceId, "attention");
        return json(200, ack);
    });

    app.get("/api/v1/models", async (c) => {
        const workspaceId = c.req.query("workspaceId");
        if (!workspaceId) throw DaemonError.badRequest("workspaceId is required");
        if (!workspaces.get(workspaceId)) throw DaemonError.notFound(`unknown workspace ${workspaceId}`);
        const ack = await router.relayWorkspaceQuery(workspaceId, "models");
        return json(200, ack);
    });

    app.get("/api/v1/devices", (c) => c.json(auth.listDevices()));

    app.delete("/api/v1/devices/:id", (c) => {
        const id = c.req.param("id");
        if (!auth.revokeDevice(id)) throw new DaemonError(ERROR_CODES.NOT_FOUND, `unknown device ${id}`);
        return c.body(null, 204);
    });

    app.get("/api/v1/resources", async (c) => c.json(await instances.resources()));

    app.get("/api/v1/diagnostics", (c) => {
        const metrics = deps.metrics?.() ?? { connections: 0 };
        return c.json({
            v: PROTOCOL_VERSION,
            daemonId: deps.daemonId,
            uptimeMs: now() - startedAt,
            connections: metrics.connections,
            eventsSent: metrics.eventsSent ?? 0,
            eventRate: metrics.eventRate ?? 0,
            slowQueries: metrics.slowQueries ?? 0,
            devices: auth.listDevices().length,
            workspaces: workspaces.list().length,
            instances: instances.list(),
        });
    });

    app.post("/api/v1/cmd", async (c) => {
        if (!bearer(c)) throw DaemonError.unauthorized();
        const body = await readJsonBody(c, config.limits.maxBodyBytes);
        const result = await router.dispatch(commandRequest(body));
        return json(result.status, result.body);
    });

    app.post("/api/v1/pair", async (c) => {
        const body = await readJsonBody(c, config.limits.maxBodyBytes);
        if (typeof body.code === "string") {
            if (typeof body.kind !== "string") throw DaemonError.badRequest("kind is required");
            const redeemed = auth.pairRedeem({
                code: body.code,
                deviceName: typeof body.deviceName === "string" ? body.deviceName : "",
                kind: body.kind as "phone" | "laptop" | "tablet",
            });
            return c.json({ token: redeemed.token, device: redeemed.device });
        }
        publicDeviceOrThrow(c, auth);
        const ttlSec = typeof body.ttlSec === "number" ? body.ttlSec : undefined;
        const pair = auth.pairCreate(ttlSec === undefined ? {} : { ttlSec });
        return c.json({ accepted: true, ...pair });
    });

    app.get("/events", createSseHandler({ auth, bus, corsOrigins: config.corsOrigins, logger }));

    app.all("*", async (c) => {
        const path = new URL(c.req.url).pathname;
        if (path === "/api" || path.startsWith("/api/") || path === "/ws" || path.startsWith("/ws/")) {
            return json(404, errorBody(ERROR_CODES.NOT_FOUND, "not found"));
        }
        if (c.req.method !== "GET" && c.req.method !== "HEAD") {
            return json(405, errorBody(ERROR_CODES.METHOD_NOT_ALLOWED, "method not allowed"));
        }
        return serveStatic(c, config.staticDir);
    });

    app.onError((error, c) => {
        const mapped = toErrorPayload(error);
        return json(mapped.status, mapped.body);
    });

    return app;
}
