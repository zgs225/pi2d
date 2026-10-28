/** Hono application factory for the daemon HTTP surface. */
import { existsSync, readFileSync } from "node:fs";
import { hostname as osHostname, platform as osPlatform, release as osRelease } from "node:os";
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import type { HttpBindings } from "@hono/node-server";
import type { Bus, InstanceManager, Logger, WorkspaceStore } from "../core/interfaces.js";
import { ERROR_CODES, errorBody } from "../protocol/errors.js";
import { PROTOCOL_VERSION, type CommandRequest } from "../protocol/types.js";
import type { Config } from "../config.js";
import type { SysinfoSampler } from "../core/sysinfo.js";
import { networkBases } from "../core/network.js";
import { encodeQr, fitsQr } from "../core/qr.js";
import type { AuthStore, DevicePublic } from "./auth.js";
import { isAllowedOrigin, LOCAL_CLI_DEVICE_ID } from "./auth.js";
import { DaemonError, toErrorPayload } from "./errors.js";
import { PairRateLimiter } from "./rate-limit.js";
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
    sysinfo?: SysinfoSampler;
    /** Redeem budget; injectable so tests can advance the clock. */
    pairLimiter?: PairRateLimiter;
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

/** Rate-limit key for the public redeem endpoint. */
function clientAddress(c: Context<Env>): string {
    return c.env?.incoming?.socket?.remoteAddress ?? "unknown";
}

/** `http://host:port` without a trailing slash, for `base` validation. */
function normalizeBase(raw: string): string {
    return raw.trim().replace(/\/+$/, "");
}

/** Daemon package version; falls back to the v1 baseline when package.json is unavailable. */
function daemonVersion(): string {
    try {
        const file = fileURLToPath(new URL("../../package.json", import.meta.url));
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" && parsed.version.trim() !== "" ? parsed.version : "0.1.0";
    } catch {
        return "0.1.0";
    }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8", ...headers },
    });
}

interface ReadJsonOptions {
    /** An absent body is `{}` (used by `console/session`, whose body is optional). */
    optional?: boolean;
}

async function readJsonBody(
    c: Context<Env>,
    maxBytes: number,
    options: ReadJsonOptions = {},
): Promise<Record<string, unknown>> {
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
    if (text.trim() === "") {
        if (options.optional === true) return {};
        throw DaemonError.badRequest("request body is required");
    }
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
    const pairLimiter = deps.pairLimiter ?? new PairRateLimiter(undefined, { now });

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
        // Redeeming a code is public by design (the code is the capability) and
        // rate limited below; minting one requires a device token.
        if (path === "/api/v1/pair/redeem") return next();
        const token = bearer(c);
        const device = token ? auth.verifyToken(token) : null;
        if (!device) {
            return json(401, errorBody(ERROR_CODES.UNAUTHORIZED, "missing or invalid device token"));
        }
        auth.touchDevice(device.id);
        await next();
    });

    app.get("/api/v1/info", async (c) => {
        const system = await deps.sysinfo?.sample();
        return c.json({
            v: PROTOCOL_VERSION,
            daemonId: deps.daemonId,
            machineId: deps.machineId ?? deps.daemonId,
            platform: process.platform,
            hostname: osHostname(),
            os: `${osPlatform()} ${osRelease()}`,
            version: daemonVersion(),
            uptimeMs: Math.max(0, now() - startedAt),
            pid: process.pid,
            port: config.port,
            capabilities: ["ws", "sse", "devices", "attention"],
            limits: config.limits,
            host: config.host,
            publicUrl: config.publicUrl,
            cpuCores: system?.cpuCores,
            loadAvg: system?.loadAvg ?? null,
            ...(typeof system?.cpuPercent === "number" ? { cpu: system.cpuPercent } : {}),
            ...(typeof system?.memPercent === "number" ? { mem: system.memPercent } : {}),
            ...(typeof system?.diskPercent === "number" ? { disk: system.diskPercent } : {}),
        });
    });

    /**
     * Local-browser login handshake: loopback + the local CLI token only.
     * The token in the returned URL lives in the fragment (`#t=`), so it never
     * reaches an HTTP request line, a `Referer` header or a proxy access log.
     */
    app.post("/api/v1/console/session", async (c) => {
        // Remote clients pair instead; refuse before touching the device store.
        if (!isLoopback(c)) return json(403, errorBody(ERROR_CODES.FORBIDDEN, "console login is loopback-only"));
        const callerToken = bearer(c);
        const caller = callerToken === undefined ? null : auth.verifyToken(callerToken);
        if (caller === null || caller.id !== LOCAL_CLI_DEVICE_ID) {
            return json(401, errorBody(ERROR_CODES.UNAUTHORIZED, "console login requires the local CLI token"));
        }
        await readJsonBody(c, config.limits.maxBodyBytes, { optional: true });
        const session = auth.localBrowserSession();
        // Always loopback and the *actual* bound port (`config.port` already
        // reflects retries/ephemeral ports), even when the daemon binds 0.0.0.0.
        const url = `http://127.0.0.1:${config.port}/#t=${encodeURIComponent(session.token)}`;
        return c.json({ token: session.token, device: session.device, url });
    });

    const health = (c: Context<Env>) => {
        const instanceStates = instances.list();
        const degraded = instanceStates.filter((instance) => instance.status === "degraded");
        const workspaceList = workspaces.list();
        const present = workspaceList.filter((workspace) => workspace.exists).length;
        const missing = workspaceList.length - present;
        const activeDevices = auth.listDevices().filter((device) => device.revokedAt === null).length;
        const localToken =
            auth.localTokenPath !== undefined && auth.localTokenPath !== "" && existsSync(auth.localTokenPath);
        const items = [
            {
                name: "instances",
                ok: degraded.length === 0,
                detail:
                    degraded.length === 0
                        ? `${instanceStates.length} connected`
                        : `${degraded.length} degraded of ${instanceStates.length}`,
            },
            {
                name: "workspaces",
                // Discovery intentionally keeps ghost entries for old sessions, so a
                // few missing cwds are normal. Healthy means at least one known
                // workspace is still usable (or none are registered yet).
                ok: workspaceList.length === 0 || present > 0,
                detail:
                    missing === 0
                        ? `${workspaceList.length} registered`
                        : `${present} of ${workspaceList.length} present (${missing} missing)`,
            },
            {
                name: "auth",
                ok: activeDevices > 0 || localToken,
                detail: `${activeDevices} devices${localToken ? " + local token" : ""}`,
            },
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
        const sessionFile = c.req.query("sessionFile");
        if (sessionFile) params.sessionFile = sessionFile;
        // `workspaceId` only routes the read (a disk-only row has no live owner);
        // the sid still rides along so the plugin can answer from its registry.
        const ack = await router.relaySessionQuery(
            c.req.param("sid"),
            "workspace.query",
            { ...params, kind: "entries" },
            c.req.query("workspaceId"),
        );
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

    app.get("/api/v1/resources", async (c) => {
        const [snapshot, system] = await Promise.all([instances.resources(), deps.sysinfo?.sample()]);
        return c.json(system === undefined ? snapshot : { ...snapshot, system });
    });

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

    /**
     * Mint a pairing code. Authenticated (a device token or the local CLI token);
     * the response carries everything a renderer needs — the chosen URL, the QR
     * matrix and every base a client may ask for next time (`base`).
     */
    app.post("/api/v1/pair", async (c) => {
        publicDeviceOrThrow(c, auth);
        const body = await readJsonBody(c, config.limits.maxBodyBytes);
        const ttlSec = typeof body.ttlSec === "number" ? body.ttlSec : undefined;
        const pair = auth.pairCreate(ttlSec === undefined ? {} : { ttlSec });

        const bases = networkBases({
            port: config.port,
            bindHost: config.host,
            publicUrl: config.publicUrl,
        });
        const requested = typeof body.base === "string" ? normalizeBase(body.base) : null;
        let base = bases[0]?.url ?? `http://127.0.0.1:${config.port}`;
        if (requested !== null && requested !== "") {
            const match = bases.find((candidate) => normalizeBase(candidate.url) === requested);
            if (!match) {
                throw DaemonError.badRequest(
                    `base must be one of: ${bases.map((candidate) => candidate.url).join(", ")}`,
                );
            }
            base = match.url;
        }

        const url = `${normalizeBase(base)}/pair/${pair.code}`;
        const qr = fitsQr(url) ? encodeQr(url) : null;
        return c.json({
            accepted: true,
            code: pair.code,
            url,
            expiresAt: pair.expiresAt,
            nonce: pair.nonce,
            qr,
            bases,
        });
    });

    /**
     * Redeem a code with no credentials — the code *is* the capability. Rate
     * limited per client and globally so guessing is not worth the bandwidth.
     */
    app.post("/api/v1/pair/redeem", async (c) => {
        const decision = pairLimiter.check(clientAddress(c));
        if (!decision.allowed) {
            const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
            return json(
                429,
                errorBody(ERROR_CODES.RATE_LIMITED, "too many pairing attempts, try again later"),
                { "retry-after": String(retryAfter) },
            );
        }
        const body = await readJsonBody(c, config.limits.maxBodyBytes);
        if (typeof body.kind !== "string") throw DaemonError.badRequest("kind is required");
        const redeemed = auth.pairRedeem({
            code: typeof body.code === "string" ? body.code : "",
            deviceName: typeof body.deviceName === "string" ? body.deviceName : "",
            kind: body.kind as "phone" | "laptop" | "tablet",
        });
        return c.json({ token: redeemed.token, device: redeemed.device });
    });

    /**
     * The scanned link. A redirect rather than an API call: the phone's browser
     * lands on the console with the code already in the query string, and the
     * SPA's zero-input branch redeems it without a form.
     */
    app.get("/pair/:code", (c) => {
        const raw = (c.req.param("code") ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const query = new URLSearchParams();
        if (/^[A-Z0-9]{8}$/.test(raw)) query.set("code", raw);
        const next = c.req.query("next");
        if (next !== undefined && next !== "") query.set("next", next);
        query.set("auto", "1");
        return c.redirect(`/connect?${query.toString()}`, 302);
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
