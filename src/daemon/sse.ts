/**
 * SSE fallback (`GET /events`).
 *
 * The browser can pass the device token as `?token=` here only (a browser
 * `EventSource` cannot set headers). Events are filtered by repeated
 * `sessionId` query parameters.
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Bus, Logger } from "../core/interfaces.js";
import { ERROR_CODES, errorBody } from "../protocol/errors.js";
import { isAllowedOrigin, type AuthStore } from "./auth.js";

export interface SseDeps {
    auth: AuthStore;
    bus: Bus;
    corsOrigins: readonly string[];
    logger?: Logger;
    now?: () => number;
    heartbeatMs?: number;
}

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

export function createSseHandler(deps: SseDeps): (c: Context) => Promise<Response> {
    const { auth, bus, corsOrigins, logger, heartbeatMs = 15_000 } = deps;

    return async (c: Context): Promise<Response> => {
        const origin = c.req.header("origin");
        if (!isAllowedOrigin(origin, corsOrigins)) {
            return json(403, errorBody(ERROR_CODES.FORBIDDEN, "origin is not allowed"));
        }

        const queryToken = c.req.query("token");
        const header = c.req.header("authorization");
        const headerToken = header?.replace(/^Bearer\s+/i, "").trim();
        const device = auth.verifyToken(queryToken ?? headerToken ?? "");
        if (!device) return json(401, errorBody(ERROR_CODES.UNAUTHORIZED, "missing or invalid device token"));
        auth.touchDevice(device.id);

        const sessions = new Set(c.req.queries("sessionId") ?? []);
        const workspaceId = c.req.query("workspaceId");

        return streamSSE(
            c,
            async (stream) => {
                const unsubscribe = bus.subscribe((record) => {
                    if (record.type !== "event") return;
                    if (sessions.size > 0 && (typeof record.sessionId !== "string" || !sessions.has(record.sessionId))) return;
                    if (workspaceId && record.workspaceId !== workspaceId) return;
                    void stream
                        .writeSSE({ data: JSON.stringify(record) })
                        .catch((error) =>
                            logger?.debug("sse write failed", {
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        );
                });

                const heartbeat = setInterval(() => {
                    void stream
                        .write(": heartbeat\n\n")
                        .catch(() => undefined);
                }, heartbeatMs);
                heartbeat.unref?.();

                await new Promise<void>((resolve) => {
                    stream.onAbort(() => {
                        clearInterval(heartbeat);
                        unsubscribe();
                        resolve();
                    });
                });
            },
            async (error) => {
                logger?.debug("sse stream failed", { error: error.message });
            },
        );
    };
}
