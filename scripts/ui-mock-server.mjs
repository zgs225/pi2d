#!/usr/bin/env node
/**
 * Zero-dependency mock of the pi2 daemon's browser surface, for the visual
 * harness (`scripts/ui-shots.mjs`).
 *
 * It answers **exactly** the REST + WS contract the web client speaks
 * (`web/src/lib/api.ts`, the feature `queries.ts` files under web/src/features,
 * `web/src/lib/ws.ts`) with the fixtures from `scripts/ui-fixtures.mjs`, and
 * optionally serves the built console (`web/dist`) so a screenshot run needs
 * nothing else.
 *
 *   node scripts/ui-mock-server.mjs                       # API only, port 0
 *   node scripts/ui-mock-server.mjs --static web/dist      # + the built UI
 *   node scripts/ui-mock-server.mjs --pair-only            # every auth → 401
 *
 * It prints `READY <port>` on stdout once listening (the harness waits for
 * that line) and logs nothing else unless `--log` is given.
 *
 * What it deliberately does **not** do: no `pi` spawn, no plugin relay, no
 * session state machine. Mutations are acked and dropped — this is a fixture
 * server, not a daemon (`AGENTS.md` hard rule 2).
 *
 * `--pair-only` is the unpaired branch: every authenticated endpoint answers
 * `401 E_UNAUTHORIZED`, which is what `/workspaces` needs to redirect itself to
 * `/connect`. `POST /api/v1/console/session` is refused too, so the harness can
 * prove that no local sign-in sneaks past the guard.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    MOCK_CLI_TOKEN,
    MOCK_DAEMON_ID,
    MOCK_DEVICE_TOKEN,
    MOCK_PHONE_TOKEN,
    buildFixtures,
} from "./ui-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

/* ------------------------------------------------------------------ */
/* argv                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
    const options = {
        port: 0,
        host: "127.0.0.1",
        staticDir: null,
        pairOnly: false,
        log: false,
        now: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined) throw new Error(`${arg} needs a value`);
            index += 1;
            return value;
        };
        switch (arg) {
            case "--port":
                options.port = Number(next());
                break;
            case "--host":
                options.host = next();
                break;
            case "--static":
                // `--static auto` (or a bare `--static` at the end) means `web/dist`.
                if (argv[index + 1] === undefined || argv[index + 1].startsWith("--")) {
                    options.staticDir = path.join(REPO_ROOT, "web", "dist");
                } else {
                    const value = next();
                    options.staticDir = value === "auto" ? path.join(REPO_ROOT, "web", "dist") : path.resolve(value);
                }
                break;
            case "--pair-only":
                options.pairOnly = true;
                break;
            case "--log":
                options.log = true;
                break;
            case "--now":
                options.now = Number(next());
                break;
            case "--help":
            case "-h":
                process.stdout.write(
                    "usage: ui-mock-server.mjs [--port 0] [--host 127.0.0.1] [--static <web/dist>] [--pair-only] [--log]\n",
                );
                process.exit(0);
                break;
            default:
                process.stderr.write(`ui-mock-server: unknown argument ${arg}\n`);
                process.exit(2);
        }
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
        process.stderr.write("ui-mock-server: --port must be 0..65535\n");
        process.exit(2);
    }
    return options;
}

const OPTIONS = parseArgs(process.argv.slice(2));
const NOW = Number.isFinite(OPTIONS.now) && OPTIONS.now > 0 ? OPTIONS.now : Date.now();
const FIXTURES = buildFixtures(NOW);

/** Tokens this mock accepts as a device bearer (the CLI token only for login). */
const DEVICE_TOKENS = new Set([MOCK_DEVICE_TOKEN, MOCK_PHONE_TOKEN]);
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function log(line) {
    if (OPTIONS.log) process.stderr.write(`ui-mock-server: ${line}\n`);
}

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body, extraHeaders = {}) {
    const payload = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        ...extraHeaders,
    });
    res.end(payload);
}

function sendEmpty(res, status = 204) {
    res.writeHead(status, { "Content-Length": 0, "Cache-Control": "no-store" });
    res.end();
}

/** `{code, message, retryable}` — the shape `web/src/lib/api.ts` parses. */
function sendError(res, status, code, message, details) {
    sendJson(res, status, { code, message, retryable: status >= 500, ...(details ? { details } : {}) });
}

function unauthorized(res, message = "missing or invalid device token") {
    sendError(res, 401, "E_UNAUTHORIZED", message);
}

function notFound(res, message = "not found") {
    sendError(res, 404, "E_NOT_FOUND", message);
}

function bearer(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    return match?.[1]?.trim();
}

function isLoopback(req) {
    const address = req.socket.remoteAddress ?? "";
    return LOOPBACK.has(address);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > 1_048_576) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            if (!raw) return resolve({});
            try {
                const parsed = JSON.parse(raw);
                resolve(parsed && typeof parsed === "object" ? parsed : {});
            } catch {
                reject(new Error("malformed JSON"));
            }
        });
        req.on("error", reject);
    });
}

const DEVICE_PUBLIC = {
    id: "dev-local",
    name: "local browser",
    kind: "laptop",
};

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res, pathname) {
    if (!OPTIONS.staticDir) return notFound(res, `no such API route ${pathname}`);
    const distDir = OPTIONS.staticDir;
    const indexPath = path.join(distDir, "index.html");
    if (!fs.existsSync(indexPath)) {
        return sendError(
            res,
            503,
            "E_INTERNAL",
            `web/dist is missing — run \`pnpm --dir web build\` (looked in ${distDir})`,
        );
    }
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return notFound(res, "malformed path");
    }
    if (decoded.includes("\0")) return notFound(res, "malformed path");
    const relative = decoded.replace(/^\/+/, "");
    const candidate = path.resolve(distDir, relative);
    // No traversal out of the build directory.
    if (candidate !== distDir && !candidate.startsWith(`${distDir}${path.sep}`)) return notFound(res, "not found");

    if (relative !== "" && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        const body = fs.readFileSync(candidate);
        res.writeHead(200, {
            "Content-Type": MIME[path.extname(candidate).toLowerCase()] ?? "application/octet-stream",
            "Content-Length": body.length,
            // Hashed assets are immutable; index.html is not.
            "Cache-Control": relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return undefined;
    }
    // History-mode routes (`/chat/s-main`, `/status`, …) resolve to the SPA.
    const html = fs.readFileSync(indexPath);
    res.writeHead(200, { "Content-Type": MIME[".html"], "Content-Length": html.length, "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : html);
    return undefined;
}

/** Sessions of one workspace, in the shape `/workspaces/:id/sessions` acks. */
function sessionsOf(workspaceId) {
    const rows = FIXTURES.sessions.filter((session) => session.workspaceId === workspaceId);
    return { v: 1, sessions: rows, cursor: { hasMore: false } };
}

function entriesPage(sessionId, url) {
    const limitRaw = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 50;
    const all = FIXTURES.entriesBySession[sessionId] ?? [];
    const beforeId = url.searchParams.get("before");
    const end = beforeId ? Math.max(0, all.findIndex((entry) => entry.id === beforeId)) : all.length;
    const start = Math.max(0, end - limit);
    const page = all.slice(start, end);
    return {
        v: 1,
        entries: page,
        cursor: { before: page[0]?.id ?? null, hasMore: start > 0 },
    };
}

function modelGroups() {
    return { v: 1, providers: FIXTURES.modelProviders };
}

async function handleApi(req, res, url) {
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    /* Public surface (docs/protocol.md §3.1): info/health are loopback-public. */
    if (pathname === "/api/v1/info" && method === "GET") {
        return sendJson(res, 200, { ...FIXTURES.info, port: SERVER_PORT });
    }
    if ((pathname === "/api/v1/health" || pathname === "/health") && method === "GET") {
        return sendJson(res, 200, FIXTURES.health);
    }
    if (pathname === "/api/v1/console/session" && method === "POST") {
        // Loopback + the local CLI token only; `--pair-only` proves no auto sign-in.
        if (!isLoopback(req)) return sendError(res, 403, "E_FORBIDDEN", "console login is loopback-only");
        const caller = bearer(req);
        if (OPTIONS.pairOnly || caller !== MOCK_CLI_TOKEN) {
            return unauthorized(res, "console login requires the local CLI token");
        }
        await readBody(req).catch(() => undefined);
        return sendJson(res, 200, {
            token: MOCK_DEVICE_TOKEN,
            device: DEVICE_PUBLIC,
            url: `http://127.0.0.1:${SERVER_PORT}/#t=${encodeURIComponent(MOCK_DEVICE_TOKEN)}`,
        });
    }
    // Mint: authenticated, returns the code + QR matrix + reachable bases.
    if (pathname === "/api/v1/pair" && method === "POST") {
        await readBody(req).catch(() => ({}));
        if (OPTIONS.pairOnly) return unauthorized(res);
        return sendJson(res, 200, { accepted: true, ...FIXTURES.pairCode });
    }
    // Public redeem: the code *is* the capability, no bearer required. It answers
    // `{token,device}` and stays available under `--pair-only`.
    if (pathname === "/api/v1/pair/redeem" && method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        if (String(body.code ?? "").replace(/[\s-]/g, "").toUpperCase() !== FIXTURES.pairCode.code.replace(/-/g, "")) {
            return unauthorized(res, "pairing code is invalid or expired");
        }
        return sendJson(res, 200, { token: MOCK_DEVICE_TOKEN, device: DEVICE_PUBLIC });
    }

    /* Everything below needs a device token (and is refused in --pair-only). */
    if (OPTIONS.pairOnly) return unauthorized(res);
    const token = bearer(req);
    if (!token || !DEVICE_TOKENS.has(token)) return unauthorized(res);

    if (pathname === "/api/v1/workspaces" && method === "GET") {
        return sendJson(res, 200, FIXTURES.workspaces);
    }
    let match = /^\/api\/v1\/workspaces\/([^/]+)\/sessions$/.exec(pathname);
    if (match && method === "GET") {
        const workspaceId = decodeURIComponent(match[1]);
        if (!FIXTURES.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
            return notFound(res, `unknown workspace ${workspaceId}`);
        }
        return sendJson(res, 200, sessionsOf(workspaceId));
    }
    match = /^\/api\/v1\/sessions\/([^/]+)\/entries$/.exec(pathname);
    if (match && method === "GET") {
        const sessionId = decodeURIComponent(match[1]);
        if (!FIXTURES.sessionById.has(sessionId)) return notFound(res, `unknown session ${sessionId}`);
        return sendJson(res, 200, entriesPage(sessionId, url));
    }
    // Harness extras: the daemon relays `queue`/`tasks` inside `/sessions` and
    // the WS snapshot, never as their own REST routes. These two exist only so
    // an audit can read the fixtures directly; no web code calls them.
    match = /^\/api\/v1\/sessions\/([^/]+)\/(queue|tasks)$/.exec(pathname);
    if (match && method === "GET") {
        const session = FIXTURES.sessionById.get(decodeURIComponent(match[1]));
        if (!session) return notFound(res, "unknown session");
        const key = match[2];
        return sendJson(res, 200, { v: 1, [key]: session[key] ?? [] });
    }
    if (pathname === "/api/v1/attention" && method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId") ?? "";
        if (!FIXTURES.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
            return notFound(res, `unknown workspace ${workspaceId}`);
        }
        return sendJson(res, 200, { v: 1, attention: FIXTURES.attentionByWorkspace(workspaceId) });
    }
    if (pathname === "/api/v1/models" && method === "GET") {
        const workspaceId = url.searchParams.get("workspaceId") ?? "";
        if (!workspaceId) return sendError(res, 400, "E_BAD_REQUEST", "workspaceId is required");
        if (!FIXTURES.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
            return notFound(res, `unknown workspace ${workspaceId}`);
        }
        return sendJson(res, 200, modelGroups());
    }
    if (pathname === "/api/v1/devices" && method === "GET") {
        // Bare array (`auth.listDevices()`), not `{devices:[…]}`.
        return sendJson(res, 200, FIXTURES.devices);
    }
    match = /^\/api\/v1\/devices\/([^/]+)$/.exec(pathname);
    if (match && method === "DELETE") {
        const deviceId = decodeURIComponent(match[1]);
        if (!FIXTURES.devices.some((device) => device.deviceId === deviceId)) {
            return notFound(res, `unknown device ${deviceId}`);
        }
        return sendEmpty(res, 204);
    }
    if (pathname === "/api/v1/resources" && method === "GET") {
        return sendJson(res, 200, FIXTURES.resources);
    }
    if (pathname === "/api/v1/diagnostics" && method === "GET") {
        return sendJson(res, 200, FIXTURES.diagnostics);
    }
    if (pathname === "/api/v1/cmd" && method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        log(`cmd ${String(body.method ?? "?")}`);
        // Commands are acked and dropped: the mock owns no runtime.
        return sendJson(res, 200, { accepted: true, disposition: "mock", method: body.method ?? null });
    }
    return notFound(res, `no such API route ${pathname}`);
}

function handleRequest(req, res) {
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
        res.setHeader("Access-Control-Max-Age", "600");
        return sendEmpty(res, 204);
    }
    let url;
    try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
        return sendError(res, 400, "E_BAD_REQUEST", "malformed URL");
    }
    log(`${req.method} ${url.pathname}${url.search}`);
    const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
    if (isApi) {
        Promise.resolve(handleApi(req, res, url)).catch((error) => {
            sendError(res, 500, "E_INTERNAL", error instanceof Error ? error.message : String(error));
        });
        return undefined;
    }
    if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) return notFound(res, "upgrade required");
    return serveStatic(req, res, url.pathname);
}

/* ------------------------------------------------------------------ */
/* WebSocket (RFC 6455 server side, hand-rolled: no dependencies)      */
/* ------------------------------------------------------------------ */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function encodeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
        header = Buffer.alloc(2);
        header[1] = length;
    } else if (length < 65_536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    return Buffer.concat([header, payload]);
}

class WsPeer {
    constructor(socket) {
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        this.fragmentOpcode = 0;
        this.authenticated = false;
        this.closed = false;
        this.device = null;
    }

    sendJson(record) {
        if (this.closed) return;
        const payload = Buffer.from(JSON.stringify(record), "utf8");
        try {
            this.socket.write(encodeFrame(0x1, payload));
        } catch {
            this.closed = true;
        }
    }

    sendFrame(opcode, payload) {
        if (this.closed) return;
        try {
            this.socket.write(encodeFrame(opcode, payload));
        } catch {
            this.closed = true;
        }
    }

    close(code = 1000, reason = "") {
        if (this.closed) return;
        this.closed = true;
        const reasonBytes = Buffer.from(reason, "utf8");
        const payload = Buffer.alloc(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);
        try {
            this.socket.write(encodeFrame(0x8, payload));
            this.socket.end();
        } catch {
            this.socket.destroy();
        }
    }

    error(code, message) {
        this.sendJson({ v: 1, type: "error", payload: { code, message, retryable: false } });
    }

    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const buffer = this.buffer;
            if (buffer.length < 2) return;
            const fin = (buffer[0] & 0x80) !== 0;
            const opcode = buffer[0] & 0x0f;
            const masked = (buffer[1] & 0x80) !== 0;
            let length = buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) return;
                const big = buffer.readBigUInt64BE(2);
                if (big > BigInt(MAX_FRAME_BYTES)) {
                    this.close(1009, "frame too large");
                    return;
                }
                length = Number(big);
                offset = 10;
            }
            let maskKey = null;
            if (masked) {
                if (buffer.length < offset + 4) return;
                maskKey = buffer.subarray(offset, offset + 4);
                offset += 4;
            }
            if (length > MAX_FRAME_BYTES) {
                this.close(1009, "frame too large");
                return;
            }
            if (buffer.length < offset + length) return;
            let payload = Buffer.from(buffer.subarray(offset, offset + length));
            if (maskKey) {
                for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4];
            }
            this.buffer = buffer.subarray(offset + length);

            if (opcode === 0x8) {
                this.close(1000, "bye");
                return;
            }
            if (opcode === 0x9) {
                this.sendFrame(0xa, payload);
                continue;
            }
            if (opcode === 0xa) continue;
            if (opcode === 0x1 || opcode === 0x2) {
                this.fragmentOpcode = opcode;
                this.fragments = [payload];
            } else if (opcode === 0x0) {
                this.fragments.push(payload);
            } else {
                this.close(1002, "unsupported opcode");
                return;
            }
            if (!fin) continue;
            const message = Buffer.concat(this.fragments);
            this.fragments = [];
            if (this.fragmentOpcode === 0x2) continue; // binary frames are ignored
            this.onText(message.toString("utf8"));
        }
    }

    onText(raw) {
        let frame;
        try {
            frame = JSON.parse(raw);
        } catch {
            this.error("E_BAD_REQUEST", "malformed JSON");
            this.close(4400, "malformed JSON");
            return;
        }
        if (!frame || typeof frame !== "object" || typeof frame.type !== "string") {
            this.error("E_BAD_REQUEST", "missing frame type");
            return;
        }
        if (!this.authenticated) {
            const payload = frame.payload && typeof frame.payload === "object" ? frame.payload : {};
            const token = typeof frame.token === "string" ? frame.token : typeof payload.token === "string" ? payload.token : "";
            if (frame.type !== "auth" || !DEVICE_TOKENS.has(token)) {
                this.error("E_UNAUTHORIZED", "invalid device token");
                this.close(4401, "unauthorized");
                return;
            }
            this.authenticated = true;
            this.device = DEVICE_PUBLIC;
            this.sendJson({
                v: 1,
                type: "hello_ack",
                daemonId: MOCK_DAEMON_ID,
                limits: { maxFrameBytes: MAX_FRAME_BYTES },
                device: DEVICE_PUBLIC,
            });
            return;
        }
        switch (frame.type) {
            case "ping":
                this.sendJson({ v: 1, type: "pong", ts: Date.now() });
                return;
            case "subscribe":
                this.onSubscribe(frame.payload && typeof frame.payload === "object" ? frame.payload : {});
                return;
            case "unsubscribe":
                return;
            case "auth":
                return;
            default:
                this.error("E_BAD_REQUEST", `unknown message type "${frame.type}"`);
        }
    }

    onSubscribe(payload) {
        const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : undefined;
        const ids = new Set(
            (Array.isArray(payload.sessionIds) ? payload.sessionIds : []).filter((id) => typeof id === "string"),
        );
        if (typeof payload.sessionId === "string") ids.add(payload.sessionId);
        if (!ids.size && workspaceId) {
            for (const session of FIXTURES.sessions) {
                if (session.workspaceId === workspaceId) ids.add(session.sessionId);
            }
        }
        if (!ids.size) {
            this.error("E_BAD_REQUEST", "subscribe requires workspaceId or sessionIds");
            return;
        }
        for (const sessionId of ids) {
            const session = FIXTURES.sessionById.get(sessionId);
            if (!session) {
                this.error("E_SESSION_NOT_FOUND", `unknown session ${sessionId}`);
                continue;
            }
            // `payload: {state, entries[]}` — docs/protocol.md §2. The state's own
            // `entries` are Block-shaped (legacy DTO fixtures); the live tail is
            // the raw pi entry stream, so keep them apart.
            this.sendJson({
                v: 1,
                type: "snapshot",
                sessionId,
                epoch: session.instanceId ?? `inst-${session.workspaceId}`,
                seq: 1,
                ts: Date.now(),
                payload: {
                    state: { ...session, entries: [] },
                    entries: FIXTURES.entriesBySession[sessionId] ?? [],
                },
            });
        }
    }
}

function handleUpgrade(req, socket, head) {
    let pathname;
    try {
        pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
        socket.destroy();
        return;
    }
    if (pathname !== "/ws" && pathname !== "/ws/") {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
    }
    if (OPTIONS.pairOnly) {
        // No socket in the unpaired branch: the client must stay on /connect.
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
    }
    const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const peer = new WsPeer(socket);
    socket.setNoDelay(true);
    if (head && head.length) peer.push(head);
    socket.on("data", (chunk) => peer.push(chunk));
    socket.on("error", () => {
        peer.closed = true;
    });
    socket.on("close", () => {
        peer.closed = true;
    });
    log(`ws open (${peer.authenticated ? "authed" : "pending"})`);
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

let SERVER_PORT = 0;

const server = http.createServer(handleRequest);
server.on("upgrade", handleUpgrade);
server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

server.listen(OPTIONS.port, OPTIONS.host, () => {
    const address = server.address();
    SERVER_PORT = typeof address === "object" && address ? address.port : OPTIONS.port;
    if (OPTIONS.staticDir && !fs.existsSync(path.join(OPTIONS.staticDir, "index.html"))) {
        process.stderr.write(
            `ui-mock-server: warning — ${OPTIONS.staticDir}/index.html is missing (run \`pnpm --dir web build\`)\n`,
        );
    }
    process.stdout.write(`READY ${SERVER_PORT}\n`);
});

function shutdown(code = 0) {
    server.close(() => process.exit(code));
    // Sockets (WS upgrades) keep the server open; do not hang the harness.
    setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
