#!/usr/bin/env node
/**
 * A0–A13 — API/WS end-to-end driver (docs/e2e.md §4.1).
 *
 * Runs against a live daemon + one managed headless nvim per workspace + a real
 * `pi --mode rpc` child. The lifecycle (temp dirs, ephemeral port, pairing,
 * cleanup) is owned by `scripts/e2e/lib.sh`; this script only speaks the wire
 * protocol and asserts on it.
 *
 * Env (all provided by lib.sh):
 *   E2E_BASE, E2E_CLI_TOKEN, E2E_DEVICE_TOKEN, E2E_PAIR_CODE, E2E_PORT,
 *   E2E_ROOT, PI2_WORKSPACE_ROOTS, PI2_STATE_DIR
 *
 * Output:
 *   $E2E_ROOT/report/api-results.json    machine-readable results
 *   $E2E_ROOT/report/summary.md          per-scenario PASS/FAIL/SKIP table
 *   /tmp/pi2-e2e-recon/e2e-api-run.md    recon report (failing assertions + log tails)
 *
 * Exit code: 0 when no non-SKIP scenario failed, 1 otherwise.
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

function mustEnv(name) {
    const value = process.env[name];
    if (typeof value !== "string" || value === "") {
        console.error(`api-e2e: ${name} is required (run through scripts/e2e/run-api.sh)`);
        process.exit(2);
    }
    return value;
}

const BASE = mustEnv("E2E_BASE").replace(/\/+$/, "");
const CLI_TOKEN = mustEnv("E2E_CLI_TOKEN");
const DEVICE_TOKEN = mustEnv("E2E_DEVICE_TOKEN");
const PAIR_CODE = process.env.E2E_PAIR_CODE ?? "";
const E2E_ROOT = mustEnv("E2E_ROOT");
const WORKSPACE_ROOTS = mustEnv("PI2_WORKSPACE_ROOTS");
const STATE_DIR = process.env.PI2_STATE_DIR ?? join(E2E_ROOT, "state");
const WS_URL = `${BASE.replace(/^http/, "ws")}/ws`;
const REPORT_DIR = join(E2E_ROOT, "report");
const RECON_REPORT = process.env.E2E_RECON_REPORT ?? "/tmp/pi2-e2e-recon/e2e-api-run.md";
// Repository root (this driver lives in `<repo>/scripts/e2e/`), so the reports
// can print a reproducible command without hardcoding a checkout path.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const TURN_MS = 120_000;
const ABORT_SETTLE_MS = 10_000;
const INSTANCE_READY_MS = 20_000;
const TOTAL_BUDGET_MS = 20 * 60_000;
const WS_OPEN_MS = 12_000;

const PONG_PROMPT = "Reply with exactly the word PONG and nothing else.";
const SLOW_PROMPT = "Count from 1 to 200, one number per line.";
const W2_PROMPT = "Reply with exactly the word OK and nothing else.";
const SUB_PROMPT = "Reply with exactly the word SUB and nothing else.";
const ATTENTION_FILE = "e2e-attention.txt";
const ATTENTION_REJECT_FILE = "e2e-attention-reject.txt";
// The `[[…]]` markers are understood by scripts/e2e/attention-ext.ts (loaded via
// host-init.lua `cli.args`); the sentence in front is what the model reads. The
// extension turns the marker into one `ctx.ui.select` with the diff payload, so
// the trigger does not depend on the model actually calling the tool.
const ATTENTION_PROMPT = "Call the e2e_request tool once, then reply DONE. [[e2e-attention]]";
const ATTENTION_REJECT_PROMPT = "Call the e2e_request tool once, then reply DONE. [[e2e-attention-reject]]";

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fmt(value, max = 600) {
    let text;
    if (typeof value === "string") text = value;
    else {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value);
        }
    }
    if (text === undefined) return "<undefined>";
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

class TimeoutError extends Error {}

class SkipScenario extends Error {
    constructor(reason) {
        super(reason);
        this.name = "SkipScenario";
        this.reason = reason;
    }
}

function skip(reason) {
    throw new SkipScenario(reason);
}

function withTimeout(promise, timeoutMs, label) {
    let timer;
    const guard = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * @param {"GET"|"POST"|"DELETE"} method
 * @param {string} path
 * @param {{token?: string, body?: unknown, rawBody?: string, timeoutMs?: number}} [opts]
 */
async function http(method, path, opts = {}) {
    const headers = {};
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body;
    if (opts.rawBody !== undefined) {
        headers["content-type"] = "application/json";
        body = opts.rawBody;
    } else if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(opts.body);
    }
    let response;
    try {
        response = await fetch(BASE + path, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
    } catch (error) {
        return { status: 0, ok: false, text: String(error?.message ?? error), json: undefined, error };
    }
    const text = await response.text().catch(() => "");
    let json;
    try {
        json = text === "" ? undefined : JSON.parse(text);
    } catch {
        json = undefined;
    }
    return { status: response.status, ok: response.ok, text, json, contentType: response.headers.get("content-type") ?? "" };
}

/** `POST /api/v1/cmd` with the CLI token by default. */
async function cmd(body, opts = {}) {
    return http("POST", "/api/v1/cmd", { token: opts.token ?? CLI_TOKEN, body, timeoutMs: opts.timeoutMs });
}

function apiError(result) {
    return {
        status: result.status,
        code: result.json?.code ?? null,
        message: result.json?.message ?? null,
        retryable: result.json?.retryable ?? null,
        body: fmt(result.json ?? result.text, 300),
    };
}

// ---------------------------------------------------------------------------
// WS client
// ---------------------------------------------------------------------------

/** @type {Set<WsClient>} */
const OPEN_SOCKETS = new Set();
let socketCounter = 0;

class WsClient {
    /** @param {string} name */
    constructor(name) {
        this.name = name;
        this.ws = null;
        this.frames = [];
        this.waiters = new Set();
        this.closed = false;
        this.device = null;
    }

    /** @param {string} [name] */
    static async open(name = "ws") {
        const client = new WsClient(`${name}#${++socketCounter}`);
        try {
            await client._open();
        } catch (error) {
            await client.close();
            throw error;
        }
        OPEN_SOCKETS.add(client);
        return client;
    }

    async _open() {
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(WS_URL, { handshakeTimeout: WS_OPEN_MS, perMessageDeflate: false });
            this.ws = ws;
            const timer = setTimeout(() => reject(new TimeoutError(`ws connect timeout (${WS_OPEN_MS}ms)`)), WS_OPEN_MS);
            ws.on("open", () => {
                clearTimeout(timer);
                resolve();
            });
            ws.on("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            ws.on("message", (data) => this._onFrame(data));
            ws.on("close", () => {
                this.closed = true;
                this._rejectWaiters(new Error(`ws ${this.name} closed`));
            });
        });
        const from = this.mark();
        this.send({ v: 1, type: "auth", token: DEVICE_TOKEN });
        const ack = await this.waitFor((frame) => frame.type === "hello_ack", { from, timeoutMs: 10_000, label: "hello_ack" });
        this.device = ack.device ?? null;
    }

    get open() {
        return Boolean(this.ws) && this.ws.readyState === WebSocket.OPEN;
    }

    mark() {
        return this.frames.length;
    }

    /** @param {Record<string, unknown>} frame */
    send(frame) {
        if (!this.open) throw new Error(`ws ${this.name}: cannot send, socket is not open`);
        this.ws.send(JSON.stringify(frame));
    }

    /** @param {string|string[]} sessionIds */
    subscribe(sessionIds, extra = {}) {
        const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
        this.send({ v: 1, type: "subscribe", payload: { sessionIds: ids, ...extra } });
    }

    _onFrame(data) {
        let frame;
        try {
            frame = JSON.parse(data.toString());
        } catch {
            return;
        }
        const entry = { ...frame, _at: Date.now(), _index: this.frames.length };
        this.frames.push(entry);
        for (const waiter of [...this.waiters]) {
            if (entry._index < waiter.from) continue;
            let matched = false;
            try {
                matched = Boolean(waiter.pred(entry));
            } catch {
                matched = false;
            }
            if (matched) {
                this.waiters.delete(waiter);
                waiter.resolve(entry);
            }
        }
    }

    _rejectWaiters(error) {
        for (const waiter of [...this.waiters]) {
            this.waiters.delete(waiter);
            waiter.reject(error);
        }
    }

    /**
     * Resolve with the first frame (at index >= `from`) matching `pred`,
     * including frames already buffered.
     * @param {(frame: any) => boolean} pred
     * @param {{from?: number, timeoutMs?: number, label?: string}} [opts]
     */
    waitFor(pred, opts = {}) {
        const from = Math.max(0, opts.from ?? 0);
        for (let i = from; i < this.frames.length; i += 1) {
            if (pred(this.frames[i])) return Promise.resolve(this.frames[i]);
        }
        const timeoutMs = opts.timeoutMs ?? 10_000;
        const label = opts.label ?? "frame";
        return new Promise((resolve, reject) => {
            const waiter = {
                from,
                pred,
                resolve: (frame) => {
                    clearTimeout(timer);
                    resolve(frame);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            };
            const timer = setTimeout(() => {
                this.waiters.delete(waiter);
                reject(new TimeoutError(`ws ${this.name}: ${label} not seen within ${timeoutMs}ms`));
            }, timeoutMs);
            this.waiters.add(waiter);
        });
    }

    /** Frames after `from` (no waiting). */
    since(from) {
        return this.frames.slice(Math.max(0, from));
    }

    async close() {
        OPEN_SOCKETS.delete(this);
        this._rejectWaiters(new Error(`ws ${this.name} closed by client`));
        const ws = this.ws;
        this.ws = null;
        if (!ws) return;
        try {
            ws.removeAllListeners("message");
        } catch {
            /* ignore */
        }
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                try {
                    ws.terminate();
                } catch {
                    /* ignore */
                }
                resolve();
            }, 3_000);
            try {
                ws.once("close", () => {
                    clearTimeout(timer);
                    resolve();
                });
                ws.close(1000, "e2e done");
            } catch {
                clearTimeout(timer);
                resolve();
            }
        });
    }
}

async function closeAllSockets() {
    const clients = [...OPEN_SOCKETS];
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
}

// ---------------------------------------------------------------------------
// frame predicates / projections
// ---------------------------------------------------------------------------

const isEvent = (frame, type) => frame.type === "event" && frame.payload?.event?.type === type;
const eventOf = (frame) => frame.payload?.event ?? {};
const isAssistantDelta = (frame) => {
    if (!isEvent(frame, "message_update")) return false;
    const update = eventOf(frame).assistantMessageEvent ?? {};
    return update.type === "text_delta" && typeof update.delta === "string" && update.delta !== "";
};
/** `text_start` / `text_end` boundary of the assistant's text block. */
const isAssistantTextBoundary = (frame) => {
    if (!isEvent(frame, "message_update")) return false;
    const type = eventOf(frame).assistantMessageEvent?.type;
    return type === "text_start" || type === "text_end";
};

/** The text a `message_update` carries (`text_delta.delta`, `text_end.content`, `partial`). */
function updateText(update) {
    if (typeof update?.delta === "string") return update.delta;
    if (typeof update?.content === "string") return update.content;
    return textOfContent(update?.partial?.content);
}

/**
 * Streaming evidence: an incremental `text_delta`, or a non-empty
 * `text_start`/`text_end` boundary update. A very short answer is delivered by
 * the provider in one chunk; pi then emits `text_start` + `text_end{content}`
 * and no `text_delta`, which is still a streamed assistant message (the reducer
 * renders it from the same `message_update` frames).
 */
const isAssistantStreamEvidence = (frame) =>
    isAssistantDelta(frame) || (isAssistantTextBoundary(frame) && updateText(eventOf(frame).assistantMessageEvent) !== "");

function textOfContent(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
}

/** Raw pi entries (`type: "message"`, `message.role`) → assistant text. */
function assistantTextFromRaw(entries) {
    return (entries ?? [])
        .filter((entry) => entry?.type === "message" && entry?.message?.role === "assistant")
        .map((entry) => textOfContent(entry.message.content))
        .join("\n");
}

function countAssistantMessages(entries) {
    return (entries ?? []).filter((entry) => entry?.type === "message" && entry?.message?.role === "assistant").length;
}

function entryIds(entries) {
    return (entries ?? []).map((entry) => entry?.id).filter((id) => typeof id === "string");
}

const normalizeText = (text) => String(text ?? "").trim().replace(/\s+/g, " ");

/**
 * `role:text` signature of the raw pi session entries, oldest first. Raw entries
 * (`type: "message"`, `message.role`) are what `workspace.query{kind="entries"}`
 * returns; only conversation messages are comparable to the reducer projection.
 */
function historyMessageSignature(entries) {
    return (entries ?? [])
        .filter((entry) => entry?.type === "message" && (entry?.message?.role === "user" || entry?.message?.role === "assistant"))
        .map((entry) => `${entry.message.role}:${normalizeText(textOfContent(entry.message.content))}`);
}

/** `role:text` signature of the projected `SessionState.entries` (protocol §4). */
function snapshotMessageSignature(entries) {
    return (entries ?? [])
        .filter((entry) => entry?.role === "user" || entry?.role === "assistant")
        .map((entry) => {
            const text = (entry.blocks ?? [])
                .filter((block) => block?.type === "text")
                .map((block) => block.text)
                .join("");
            return `${entry.role}:${normalizeText(text)}`;
        });
}

/** The reducer projects entry ids as `m1`, `m2`, … (protocol §4.1 `message_start`). */
const isProjectedEntryId = (id) => typeof id === "string" && /^m\d+$/.test(id);

function sameIdSet(a, b) {
    const left = new Set(a);
    const right = new Set(b);
    if (left.size !== right.size) return false;
    for (const value of left) {
        if (!right.has(value)) return false;
    }
    return true;
}

/** True when `ids` is a contiguous run of `reference`, in `reference`'s order. */
function isOrderedRun(ids, reference) {
    if (!Array.isArray(ids) || ids.length === 0) return true;
    const start = reference.indexOf(ids[0]);
    if (start < 0) return false;
    for (let i = 1; i < ids.length; i += 1) {
        if (reference[start + i] !== ids[i]) return false;
    }
    return true;
}

/** True when `ids` is a (possibly equal) suffix of `reference` in order. */
function isSuffixRun(ids, reference) {
    if (!Array.isArray(ids) || ids.length === 0) return true;
    if (ids.length > reference.length) return false;
    const offset = reference.length - ids.length;
    return ids.every((id, index) => reference[offset + index] === id);
}

/**
 * Entry ids of a pi session JSONL file, in file order, session header excluded
 * (`/usr/lib/pi/docs/session-format.md`). This is the ground truth the history
 * endpoint's pages must be consistent with.
 * @param {string} path
 * @returns {string[]|null}
 */
function readSessionFileIds(path) {
    let text;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return null;
    }
    const ids = [];
    for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!entry || entry.type === "session") continue;
        if (typeof entry.id === "string") ids.push(entry.id);
    }
    return ids;
}

// ---------------------------------------------------------------------------
// check collector
// ---------------------------------------------------------------------------

class Ctx {
    constructor(id, title) {
        this.id = id;
        this.title = title;
        this.checks = [];
        this.notes = [];
        this.evidence = {};
        this.budget = { deadline: Date.now() + 10 * 60_000 };
        this.startedAt = Date.now();
    }

    /**
     * @param {string} name
     * @param {boolean} cond
     * @param {{expected?: unknown, observed?: unknown, severity?: "fail"|"warn"}} [opts]
     */
    check(name, cond, opts = {}) {
        const severity = opts.severity ?? "fail";
        const record = {
            name,
            ok: Boolean(cond),
            severity,
            expected: opts.expected,
            observed: opts.observed,
        };
        this.checks.push(record);
        if (!record.ok) {
            this.notes.push(`${severity === "warn" ? "WARN" : "FAIL"} ${name}: expected ${fmt(record.expected, 200)} · observed ${fmt(record.observed, 200)}`);
        }
        return record.ok;
    }

    /** @param {string} name @param {unknown} actual @param {unknown} expected */
    eq(name, actual, expected, opts = {}) {
        return this.check(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), {
            expected,
            observed: actual,
            ...opts,
        });
    }

    note(text) {
        this.notes.push(text);
    }

    warn(text) {
        this.notes.push(`WARN ${text}`);
    }

    failures() {
        return this.checks.filter((check) => !check.ok && check.severity === "fail");
    }

    warns() {
        return this.checks.filter((check) => !check.ok && check.severity === "warn");
    }
}

// ---------------------------------------------------------------------------
// product deviations seen by the harness (reported, never fixed here)
// ---------------------------------------------------------------------------

/** @type {Map<string, {title: string, detail: string, scenarios: Set<string>}>} */
const DEVIATIONS = new Map();

function deviation(key, title, detail, scenarioId) {
    const existing = DEVIATIONS.get(key);
    if (existing) {
        if (scenarioId) existing.scenarios.add(scenarioId);
        return;
    }
    DEVIATIONS.set(key, { title, detail, scenarios: new Set(scenarioId ? [scenarioId] : []) });
}

// ---------------------------------------------------------------------------
// shared suite state
// ---------------------------------------------------------------------------

const state = {
    w1: null,
    w2: null,
    sid: null, // backend session id of the W1 session
    sidTmp: null, // placeholder id returned by session.create
    sessionFile: null,
    epoch: null,
    lastSeq: 0,
    model: null,
    childId: null,
    routedWithWorkspace: false,
    attentionFile: null,
};

// ---------------------------------------------------------------------------
// REST/cmd helpers
// ---------------------------------------------------------------------------

async function listWorkspaces() {
    const res = await http("GET", "/api/v1/workspaces", { token: CLI_TOKEN });
    return { res, rows: Array.isArray(res.json) ? res.json : [] };
}

async function workspaceRow(workspaceId) {
    const { rows } = await listWorkspaces();
    return rows.find((row) => row.workspaceId === workspaceId) ?? null;
}

const isPlaceholderId = (id) => typeof id === "string" && /^tmp-\d+$/.test(id);

/** `/workspaces/:id/sessions` returns an ack object; tolerate a bare array too. */
async function sessionsList(workspaceId) {
    const res = await http("GET", `/api/v1/workspaces/${workspaceId}/sessions`, { token: CLI_TOKEN });
    const rows = Array.isArray(res.json) ? res.json : Array.isArray(res.json?.sessions) ? res.json.sessions : null;
    return { res, rows: rows ?? [] };
}

async function addWorkspace(name, ctx) {
    const cwd = join(WORKSPACE_ROOTS, name);
    mkdirSync(cwd, { recursive: true });
    const res = await cmd({ method: "workspace.add", params: { cwd, trust: true } });
    const workspaceId = res.json?.workspace?.workspaceId ?? res.json?.workspaceId ?? null;
    if (ctx) {
        ctx.check("workspace.add accepted", res.status === 202 && res.json?.accepted === true, {
            expected: { status: 202, accepted: true },
            observed: apiError(res),
        });
    }
    return { res, workspaceId, cwd };
}

async function ensureInstanceReady(workspaceId, ctx, label = "instance") {
    const started = Date.now();
    const ensure = await cmd({ method: "instance.ensure", params: { workspaceId } });
    if (ctx) {
        ctx.check(`${label}.ensure accepted`, ensure.status === 202, {
            expected: 202,
            observed: apiError(ensure),
        });
    }
    let row = null;
    let lastStatus = "<none>";
    while (Date.now() - started < INSTANCE_READY_MS) {
        row = await workspaceRow(workspaceId);
        lastStatus = row?.instance?.status ?? "<none>";
        if (lastStatus === "ready") break;
        if (lastStatus === "degraded" || lastStatus === "stopped") break;
        await sleep(200);
    }
    const durationMs = Date.now() - started;
    if (ctx) {
        ctx.check(`${label} status becomes ready within ${INSTANCE_READY_MS}ms`, lastStatus === "ready", {
            expected: "ready",
            observed: `${lastStatus} after ${durationMs}ms`,
        });
        ctx.evidence.instanceReadyMs = durationMs;
    }
    return { ensure, row, durationMs, status: lastStatus };
}

/**
 * `session.create` returns a `tmp-N` placeholder in practice: the plugin's id
 * migrates to the backend id a moment later and the daemon is not told. Adopt
 * the real id from the (plugin-served) session list so the rest of the suite can
 * address the session. A missing adoption is reported, never hidden.
 */
async function createSession(workspaceId, ctx, label = "session") {
    const before = new Set((await sessionsList(workspaceId)).rows.map((row) => row.sessionId));
    const created = await cmd({ method: "session.create", params: { workspaceId } });
    const ackId = created.json?.sessionId ?? null;
    if (ctx) {
        ctx.check(`${label}.create accepted`, created.status === 202 && created.json?.accepted === true, {
            expected: { status: 202, accepted: true },
            observed: apiError(created),
        });
    }
    const deadline = Date.now() + 25_000;
    let adopted = null;
    let lastRows = [];
    while (Date.now() < deadline) {
        const { rows } = await sessionsList(workspaceId);
        lastRows = rows;
        const candidates = rows.filter(
            (row) => row.live === true && typeof row.sessionId === "string" && !isPlaceholderId(row.sessionId),
        );
        const fresh = candidates.filter((row) => !before.has(row.sessionId));
        const pick = fresh.length === 1 ? fresh[0] : candidates.length === 1 ? candidates[0] : null;
        if (pick) {
            adopted = pick;
            break;
        }
        await sleep(250);
    }
    const realId = adopted?.sessionId ?? ackId;
    const sessionFile = adopted?.sessionFile ?? null;
    return { created, ackId, realId, sessionFile, adopted, rows: lastRows };
}

/** Command that retries once with `params.workspaceId` when the daemon cannot resolve a migrated session id. */
async function routedCmd({ method, sessionId, params = {}, workspaceId, ctx, label, clientRequestId }) {
    const body = { method, ...(sessionId ? { sessionId } : {}), params, ...(clientRequestId ? { clientRequestId } : {}) };
    let res = await cmd(body);
    if (res.status === 404 && res.json?.code === "E_SESSION_NOT_FOUND" && workspaceId) {
        state.routedWithWorkspace = true;
        deviation(
            "routing-after-id-migration",
            "Daemon loses a session after the plugin migrates its id from `tmp-N` to the backend id",
            "`POST /api/v1/cmd {sessionId}` answers E_SESSION_NOT_FOUND; the harness falls back to `params.workspaceId` (docs/protocol.md §5 routing).",
            ctx?.id,
        );
        if (ctx) {
            ctx.warn(
                `${label ?? method}: E_SESSION_NOT_FOUND with sessionId only; retried with params.workspaceId=${workspaceId}`,
            );
        }
        res = await cmd({
            method,
            ...(sessionId ? { sessionId } : {}),
            params: { ...params, workspaceId },
            ...(clientRequestId ? { clientRequestId } : {}),
        });
        res.retriedWithWorkspace = true;
    }
    return res;
}

/**
 * Subscribe a client to one session, falling back to the `workspaceId` hint when
 * the daemon does not know the (migrated) session id.
 * @returns {Promise<{snapshot: any|null, firstError: any|null, retriedWithWorkspace: boolean}>}
 */
async function subscribeSession(client, sessionId, workspaceId, ctx, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 6_000;
    let retriedWithWorkspace = false;
    let firstError = null;

    let from = client.mark();
    client.subscribe(sessionId, opts.extra ?? {});
    let snapshot = await client
        .waitFor((frame) => frame.type === "snapshot" && frame.sessionId === sessionId, { from, timeoutMs })
        .catch(() => null);
    if (!snapshot) {
        const error = client.since(from).find((frame) => frame.type === "error");
        firstError = error ?? null;
        if (error && workspaceId) {
            state.routedWithWorkspace = true;
            deviation(
                "routing-after-id-migration",
                "Daemon loses a session after the plugin migrates its id from `tmp-N` to the backend id",
                "WS `subscribe {sessionIds}` answers E_SESSION_NOT_FOUND; the harness falls back to the `workspaceId` hint.",
                ctx?.id,
            );
            if (ctx) {
                ctx.warn(
                    `WS subscribe {sessionIds:[${sessionId}]} → ${error.payload?.code ?? "error"}; retried with workspaceId=${workspaceId}`,
                );
            }
            retriedWithWorkspace = true;
            from = client.mark();
            client.subscribe(sessionId, { ...(opts.extra ?? {}), workspaceId });
            snapshot = await client
                .waitFor((frame) => frame.type === "snapshot" && frame.sessionId === sessionId, { from, timeoutMs })
                .catch(() => null);
        }
        if (!snapshot) {
            // The daemon answers a subscription from its cached snapshot and does not
            // forward the fresh one the plugin sends: the first subscribe of a
            // never-cached session yields no snapshot at all. Ask again.
            deviation(
                "snapshot-not-sent-on-subscribe",
                "WS `subscribe` does not deliver a snapshot for a session the daemon has not cached yet",
                "The first subscribe of a fresh session produces no `snapshot` frame; the daemon sends its cached state (one subscription behind) only on a later subscribe.",
                ctx?.id,
            );
            if (ctx) ctx.warn("no snapshot on the first subscribe; re-subscribed once (daemon cache is one subscribe behind)");
            from = client.mark();
            client.subscribe(sessionId, { ...(opts.extra ?? {}), ...(retriedWithWorkspace ? { workspaceId } : {}) });
            snapshot = await client
                .waitFor((frame) => frame.type === "snapshot" && frame.sessionId === sessionId, { from, timeoutMs })
                .catch(() => null);
        }
    }
    return { snapshot, firstError, retriedWithWorkspace };
}

/**
 * A fresh snapshot. The daemon answers a subscribe from its cached state, which
 * lags by one subscribe, so ask twice and take the second answer.
 */
async function snapshotOf(client, sessionId, workspaceId, opts = {}) {
    const rounds = opts.rounds ?? 2;
    const perRoundMs = opts.perRoundMs ?? 2_500;
    let previous = null;
    for (let i = 0; i < rounds; i += 1) {
        const from = client.mark();
        client.subscribe(sessionId, workspaceId ? { workspaceId } : {});
        const frame = await client
            .waitFor((candidate) => candidate.type === "snapshot" && candidate.sessionId === sessionId, {
                from,
                timeoutMs: perRoundMs,
            })
            .catch(() => null);
        if (frame) {
            if (i > 0) return frame;
            previous = frame;
        }
    }
    return previous;
}

async function withObserver(workspaceId, fn) {
    const client = await WsClient.open("observer");
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

async function getSnapshot(sessionId, workspaceId) {
    return withObserver(workspaceId, (client) => snapshotOf(client, sessionId, workspaceId, { rounds: 3 }));
}

async function pollSnapshotState(client, sessionId, workspaceId, predicate, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const frame = await snapshotOf(client, sessionId, workspaceId, { rounds: 2, perRoundMs: 2_000 });
        last = frame;
        const value = frame?.payload?.state;
        if (value && predicate(value)) return { frame, state: value, timedOut: false };
        await sleep(opts.intervalMs ?? 400);
    }
    return { frame: last, state: last?.payload?.state ?? null, timedOut: true };
}

/** Normalise the entries page ack (`cursor` shape, plus the `nextCursor` variant). */
function pageOf(json) {
    const payload = json?.payload ?? {};
    const entries = Array.isArray(json?.entries)
        ? json.entries
        : Array.isArray(payload.entries)
          ? payload.entries
          : null;
    const cursor = json?.cursor ?? payload.cursor ?? null;
    const hasMore = Boolean(cursor?.hasMore ?? json?.hasMore ?? payload.hasMore ?? json?.nextCursor != null);
    const before = cursor?.before ?? json?.nextCursor ?? payload.nextCursor ?? null;
    return { entries, hasMore, before };
}

async function entriesPage(sessionId, workspaceId, opts = {}) {
    const query = new URLSearchParams();
    if (opts.limit) query.set("limit", String(opts.limit));
    if (opts.before) query.set("before", opts.before);
    if (opts.sessionFile) {
        query.set("workspaceId", workspaceId);
        query.set("sessionFile", opts.sessionFile);
    }
    const qs = query.toString();
    const res = await http("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}/entries${qs ? `?${qs}` : ""}`, {
        token: CLI_TOKEN,
    });
    return { res, ...pageOf(res.json), raw: res.json };
}

/** Newest sessionFile known for a live session (the plugin reports it once the backend does). */
async function sessionFileOf(sessionId, workspaceId) {
    const { rows } = await sessionsList(workspaceId);
    const row = rows.find((candidate) => candidate.sessionId === sessionId);
    return row?.sessionFile ?? null;
}

async function waitForIdle(client, sessionId, workspaceId, timeoutMs, ctx) {
    const result = await pollSnapshotState(client, sessionId, workspaceId, (value) => value.status === "idle", {
        timeoutMs,
    });
    if (ctx) {
        ctx.check(`session is idle before the next step`, !result.timedOut, {
            expected: "idle",
            observed: result.state?.status ?? "<no snapshot>",
            severity: "fail",
        });
    }
    return result;
}

// ---------------------------------------------------------------------------
// current scenario plumbing
// ---------------------------------------------------------------------------

/** @type {Ctx|null} */
let CURRENT = null;

const SCENARIOS = [];
function scenario(id, title, fn, opts = {}) {
    SCENARIOS.push({ id, title, fn, timeoutMs: opts.timeoutMs ?? 180_000 });
}

// ---------------------------------------------------------------------------
// A0 — bootstrap & auth
// ---------------------------------------------------------------------------

scenario("A0", "Bootstrap & auth", async (ctx) => {
    const info = await http("GET", "/api/v1/info", { token: CLI_TOKEN });
    ctx.eq("GET /api/v1/info → 200", info.status, 200);
    ctx.eq("info.v === 1", info.json?.v, 1);
    ctx.check("info.daemonId present", typeof info.json?.daemonId === "string" && info.json.daemonId !== "", {
        expected: "non-empty string",
        observed: info.json?.daemonId,
    });
    ctx.check("info.capabilities present", Array.isArray(info.json?.capabilities) && info.json.capabilities.length > 0, {
        expected: "non-empty array",
        observed: info.json?.capabilities,
    });
    ctx.eq("info echoes the ephemeral port", Number(info.json?.port ?? process.env.E2E_PORT), Number(process.env.E2E_PORT), {
        severity: "warn",
    });

    const health = await http("GET", "/api/v1/health", { token: CLI_TOKEN });
    ctx.eq("GET /api/v1/health → 200", health.status, 200);
    ctx.eq("health.ok === true", health.json?.ok, true);
    const healthItems = Array.isArray(health.json?.items) ? health.json.items : [];
    ctx.check("health.items is a non-empty array", healthItems.length > 0, {
        expected: "items[]",
        observed: healthItems.length,
    });
    const staticItem = healthItems.find((item) => item?.name === "static");
    ctx.check("health item `static` is ok (web/dist served)", staticItem?.ok === true, {
        expected: { name: "static", ok: true },
        observed: staticItem ?? "<missing>",
    });

    const root = await http("GET", "/");
    ctx.eq("GET / → 200", root.status, 200);
    ctx.check("GET / serves the app shell", /id=["']root["']/.test(root.text) && root.contentType.includes("text/html"), {
        expected: 'text/html containing id="root"',
        observed: { contentType: root.contentType, head: root.text.slice(0, 120) },
    });

    const unauthenticated = await http("GET", "/api/v1/workspaces");
    ctx.eq("unauthenticated GET /api/v1/workspaces → 401", unauthenticated.status, 401);
    ctx.eq("unauthenticated error code", unauthenticated.json?.code, "E_UNAUTHORIZED");

    const bogus = await http("GET", "/api/v1/workspaces", { token: "bogus-token" });
    ctx.eq("bogus bearer → 401", bogus.status, 401);

    try {
        const mode = statSync(join(E2E_ROOT, "run", "cli.token")).mode & 0o777;
        ctx.eq("cli.token mode is 0600", mode, 0o600);
    } catch (error) {
        ctx.check("cli.token exists", false, { expected: "0600 file", observed: String(error?.message ?? error) });
    }

    const healthShape = health.json ?? {};
    ctx.check("health body is valid JSON", typeof healthShape === "object" && healthShape !== null, {
        expected: "object",
        observed: health.text.slice(0, 120),
    });

    // Pairing: a fresh code, treat it as single-use, then revoke the device.
    const created = await cmd({ method: "pair.create", params: { ttlSec: 600 } });
    ctx.eq("pair.create → 202", created.status, 202);
    const code = created.json?.code;
    ctx.check("pair.create returns an 8-char code", typeof code === "string" && /^[A-Z0-9]{8}$/.test(code), {
        expected: "8 uppercase alphanumerics",
        observed: code,
    });
    if (typeof code !== "string") return;

    const redeemed = await http("POST", "/api/v1/pair", {
        body: { code, kind: "laptop", deviceName: "E2E A0 device" },
    });
    ctx.eq("POST /api/v1/pair (redeem) → 200", redeemed.status, 200);
    const token = redeemed.json?.token;
    ctx.check("redeem returns {token, device}", typeof token === "string" && token.length > 10 && Boolean(redeemed.json?.device?.id), {
        expected: "{token, device.id}",
        observed: { token: typeof token, device: redeemed.json?.device },
    });

    if (typeof token === "string") {
        const authorized = await http("GET", "/api/v1/workspaces", { token });
        ctx.check("redeemed token authorizes the API", authorized.status === 200 && Array.isArray(authorized.json), {
            expected: { status: 200, body: "array" },
            observed: apiError(authorized),
        });
    } else {
        ctx.check("redeemed token authorizes the API", false, { expected: "token", observed: "<no token>" });
    }

    const reuse = await http("POST", "/api/v1/pair", { body: { code, kind: "laptop", deviceName: "dup" } });
    ctx.eq("re-using the pairing code → 401", reuse.status, 401);
    ctx.eq("re-use error code", reuse.json?.code, "E_UNAUTHORIZED");

    if (PAIR_CODE) {
        const consumed = await http("POST", "/api/v1/pair", {
            body: { code: PAIR_CODE, kind: "laptop", deviceName: "reuse of the suite code" },
        });
        ctx.eq("the suite's consumed pairing code → 401", consumed.status, 401);
    }

    const existingRedeem = await http("POST", "/api/v1/pair/redeem", {
        token: CLI_TOKEN,
        body: { code: "AAAAAAAA", kind: "laptop", deviceName: "nope" },
    });
    ctx.check("there is no /api/v1/pair/redeem endpoint", existingRedeem.status === 404, {
        expected: 404,
        observed: existingRedeem.status,
        severity: "warn",
    });

    const deviceId = redeemed.json?.device?.id;
    if (typeof deviceId === "string") {
        const revoked = await http("DELETE", `/api/v1/devices/${encodeURIComponent(deviceId)}`, { token: CLI_TOKEN });
        ctx.check("DELETE /api/v1/devices/:id → 2xx", revoked.status === 204 || revoked.status === 200, {
            expected: 204,
            observed: revoked.status,
        });
        const afterRevoke = await http("GET", "/api/v1/workspaces", { token });
        ctx.eq("revoked device token → 401", afterRevoke.status, 401);
    } else {
        ctx.check("DELETE /api/v1/devices/:id → 2xx", false, { expected: "device id", observed: "<none>" });
    }

    ctx.eq("device token from lib.sh still works", (await http("GET", "/api/v1/workspaces", { token: DEVICE_TOKEN })).status, 200);
});

// ---------------------------------------------------------------------------
// A1 — workspaces
// ---------------------------------------------------------------------------

scenario("A1", "Workspaces", async (ctx) => {
    const { res, workspaceId, cwd } = await addWorkspace("w1", ctx);
    ctx.check("workspaceId is 16 hex chars", typeof workspaceId === "string" && /^[0-9a-f]{16}$/.test(workspaceId), {
        expected: "/^[0-9a-f]{16}$/",
        observed: workspaceId,
    });
    if (!workspaceId) return;
    state.w1 = workspaceId;

    const row = await workspaceRow(workspaceId);
    ctx.eq("first add trusts the workspace", row?.trusted, true);
    ctx.eq("workspace cwd is the requested dir", row?.cwd, cwd);

    const again = await cmd({ method: "workspace.add", params: { cwd, trust: true } });
    ctx.eq("re-adding the same cwd → 202", again.status, 202);
    ctx.eq(
        "re-adding the same cwd is idempotent (same id)",
        again.json?.workspace?.workspaceId ?? again.json?.workspaceId,
        workspaceId,
    );

    const outside = `/tmp/pi2-e2e-outside-${process.pid}`;
    mkdirSync(outside, { recursive: true });
    const rejected = await cmd({ method: "workspace.add", params: { cwd: outside, trust: true } });
    ctx.check("cwd outside PI2_WORKSPACE_ROOTS → 4xx", rejected.status >= 400 && rejected.status < 500, {
        expected: "4xx (E_FORBIDDEN)",
        observed: apiError(rejected),
    });
    const { rows } = await listWorkspaces();
    ctx.check("rejected workspace was not created", !rows.some((candidate) => candidate.cwd === outside), {
        expected: "no row for " + outside,
        observed: rows.map((candidate) => candidate.cwd),
    });
    ctx.check("untrusted/forbidden add reports a stable code", typeof rejected.json?.code === "string", {
        expected: "E_FORBIDDEN",
        observed: rejected.json?.code,
    });

    const shape = await listWorkspaces();
    const w1 = shape.rows.find((candidate) => candidate.workspaceId === workspaceId);
    const missing = [];
    if (!w1) missing.push("<row>");
    else {
        for (const field of ["workspaceId", "cwd", "name", "sessionCount", "liveCount", "instance"]) {
            if (!(field in w1)) missing.push(field);
        }
    }
    ctx.check("GET /workspaces row exposes workspaceId,cwd,name,sessionCount,liveCount,instance", missing.length === 0, {
        expected: "all fields present",
        observed: { missing, row: w1 },
    });
    ctx.check("sessionCount/liveCount are numbers", typeof w1?.sessionCount === "number" && typeof w1?.liveCount === "number", {
        expected: "numbers",
        observed: { sessionCount: w1?.sessionCount, liveCount: w1?.liveCount },
    });
});

// ---------------------------------------------------------------------------
// A2 — instance lifecycle
// ---------------------------------------------------------------------------

scenario("A2", "Instance lifecycle", async (ctx) => {
    if (!state.w1) skip("A1 did not produce a workspace id");
    const { row, status, durationMs } = await ensureInstanceReady(state.w1, ctx);
    ctx.check("instance.status === ready", status === "ready", {
        expected: "ready",
        observed: `${status} (${durationMs}ms)`,
    });
    ctx.check("instance reports an instanceId", typeof row?.instance?.instanceId === "string", {
        expected: "instanceId",
        observed: row?.instance,
    });
    const firstId = row?.instance?.instanceId ?? null;

    const again = await cmd({ method: "instance.ensure", params: { workspaceId: state.w1 } });
    ctx.eq("instance.ensure is idempotent (202)", again.status, 202);
    ctx.eq(
        "instance.ensure keeps the same instance",
        again.json?.instance?.instanceId ?? null,
        firstId,
    );

    const sessions = await http("GET", `/api/v1/workspaces/${state.w1}/sessions`, { token: CLI_TOKEN });
    ctx.eq("GET /workspaces/:id/sessions → 200", sessions.status, 200);
    ctx.check("sessions relay is an object, not an array", !Array.isArray(sessions.json) && typeof sessions.json === "object", {
        expected: "object",
        observed: Array.isArray(sessions.json) ? "array" : typeof sessions.json,
    });
    ctx.check("sessions relay carries a sessions[]", Array.isArray(sessions.json?.sessions), {
        expected: "sessions[]",
        observed: sessions.json,
    });
    ctx.check("sessions relay is an ack (accepted/disposition/seq)", Boolean(sessions.json?.disposition || sessions.json?.accepted || sessions.json?.seq !== undefined), {
        expected: "ack fields",
        observed: Object.keys(sessions.json ?? {}),
        severity: "warn",
    });
});

// ---------------------------------------------------------------------------
// A3 — session create + snapshot
// ---------------------------------------------------------------------------

scenario("A3", "Session create + snapshot", async (ctx) => {
    if (!state.w1) skip("A1 did not produce a workspace id");
    const created = await createSession(state.w1, ctx);
    state.sid = created.realId;
    state.sidTmp = created.ackId;
    state.sessionFile = created.sessionFile;
    ctx.evidence.createAck = created.created.json;

    ctx.check(
        "session.create returns a non-placeholder sessionId",
        typeof created.ackId === "string" && created.ackId !== "" && !isPlaceholderId(created.ackId),
        {
            expected: "backend session id",
            observed: `${created.ackId} (adopted from the session list: ${created.realId})`,
        },
    );
    if (isPlaceholderId(created.ackId)) {
        deviation(
            "placeholder-session-id",
            "`session.create` acks with the plugin placeholder id (`tmp-N`) that later migrates",
            `Ack returned sessionId=${created.ackId}; the backend id became ${created.realId} after ~2s (docs/e2e.md A3 requires a non-placeholder id).`,
        );
        ctx.note(`placeholder id ${created.ackId} migrated to ${created.realId}`);
    }
    ctx.check("the session.create ack is settled (no `pending` placeholder flag)", created.created.json?.pending !== true, {
        expected: "acked with the settled backend id",
        observed: fmt(created.created.json, 200),
    });
    ctx.check("the created session is adopted from the session list", Boolean(created.adopted), {
        expected: "live row with the backend id",
        observed: created.rows.map((row) => `${row.sessionId}:${row.live}`),
    });
    if (!created.adopted) {
        ctx.note("no live row with a backend id appeared within 25s; continuing with the ack id");
    }
    // The plugin now waits for the backend id before acking (`ack_session` /
    // `await_backend_id` in pi2.nvim-web/lua/pi/web/commands.lua), so the ack id
    // must be the same id the session list and every later snapshot carry.
    ctx.eq("the create ack id is the id the session list reports as live", created.ackId, created.adopted?.sessionId ?? null);

    const { rows } = await sessionsList(state.w1);
    const liveRow = rows.find((row) => row.sessionId === state.sid);
    ctx.eq("the new session is listed as live", liveRow?.live, true);
    ctx.check("the session list row carries a cwd", typeof liveRow?.cwd === "string", {
        expected: "string",
        observed: liveRow?.cwd,
    });

    const client = await WsClient.open("a3");
    try {
        ctx.check("WS auth returned hello_ack with a device", Boolean(client.device?.id), {
            expected: "device",
            observed: client.device,
        });

        const { snapshot, firstError, retriedWithWorkspace } = await subscribeSession(
            client,
            state.sid,
            state.w1,
            ctx,
            { timeoutMs: 8_000 },
        );
        ctx.check("subscribe → snapshot", Boolean(snapshot), {
            expected: "snapshot frame",
            observed: firstError ? `error ${fmt(firstError.payload, 200)}` : "no frame",
        });
        if (retriedWithWorkspace) ctx.note("subscribe needed the workspaceId hint (see deviation routing-after-id-migration)");
        if (!snapshot) return;

        state.epoch = snapshot.epoch;
        state.lastSeq = snapshot.seq;
        ctx.eq("snapshot.sessionId matches the create ack", snapshot.sessionId, created.ackId);
        ctx.check("snapshot.epoch present", typeof snapshot.epoch === "string" && snapshot.epoch !== "", {
            expected: "string",
            observed: snapshot.epoch,
        });
        ctx.check("snapshot.seq is a number", typeof snapshot.seq === "number", {
            expected: "number",
            observed: snapshot.seq,
        });
        const sessionState = snapshot.payload?.state;
        ctx.check("snapshot.payload.state present", Boolean(sessionState), {
            expected: "{state}",
            observed: snapshot.payload,
        });
        if (!sessionState) return;
        ctx.eq("state.sessionId matches the subscription", sessionState.sessionId, state.sid);
        ctx.eq("state.workspaceId matches the workspace", sessionState.workspaceId, state.w1);
        ctx.check("state.status is a known status", ["starting", "busy", "compacting", "idle", "exited", "interrupted"].includes(sessionState.status), {
            expected: "SessionStatus",
            observed: sessionState.status,
        });
        ctx.check("state.entries is an array", Array.isArray(sessionState.entries), {
            expected: "array",
            observed: typeof sessionState.entries,
        });
        const required = [
            "sessionId",
            "workspaceId",
            "cwd",
            "status",
            "model",
            "thinking",
            "usage",
            "contextUsage",
            "queue",
            "todos",
            "tasks",
            "batches",
            "subagents",
            "attention",
            "entries",
        ];
        const missing = required.filter((field) => !(field in sessionState));
        ctx.check("session state exposes the full SessionState shape", missing.length === 0, {
            expected: "all SessionState fields",
            observed: { missing, present: Object.keys(sessionState) },
        });

        // Snapshot entries: the reducer projects them with synthetic ids
        // (`m1`, `m2`, … — protocol §4.1 `message_start`), which is a DIFFERENT
        // id space than the raw pi ids `workspace.query{kind="entries"}`
        // returns. The cross-check between the two lives in A4 (content), not
        // here.
        const stateEntryIds = entryIds(sessionState.entries ?? []);
        ctx.eq("state.entries has no duplicate ids", stateEntryIds.length, new Set(stateEntryIds).size);
        ctx.check("state.entries uses the documented reducer projection (m<N>)", stateEntryIds.every(isProjectedEntryId), {
            expected: "m<N> ids (protocol §4.1 message_start)",
            observed: fmt(stateEntryIds.slice(-6), 200),
        });
        const snapshotTail = Array.isArray(snapshot.payload?.entries) ? snapshot.payload.entries : null;
        ctx.check("the snapshot payload carries an `entries` tail (protocol §2)", snapshotTail !== null, {
            expected: "{state, entries}",
            observed: Object.keys(snapshot.payload ?? {}),
            severity: "warn",
        });
        if (snapshotTail === null) {
            deviation(
                "snapshot-entries-dropped",
                "The daemon drops a snapshot's `entries` tail and forwards only `payload.state`",
                "pi2.nvim's bridge sends payload {state, entries} and docs/protocol.md §2 documents `snapshot` as state + a tail of entries, but src/daemon/ws.ts sendSnapshot and src/instances/connection.ts handleSnapshot build the frame from payload.state only.",
                ctx.id,
            );
        } else {
            ctx.check("the snapshot tail is a suffix of state.entries", isSuffixRun(entryIds(snapshotTail), stateEntryIds), {
                expected: "suffix of state.entries",
                observed: fmt(entryIds(snapshotTail).slice(-6), 200),
            });
        }
        ctx.evidence.snapshotStatus = sessionState.status;
        ctx.evidence.snapshotEntries = stateEntryIds.length;
        ctx.evidence.snapshotTail = snapshotTail === null ? null : entryIds(snapshotTail).length;
    } finally {
        await client.close();
    }
});

// ---------------------------------------------------------------------------
// A4 — prompt + streaming (real model)
// ---------------------------------------------------------------------------

scenario("A4", "Prompt + streaming (real model)", async (ctx) => {
    if (!state.sid || !state.w1) skip("A3 did not produce a session");
    const fileBefore = await sessionFileOf(state.sid, state.w1);
    const beforePage = fileBefore
        ? await entriesPage(state.sid, state.w1, { limit: 50, sessionFile: fileBefore })
        : { entries: [] };
    const assistantBefore = countAssistantMessages(beforePage.entries ?? []);

    const client = await WsClient.open("a4");
    try {
        const { snapshot } = await subscribeSession(client, state.sid, state.w1, ctx, { timeoutMs: 8_000 });
        if (snapshot?.seq) state.lastSeq = Math.max(state.lastSeq, snapshot.seq);
        if (!snapshot) {
            ctx.check("subscribed for streaming", false, { expected: "snapshot", observed: "none" });
            return;
        }
        const from = client.mark();
        const send = await routedCmd({
            method: "prompt.send",
            sessionId: state.sid,
            params: { text: PONG_PROMPT },
            workspaceId: state.w1,
            ctx,
            label: "prompt.send",
        });
        ctx.check("prompt.send → 202 accepted", send.status === 202 && send.json?.accepted === true, {
            expected: { status: 202, accepted: true },
            observed: apiError(send),
        });
        if (send.status !== 202) return;

        let settled;
        try {
            settled = await client.waitFor((frame) => isEvent(frame, "agent_settled"), { from, timeoutMs: TURN_MS, label: "agent_settled" });
        } catch (error) {
            ctx.check("the turn settles within 120s", false, { expected: "agent_settled", observed: String(error.message) });
            return;
        }
        // The plugin coalesces `text_delta` frames on a 50 ms timer
        // (`pi.web.bridge`), so on a fast local turn the flushed delta can land
        // right after `agent_settled`. Give the transport a beat before
        // snapshotting the frames; the relative order is asserted below.
        await sleep(400);
        const frames = client.since(from);
        const events = frames.filter((frame) => frame.type === "event").map(eventOf);

        ctx.check("agent_start observed (status busy)", events.some((event) => event.type === "agent_start"), {
            expected: "agent_start",
            observed: events.map((event) => event.type).slice(0, 20),
        });
        const userStart = events.find((event) => event.type === "message_start" && event.message?.role === "user");
        ctx.check("the user entry arrives as an event (not invented locally)", Boolean(userStart), {
            expected: "message_start{role:user}",
            observed: "missing",
        });
        const assistantStart = events.find((event) => event.type === "message_start" && event.message?.role === "assistant");
        ctx.check("assistant message_start observed", Boolean(assistantStart), {
            expected: "message_start{role:assistant}",
            observed: "missing",
        });
        const deltas = frames.filter(isAssistantDelta);
        const boundaries = frames.filter(isAssistantTextBoundary);
        const streamEvidence = frames.filter(isAssistantStreamEvidence);
        ctx.check("assistant text streams over WS (text_delta or a non-empty text_start/text_end)", streamEvidence.length > 0, {
            expected: ">=1 text_delta | text_start/text_end carrying text",
            observed: {
                deltas: deltas.length,
                boundaries: boundaries.length,
                boundariesWithText: boundaries.filter((frame) => updateText(eventOf(frame).assistantMessageEvent) !== "").length,
            },
        });
        if (deltas.length === 0) {
            ctx.warn(
                "no literal `text_delta` frame was observed: the provider answered in one chunk, so the stream is `text_start` + `text_end{content}` only " +
                    (streamEvidence.length > 0 ? "(accepted as streaming evidence)" : "(and no boundary update carried text)"),
            );
        }
        const lateDeltas = deltas.filter((frame) => settled && frame._index > settled._index);
        if (lateDeltas.length > 0) {
            ctx.warn(
                `${lateDeltas.length} coalesced text_delta frame(s) arrived after agent_settled (the 50 ms flush timer outlives the turn)`,
            );
            deviation(
                "delta-flush-after-settle",
                "Coalesced `text_delta` frames can be written after `agent_settled`",
                `The bridge assigns the seq at flush time, so the wire order stays monotonic, but a reducer that applies frames in arrival order sees text deltas after the turn settled (post-\`message_end\` text can be duplicated in the rendered entry). ${lateDeltas.length} delta frame(s) landed after the settle in this turn.`,
                ctx.id,
            );
        }
        const assistantEnd = events.find((event) => event.type === "message_end" && event.message?.role === "assistant");
        ctx.check("assistant message_end observed", Boolean(assistantEnd), {
            expected: "message_end{role:assistant}",
            observed: events.filter((event) => event.type === "message_end").length + " message_end frames",
        });
        ctx.eq("agent_settled reports aborted=false", eventOf(settled).aborted, false);

        // Final text: authoritative message_end content, else the fresh snapshot.
        let finalText = assistantEnd ? textOfContent(assistantEnd.message?.content) : "";
        const snapAfter = await snapshotOf(client, state.sid, state.w1, { rounds: 3 });
        const afterState = snapAfter?.payload?.state ?? null;
        if (!finalText && afterState) {
            const lastAssistant = [...(afterState.entries ?? [])].reverse().find((entry) => entry.role === "assistant");
            finalText = (lastAssistant?.blocks ?? [])
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("");
        }
        ctx.check("final assistant text is exactly `pong`", finalText.trim().toLowerCase() === "pong", {
            expected: "pong",
            observed: JSON.stringify(finalText),
        });
        ctx.eq("status returns to idle after the turn", afterState?.status, "idle");

        // Entry accounting comes from the plugin-served history (authoritative).
        const file = (await sessionFileOf(state.sid, state.w1)) ?? fileBefore;
        state.sessionFile = file;
        const afterPage = file ? await entriesPage(state.sid, state.w1, { limit: 50, sessionFile: file }) : { entries: null };
        ctx.check("entries endpoint returns an array after the turn", Array.isArray(afterPage.entries), {
            expected: "array",
            observed: afterPage.res.status + " " + fmt(afterPage.raw, 200),
        });
        const afterEntries = afterPage.entries ?? [];
        ctx.eq(
            "exactly one assistant entry for the turn",
            countAssistantMessages(afterEntries) - assistantBefore,
            1,
        );
        const rawIds = entryIds(afterEntries);
        ctx.eq("no duplicate entry ids (history)", rawIds.length, new Set(rawIds).size);

        const snapshotEntries = afterState?.entries ?? [];
        const snapshotIds = entryIds(snapshotEntries);
        ctx.eq("no duplicate entry ids (snapshot)", snapshotIds.length, new Set(snapshotIds).size);

        // The two endpoints intentionally use DIFFERENT id spaces: history is the
        // raw pi session file (real entry ids, `pi.web.history`), while the
        // snapshot is the plugin's reducer projection, whose ids are `m1`, `m2`, …
        // (docs/protocol.md §4.1 `message_start`). Assert that contract instead of
        // guessing that the ids line up, and prove the two describe the same
        // transcript through the message sequence (below).
        ctx.check(
            "snapshot entry ids use the reducer projection (m<N>)",
            snapshotIds.length > 0 && snapshotIds.every(isProjectedEntryId),
            {
                expected: "m<N> ids (protocol §4.1 message_start)",
                observed: fmt(snapshotIds.slice(-6), 200),
            },
        );
        ctx.check(
            "history and snapshot ids are distinct id spaces",
            snapshotIds.every((id) => !rawIds.includes(id)),
            {
                expected: "disjoint id sets (raw pi ids vs projection ids)",
                observed: { history: fmt(rawIds.slice(-3), 120), snapshot: fmt(snapshotIds.slice(-3), 120) },
            },
        );
        const historyMessages = historyMessageSignature(afterEntries);
        const snapshotMessages = snapshotMessageSignature(snapshotEntries);
        const shared = Math.min(historyMessages.length, snapshotMessages.length);
        ctx.check(
            "the snapshot transcript tail matches the history message sequence",
            shared > 0 &&
                JSON.stringify(historyMessages.slice(-shared)) === JSON.stringify(snapshotMessages.slice(-shared)),
            {
                expected: fmt(historyMessages.slice(-shared), 300),
                observed: fmt(snapshotMessages.slice(-shared), 300),
            },
        );
        if (shared > 0 && JSON.stringify(historyMessages.slice(-shared)) !== JSON.stringify(snapshotMessages.slice(-shared))) {
            deviation(
                "snapshot-transcript-drift",
                "The snapshot projection and the raw history disagree on the transcript tail",
                `history tail ${fmt(historyMessages.slice(-shared), 200)} vs snapshot tail ${fmt(snapshotMessages.slice(-shared), 200)}.`,
                ctx.id,
            );
        }

        ctx.check("usage totals were accumulated", (afterState?.usage?.output ?? 0) > 0 || (afterState?.usage?.input ?? 0) > 0, {
            expected: "usage.input/output > 0",
            observed: afterState?.usage,
        });
        ctx.check("contextUsage was populated", Boolean(afterState?.contextUsage), {
            expected: "non-null contextUsage",
            observed: afterState?.contextUsage,
            severity: "warn",
        });

        // seq: same epoch everywhere, no duplicate seq, no maximum regression.
        const seqFrames = frames.filter((frame) => typeof frame.seq === "number");
        const epochs = new Set(seqFrames.map((frame) => frame.epoch));
        ctx.check("all frames share one epoch", epochs.size === 1, {
            expected: 1,
            observed: [...epochs],
        });
        const seqValues = seqFrames.map((frame) => frame.seq);
        ctx.eq("no duplicate seq values", seqValues.length, new Set(seqValues).size);
        let max = -Infinity;
        const regressions = [];
        for (const value of seqValues) {
            if (value < max) regressions.push({ max, value });
            max = Math.max(max, value);
        }
        ctx.eq("seq never regresses (monotonic maximum)", regressions.length, 0);
        const outOfOrder = [];
        for (let i = 1; i < seqFrames.length; i += 1) {
            if (seqFrames[i].seq < seqFrames[i - 1].seq) {
                outOfOrder.push(`${seqFrames[i - 1].seq}→${seqFrames[i].seq} (${eventOf(seqFrames[i - 1]).type} → ${eventOf(seqFrames[i]).type})`);
            }
        }
        if (outOfOrder.length) {
            ctx.warn(`seq is not strictly increasing on the wire (throttled deltas): ${outOfOrder.slice(0, 3).join(", ")}`);
            deviation(
                "seq-out-of-order-on-wire",
                "Throttled `text_delta` frames arrive after later, unthrottled events (seq order broken)",
                `Observed ${outOfOrder.slice(0, 3).join("; ")} — a reducer that applies frames in arrival order can duplicate or drop text (text_end then text_delta).`,
                ctx.id,
            );
        }
        ctx.evidence.turn = {
            deltas: deltas.length,
            frames: frames.length,
            finalText: finalText.trim(),
            usage: afterState?.usage,
            assistantMessages: countAssistantMessages(afterEntries),
            // Every `message_update` subtype that reached the browser, with the
            // delta length, so a missing/empty stream is diagnosable from the
            // report instead of guessed.
            updates: frames
                .filter((frame) => isEvent(frame, "message_update"))
                .map((frame) => {
                    const update = eventOf(frame).assistantMessageEvent ?? {};
                    return {
                        type: update.type ?? null,
                        delta: typeof update.delta === "string" ? update.delta.length : null,
                        content: typeof update.content === "string" ? update.content.length : null,
                        contentIndex: update.contentIndex ?? null,
                    };
                }),
            dropped: frames.filter((frame) => frame.type === "dropped").length,
        };
    } finally {
        await client.close();
    }
});

// ---------------------------------------------------------------------------
// A5 — abort
// ---------------------------------------------------------------------------

scenario("A5", "Abort", async (ctx) => {
    if (!state.sid || !state.w1) skip("A3 did not produce a session");
    const client = await WsClient.open("a5");
    try {
        const { snapshot } = await subscribeSession(client, state.sid, state.w1, ctx, { timeoutMs: 8_000 });
        if (!snapshot) {
            ctx.check("subscribed for the abort turn", false, { expected: "snapshot", observed: "none" });
            return;
        }
        await waitForIdle(client, state.sid, state.w1, 60_000, ctx);

        const from = client.mark();
        const send = await routedCmd({
            method: "prompt.send",
            sessionId: state.sid,
            params: { text: SLOW_PROMPT },
            workspaceId: state.w1,
            ctx,
            label: "prompt.send (slow)",
        });
        ctx.check("slow prompt.send → 202", send.status === 202, { expected: 202, observed: apiError(send) });
        if (send.status !== 202) return;

        let firstDelta = null;
        try {
            firstDelta = await client.waitFor(isAssistantDelta, { from, timeoutMs: 90_000, label: "first text delta" });
        } catch {
            firstDelta = null;
        }
        if (!firstDelta) {
            skip("the slow turn produced no streaming assistant delta within 90s (abort window never opened)");
        }
        ctx.check("first assistant delta observed", Boolean(firstDelta), { expected: "text_delta", observed: "none" });
        if (client.since(from).some((frame) => isEvent(frame, "agent_settled"))) {
            skip("the turn settled before the abort was possible (no streaming window to abort in)");
        }

        const abortFrom = client.mark();
        const abort = await routedCmd({
            method: "prompt.abort",
            sessionId: state.sid,
            params: {},
            workspaceId: state.w1,
            ctx,
            label: "prompt.abort",
        });
        ctx.check("prompt.abort → 202", abort.status === 202, { expected: 202, observed: apiError(abort) });

        let settled = null;
        try {
            settled = await client.waitFor((frame) => isEvent(frame, "agent_settled"), {
                from: abortFrom,
                timeoutMs: ABORT_SETTLE_MS,
                label: "agent_settled after abort",
            });
        } catch {
            settled = null;
        }
        ctx.check(`agent_settled within ${ABORT_SETTLE_MS}ms of abort`, Boolean(settled), {
            expected: `agent_settled ≤ ${ABORT_SETTLE_MS}ms`,
            observed: settled ? `${settled._at - abort._receivedAt}ms` : "no settle",
        });
        const stateAfter = (await snapshotOf(client, state.sid, state.w1, { rounds: 2 }))?.payload?.state ?? null;
        const abortedFlag = eventOf(settled ?? {}).aborted;
        ctx.check(
            "abort settles as aborted:true (or the session is idle)",
            abortedFlag === true || stateAfter?.status === "idle",
            { expected: "agent_settled{aborted:true}", observed: { aborted: abortedFlag, status: stateAfter?.status } },
        );
        if (settled && abortedFlag !== true) {
            ctx.warn(`agent_settled reported aborted=${fmt(abortedFlag)}; the session still settled to idle`);
        }
        ctx.eq("status is idle after the abort", stateAfter?.status, "idle");

        const watchFrom = client.mark();
        await sleep(2_500);
        const late = client.since(watchFrom).filter(isAssistantDelta);
        ctx.eq("no assistant delta after the settle", late.length, 0);

        const secondAbort = await routedCmd({
            method: "prompt.abort",
            sessionId: state.sid,
            params: {},
            workspaceId: state.w1,
            ctx,
            label: "prompt.abort (2nd)",
        });
        ctx.check(
            "a second abort is harmless (2xx or an idempotent error code)",
            secondAbort.status === 202 || typeof secondAbort.json?.code === "string",
            { expected: "202 or E_*", observed: apiError(secondAbort) },
        );
        ctx.evidence.abort = {
            abortAck: abort.json,
            settledAborted: eventOf(settled ?? {}).aborted,
            lateDeltas: late.length,
            secondAbortStatus: secondAbort.status,
        };
    } finally {
        await client.close();
    }
});

// ---------------------------------------------------------------------------
// A6 — model / thinking
// ---------------------------------------------------------------------------

scenario("A6", "Model / thinking", async (ctx) => {
    if (!state.sid || !state.w1) skip("A3 did not produce a session");

    // /models is filled asynchronously (`pending:true` on the first call).
    let providers = [];
    let lastModels = null;
    const modelsDeadline = Date.now() + 20_000;
    while (Date.now() < modelsDeadline) {
        lastModels = await http("GET", `/api/v1/models?workspaceId=${state.w1}`, { token: CLI_TOKEN });
        providers = Array.isArray(lastModels.json?.providers) ? lastModels.json.providers : [];
        if (providers.length > 0) break;
        await sleep(500);
    }
    ctx.eq("GET /api/v1/models → 200", lastModels?.status, 200);
    ctx.check("models lists providers", providers.length > 0, {
        expected: "providers[]",
        observed: fmt(lastModels?.json, 300),
    });
    const wellFormed = providers.every(
        (group) => typeof group?.provider === "string" && Array.isArray(group.models) && group.models.every((model) => typeof model?.id === "string"),
    );
    ctx.check("providers[].models[] shape", wellFormed && providers.length > 0, {
        expected: "{provider, models:[{id}]}[]",
        observed: fmt(providers.slice(0, 2), 300),
    });

    const client = await WsClient.open("a6");
    try {
        const snap = await snapshotOf(client, state.sid, state.w1, { rounds: 3 });
        const current = snap?.payload?.state?.model ?? null;
        const listed = (provider, id) =>
            providers.some((group) => group.provider === provider && group.models.some((model) => model.id === id));
        let target = null;
        if (current && listed(current.provider, current.id)) target = { provider: current.provider, id: current.id };
        else if (providers.length && providers[0].models.length) target = { provider: providers[0].provider, id: providers[0].models[0].id };
        ctx.check("a listed model was found for setModel", Boolean(target), {
            expected: "a listed model",
            observed: { current, providers: providers.slice(0, 1) },
        });
        if (!target) return;
        state.model = target;
        ctx.evidence.modelTarget = target;

        const thinkingBefore = snap?.payload?.state?.thinking ?? null;
        const thinking = await routedCmd({
            method: "session.setThinking",
            sessionId: state.sid,
            params: { level: "low" },
            workspaceId: state.w1,
            ctx,
            label: "session.setThinking",
        });
        ctx.check("session.setThinking{low} → 202 ack", thinking.status === 202, {
            expected: 202,
            observed: apiError(thinking),
        });
        // The plugin mirrors the requested level optimistically and then refreshes
        // from the backend's `get_state`; a reasoning model also clamps levels it
        // does not support (deepseek-v4-pro: `thinkingLevelMap = { low: null }`).
        // Judge the level only after the projection settled.
        async function persistedThinking(level) {
            const res = await routedCmd({
                method: "session.setThinking",
                sessionId: state.sid,
                params: { level },
                workspaceId: state.w1,
                ctx,
                label: `session.setThinking (${level})`,
            });
            await sleep(2_500);
            const poll = await pollSnapshotState(client, state.sid, state.w1, (value) => value.thinking === level, {
                timeoutMs: 6_000,
            });
            return { level, status: res.status, thinking: poll.state?.thinking ?? null, ok: poll.state?.thinking === level };
        }

        const lowAttempt = await persistedThinking("low");
        const levelAttempts = [lowAttempt];
        let persistedLevel = lowAttempt.ok ? "low" : null;
        const candidates = ["medium", "max", "high"].filter((level) => level !== thinkingBefore);
        for (const level of candidates) {
            if (persistedLevel) break;
            const attempt = await persistedThinking(level);
            levelAttempts.push(attempt);
            if (attempt.ok) persistedLevel = level;
        }
        ctx.check("session.setThinking persists a backend-supported level", persistedLevel !== null, {
            expected: `one of low, ${candidates.join(", ")} reported back by the snapshot after it settled`,
            observed: fmt({ before: thinkingBefore, attempts: levelAttempts }, 400),
        });
        if (!lowAttempt.ok) {
            // docs/e2e.md A6 asks for `low`, but the active model may not support it.
            deviation(
                "thinking-level-clamped",
                "`session.setThinking{low}` is accepted but the active model clamps it to a supported level",
                `state.thinking stayed ${fmt(lowAttempt.thinking, 60)} 2.5s after the 202 ack. A reasoning model advertises a \`thinkingLevelMap\` (deepseek-v4-pro maps \`low\`/\`medium\` to null), so pi accepts the command and keeps its own level; docs/e2e.md A6 assumes every level is settable.`,
                ctx.id,
            );
            ctx.warn(
                `session.setThinking{low} acked but the backend reports thinking=${fmt(lowAttempt.thinking, 40)} (model capability, not a plugin failure)`,
            );
        }
        const expectedThinking = persistedLevel ?? thinkingBefore;
        ctx.evidence.thinking = { before: thinkingBefore, low: lowAttempt, persistedLevel, expectedThinking };

        const setModel = await routedCmd({
            method: "session.setModel",
            sessionId: state.sid,
            params: { model: target },
            workspaceId: state.w1,
            ctx,
            label: "session.setModel",
        });
        ctx.check("session.setModel → 202 ack", setModel.status === 202, {
            expected: 202,
            observed: apiError(setModel),
        });
        const modelPoll = await pollSnapshotState(
            client,
            state.sid,
            state.w1,
            (value) => value.model?.provider === target.provider && value.model?.id === target.id,
            { timeoutMs: 20_000 },
        );
        ctx.check("session reports the requested provider/id", modelPoll.state?.model?.provider === target.provider && modelPoll.state?.model?.id === target.id, {
            expected: target,
            observed: modelPoll.state?.model ?? "<no snapshot>",
        });
        if (!(modelPoll.state?.model?.provider === target.provider && modelPoll.state?.model?.id === target.id)) {
            ctx.note(`setModel ack was ${fmt(setModel.json, 200)} but the snapshot still reports ${fmt(modelPoll.state?.model, 200)}`);
            deviation(
                "set-model-not-applied",
                "`session.setModel` acks success but the session state keeps the old model",
                `setModel({provider:${target.provider}, id:${target.id}}) → 202 ${fmt(setModel.json, 160)}; state.model stayed ${fmt(modelPoll.state?.model, 160)}.`,
                ctx.id,
            );
        }

        // Invalid values must be rejected with a stable code and change nothing.
        const badLevel = await routedCmd({
            method: "session.setThinking",
            sessionId: state.sid,
            params: { level: "definitely-not-a-level" },
            workspaceId: state.w1,
            ctx,
            label: "session.setThinking (invalid)",
        });
        ctx.check("invalid thinking level → 4xx with a stable code", badLevel.status >= 400 && badLevel.status < 500 && typeof badLevel.json?.code === "string", {
            expected: { status: 400, code: "E_BAD_REQUEST" },
            observed: apiError(badLevel),
        });
        if (!(badLevel.status >= 400)) {
            deviation(
                "no-validation-thinking",
                "`session.setThinking` forwards any string to the RPC layer instead of validating the level",
                "docs/e2e.md A6 requires invalid level/model → 400 with a stable code; the plugin acks 202 and forwards `set_thinking_level` verbatim (pi2.nvim-web/lua/pi/web/commands.lua).",
                ctx.id,
            );
        }
        const badModel = await routedCmd({
            method: "session.setModel",
            sessionId: state.sid,
            params: { model: { provider: "e2e-nope", id: "e2e-nope" } },
            workspaceId: state.w1,
            ctx,
            label: "session.setModel (invalid)",
        });
        ctx.check("invalid model → 4xx with a stable code", badModel.status >= 400 && badModel.status < 500 && typeof badModel.json?.code === "string", {
            expected: { status: 400, code: "E_BAD_REQUEST" },
            observed: apiError(badModel),
        });
        if (!(badModel.status >= 400)) {
            deviation(
                "no-validation-model",
                "`session.setModel` accepts an unlisted provider/model",
                `setModel({provider:"e2e-nope", id:"e2e-nope"}) → ${badModel.status} ${fmt(badModel.json, 160)} (docs/e2e.md A6 requires 400).`,
                ctx.id,
            );
        }

        const afterBad = await snapshotOf(client, state.sid, state.w1, { rounds: 2 });
        ctx.eq("invalid input did not change thinking", afterBad?.payload?.state?.thinking, expectedThinking);
        ctx.eq("invalid input did not change the model", afterBad?.payload?.state?.model?.provider, target.provider);
        ctx.evidence.settings = {
            thinking: afterBad?.payload?.state?.thinking,
            model: afterBad?.payload?.state?.model,
        };
    } finally {
        await client.close();
    }
});

// ---------------------------------------------------------------------------
// A7 — history pagination
// ---------------------------------------------------------------------------

scenario("A7", "History pagination", async (ctx) => {
    if (!state.sid || !state.w1) skip("A3 did not produce a session");
    const file = (await sessionFileOf(state.sid, state.w1)) ?? state.sessionFile;
    ctx.check("the session file is known", typeof file === "string" && file !== "", {
        expected: "sessionFile",
        observed: file,
    });
    if (!file) return;

    const full = await entriesPage(state.sid, state.w1, { limit: 50, sessionFile: file });
    ctx.eq("entries?limit=50 → 200", full.res.status, 200);
    ctx.check("the page carries entries[]", Array.isArray(full.entries), {
        expected: "array",
        observed: fmt(full.raw, 200),
    });
    const all = full.entries ?? [];
    ctx.check("history is non-empty after A4", all.length > 0, { expected: ">0 entries", observed: all.length });
    if (!all.length) return;

    const pageTwo = await entriesPage(state.sid, state.w1, { limit: 2, sessionFile: file });
    ctx.check("limit=2 is honoured", (pageTwo.entries ?? []).length <= 2, {
        expected: "<=2 entries",
        observed: (pageTwo.entries ?? []).length,
    });
    ctx.check("the page exposes hasMore and a cursor", typeof pageTwo.hasMore === "boolean" && (pageTwo.before === null || typeof pageTwo.before === "string"), {
        expected: "{cursor:{before,hasMore}}",
        observed: { hasMore: pageTwo.hasMore, before: pageTwo.before },
    });

    // Direction contract, verified in pi2.nvim-web/lua/pi/web/history.lua:
    //   * `tail()` (what `workspace.query{kind="entries"}` serves with no
    //     `before`) returns the newest `limit` entries in FILE order, i.e. the
    //     page itself is oldest → newest.
    //   * `before(cursor.before, limit)` returns the `limit` entries immediately
    //     older than the cursor, also in file order, and `cursor.before` is the
    //     page's FIRST entry (`make_page` uses `entries[1]`).
    //   * Therefore a `before` walk visits whole pages newest → oldest while each
    //     page is internally oldest → newest, and `cursor.hasMore` reports
    //     whether entries remain beyond the page in the walked direction (so it
    //     is false at the oldest end).
    const pageSize = all.length > 2 ? 2 : 1;
    const pages = [];
    let before;
    let error = null;
    while (pages.length < 60) {
        const page = await entriesPage(state.sid, state.w1, { limit: pageSize, before, sessionFile: file });
        if (!Array.isArray(page.entries)) {
            error = `page ${pages.length + 1} returned no entries: ${fmt(page.raw, 200)}`;
            break;
        }
        if (page.entries.length === 0) break;
        if (page.entries.length > pageSize) {
            error = `page ${pages.length + 1} returned ${page.entries.length} entries for limit=${pageSize}`;
            break;
        }
        pages.push({ ids: entryIds(page.entries), hasMore: page.hasMore, cursor: page.before });
        if (!page.hasMore) break;
        if (!page.before || page.before === before) {
            error = `cursor did not advance (before=${page.before})`;
            break;
        }
        before = page.before;
    }
    ctx.check("paging terminates with an advancing cursor", error === null, {
        expected: "advancing cursor",
        observed: error ?? `pages=${pages.length}`,
    });
    ctx.eq("paging stops with hasMore=false at the oldest end", pages.at(-1)?.hasMore, false);
    const expectedFirstHasMore = all.length > (pages[0]?.ids.length ?? 0);
    ctx.check("the newest page reports hasMore when older entries exist", pages[0]?.hasMore === expectedFirstHasMore, {
        expected: `hasMore=${expectedFirstHasMore} for limit=${pageSize} over ${all.length} entries`,
        observed: { hasMore: pages[0]?.hasMore, pageSize, total: all.length },
    });

    const walkIds = pages.flatMap((page) => page.ids);
    const allIds = entryIds(all);
    // Ground truth: the session file itself, oldest → newest.
    const fileIds = readSessionFileIds(file);
    const fileWindow = fileIds === null ? null : fileIds.slice(-Math.min(fileIds.length, allIds.length));
    ctx.check("the session file is readable for the ground-truth order", fileIds !== null, {
        expected: "JSONL entry ids",
        observed: file,
    });
    ctx.check(
        "`tail` returns the newest entries in file order (oldest → newest)",
        fileWindow !== null && JSON.stringify(allIds) === JSON.stringify(fileWindow),
        {
            expected: fmt(fileWindow, 300),
            observed: fmt(allIds, 300),
        },
    );
    ctx.eq("no duplicate ids across pages", walkIds.length, new Set(walkIds).size);
    ctx.check(
        "the union of all pages equals the full entry id set",
        sameIdSet(walkIds, fileIds ?? allIds),
        { expected: fmt(fileIds ?? allIds, 300), observed: fmt(walkIds, 300) },
    );
    ctx.check(
        "each page is internally ordered oldest → newest (file order)",
        pages.every((page) => isOrderedRun(page.ids, allIds)),
        {
            expected: "contiguous ascending runs of the file order",
            observed: pages.map((page) => fmt(page.ids, 60)),
        },
    );
    ctx.check("cursor.before is the page's first (oldest) entry", pages.every((page) => page.cursor === page.ids[0]), {
        expected: "cursor.before == entries[0].id",
        observed: pages.map((page) => `${page.cursor} vs ${page.ids[0]}`),
    });
    // The walk visits pages newest → oldest; reversing the page ORDER (not the
    // entries inside a page) must reproduce the single ascending page.
    ctx.check(
        "reverse page order reproduces the file order",
        JSON.stringify([...pages].reverse().flatMap((page) => page.ids)) ===
            JSON.stringify(allIds.slice(-walkIds.length)),
        {
            expected: fmt(allIds.slice(-walkIds.length), 300),
            observed: fmt([...pages].reverse().flatMap((page) => page.ids), 300),
        },
    );
    ctx.evidence.paging = {
        pages: pages.length,
        pageSize,
        entries: walkIds.length,
        direction: "tail = ascending file order; before = newest page first, each page ascending",
        fileEntries: fileIds === null ? null : fileIds.length,
    };

    const again = await entriesPage(state.sid, state.w1, { limit: 50, sessionFile: file });
    ctx.eq("ordering is stable across calls", JSON.stringify(entryIds(again.entries ?? [])), JSON.stringify(allIds));
});

// ---------------------------------------------------------------------------
// A8 — reconnect / resync
// ---------------------------------------------------------------------------

scenario("A8", "Reconnect / resync", async (ctx) => {
    if (!state.sid || !state.w1) skip("A3 did not produce a session");

    const first = await WsClient.open("a8-first");
    let epoch;
    let seq;
    try {
        const { snapshot } = await subscribeSession(first, state.sid, state.w1, ctx, { timeoutMs: 8_000 });
        if (!snapshot) {
            ctx.check("first connection receives a snapshot", false, { expected: "snapshot", observed: "none" });
            return;
        }
        epoch = snapshot.epoch;
        seq = snapshot.seq;
        ctx.check("resume base has an epoch and seq", typeof epoch === "string" && typeof seq === "number", {
            expected: { epoch: "string", seq: "number" },
            observed: { epoch, seq },
        });
    } finally {
        await first.close();
    }

    const second = await WsClient.open("a8-second");
    try {
        await sleep(200);
        const from = second.mark();
        let hinted = false;
        second.send({
            v: 1,
            type: "subscribe",
            payload: { sessionIds: [state.sid], since: { sessionId: state.sid, epoch, seq } },
        });
        let frame = await second
            .waitFor((candidate) => candidate.type === "snapshot" || candidate.type === "resync_required" || candidate.type === "error", {
                from,
                timeoutMs: 8_000,
                label: "resume answer",
            })
            .catch(() => null);
        if (frame?.type === "error" && frame.payload?.code === "E_SESSION_NOT_FOUND") {
            deviation(
                "routing-after-id-migration",
                "Daemon loses a session after the plugin migrates its id from `tmp-N` to the backend id",
                "WS resume (subscribe with `since`) answers E_SESSION_NOT_FOUND for a migrated session.",
                ctx.id,
            );
            ctx.warn("resume subscribe answered E_SESSION_NOT_FOUND; retried with the workspaceId hint");
            hinted = true;
            const retryFrom = second.mark();
            second.send({
                v: 1,
                type: "subscribe",
                payload: { sessionIds: [state.sid], workspaceId: state.w1, since: { sessionId: state.sid, epoch, seq } },
            });
            frame = await second
                .waitFor((candidate) => candidate.type === "snapshot" || candidate.type === "resync_required", {
                    from: retryFrom,
                    timeoutMs: 8_000,
                    label: "resume answer (with workspaceId)",
                })
                .catch(() => null);
        }
        ctx.check("resume answers with a snapshot or resync_required", frame?.type === "snapshot" || frame?.type === "resync_required", {
            expected: "snapshot | resync_required",
            observed: frame ? `${frame.type} ${fmt(frame.payload, 160)}` : "no frame",
        });

        let snapshot = frame?.type === "snapshot" ? frame : null;
        if (frame?.type === "resync_required") {
            ctx.note(`resync_required: requested ${fmt(frame.payload?.requestedSeq)} last ${fmt(frame.payload?.lastSeq)}`);
            const resyncFrom = second.mark();
            second.send({
                v: 1,
                type: "subscribe",
                payload: { sessionIds: [state.sid], ...(hinted ? { workspaceId: state.w1 } : {}) },
            });
            snapshot = await second
                .waitFor((candidate) => candidate.type === "snapshot" && candidate.sessionId === state.sid, {
                    from: resyncFrom,
                    timeoutMs: 8_000,
                    label: "snapshot after resync_required",
                })
                .catch(() => null);
        }
        ctx.check("a snapshot follows the resume", Boolean(snapshot), { expected: "snapshot", observed: "none" });
        if (!snapshot) return;

        const resumedIds = entryIds(snapshot.payload?.state?.entries ?? []);
        const fresh = await snapshotOf(second, state.sid, state.w1, { rounds: 3 });
        const freshIds = entryIds(fresh?.payload?.state?.entries ?? []);
        ctx.check("resume snapshot matches a fresh snapshot's entry ids", JSON.stringify(resumedIds) === JSON.stringify(freshIds), {
            expected: fmt(freshIds, 200),
            observed: fmt(resumedIds, 200),
        });
        ctx.check("no seq regression on the resumed snapshot", typeof snapshot.seq === "number" && snapshot.seq >= Math.min(seq, fresh?.seq ?? 0), {
            expected: `>= ${seq}`,
            observed: { resumed: snapshot.seq, fresh: fresh?.seq, resync: frame?.type },
        });
        ctx.eq("the epoch survives the reconnect", snapshot.epoch, epoch);
        ctx.evidence.resume = {
            requested: { epoch, seq },
            answer: frame?.type,
            resumedSeq: snapshot.seq,
            entries: resumedIds.length,
            hinted,
        };
    } finally {
        await second.close();
    }
});

// ---------------------------------------------------------------------------
// A9 — multi-workspace isolation
// ---------------------------------------------------------------------------

scenario("A9", "Multi-workspace isolation", async (ctx) => {
    if (!state.w1 || !state.sid) skip("A3 did not produce a session");
    const added = await addWorkspace("w2", ctx);
    if (!added.workspaceId) return;
    state.w2 = added.workspaceId;
    const ready = await ensureInstanceReady(state.w2, ctx, "w2 instance");
    if (ready.status !== "ready") return;

    const created = await createSession(state.w2, ctx, "w2 session");
    const sid2 = created.realId;
    ctx.check("W2 session created", typeof sid2 === "string" && sid2 !== "", {
        expected: "session id",
        observed: sid2,
    });
    if (!sid2) return;

    const w1Client = await WsClient.open("a9-w1");
    const w2Client = await WsClient.open("a9-w2");
    try {
        const w1Sub = await subscribeSession(w1Client, state.sid, state.w1, ctx, { timeoutMs: 8_000 });
        const w2Sub = await subscribeSession(w2Client, sid2, state.w2, ctx, { timeoutMs: 8_000 });
        ctx.check("both sessions are subscribed", Boolean(w1Sub.snapshot) && Boolean(w2Sub.snapshot), {
            expected: "two snapshots",
            observed: { w1: Boolean(w1Sub.snapshot), w2: Boolean(w2Sub.snapshot) },
        });
        const w1Mark = w1Client.mark();
        const w2Mark = w2Client.mark();

        const send = await routedCmd({
            method: "prompt.send",
            sessionId: sid2,
            params: { text: W2_PROMPT },
            workspaceId: state.w2,
            ctx,
            label: "prompt.send (W2)",
        });
        ctx.check("W2 prompt.send → 202", send.status === 202, { expected: 202, observed: apiError(send) });
        if (send.status === 202) {
            await w2Client
                .waitFor((frame) => isEvent(frame, "agent_settled"), { from: w2Mark, timeoutMs: TURN_MS, label: "W2 agent_settled" })
                .catch(() => null);
        }

        const w2Frames = w2Client.since(w2Mark);
        ctx.check("the W2 turn produced events on the W2 subscription", w2Frames.some((frame) => frame.type === "event"), {
            expected: ">=1 event",
            observed: w2Frames.length,
        });
        const leaked = w1Client.since(w1Mark).filter((frame) => frame.sessionId === sid2);
        ctx.eq("the W1 subscription received no W2 events", leaked.length, 0);

        const { rows } = await sessionsList(state.w1);
        ctx.check("W1's session list never lists the W2 session", !rows.some((row) => row.sessionId === sid2), {
            expected: `no ${sid2}`,
            observed: rows.map((row) => row.sessionId),
        });
        const w2Rows = (await sessionsList(state.w2)).rows;
        ctx.check("W2's session list lists the W2 session", w2Rows.some((row) => row.sessionId === sid2), {
            expected: sid2,
            observed: w2Rows.map((row) => row.sessionId),
        });

        const w1Models = await http("GET", `/api/v1/models?workspaceId=${state.w1}`, { token: CLI_TOKEN });
        ctx.eq("W1 models query → 200", w1Models.status, 200);
        ctx.check("W1 models query is workspace-scoped (providers[])", Array.isArray(w1Models.json?.providers), {
            expected: "providers[]",
            observed: fmt(w1Models.json, 200),
        });

        const w1Entries = await entriesPage(state.sid, state.w1, { limit: 5, sessionFile: await sessionFileOf(state.sid, state.w1) });
        const w1EntryText = JSON.stringify(w1Entries.entries ?? []);
        ctx.check("W1's history does not contain the W2 prompt", !w1EntryText.includes(W2_PROMPT), {
            expected: "no W2 prompt in W1 history",
            observed: w1EntryText.slice(0, 200),
            severity: "warn",
        });
        ctx.evidence.isolation = { w1Events: w1Client.since(w1Mark).length, w2Events: w2Frames.length, leaked: leaked.length };
    } finally {
        await w1Client.close();
        await w2Client.close();
    }
});

// ---------------------------------------------------------------------------
// A10 — subagents
// ---------------------------------------------------------------------------

scenario("A10", "Subagents", async (ctx) => {
    if (!state.sid || !state.w1) skip("A3 did not produce a session");
    const client = await WsClient.open("a10");
    try {
        const { snapshot } = await subscribeSession(client, state.sid, state.w1, ctx, { timeoutMs: 8_000 });
        if (!snapshot) {
            ctx.check("subscribed for subagent events", false, { expected: "snapshot", observed: "none" });
            return;
        }
        await waitForIdle(client, state.sid, state.w1, 60_000, ctx).catch(() => {});

        const from = client.mark();
        const requestId = `e2e-sub-${Date.now()}`;
        const dispatchBody = {
            method: "subagent.dispatch",
            sessionId: state.sid,
            params: { items: [{ task: SUB_PROMPT, name: "e2e-sub" }] },
            clientRequestId: requestId,
        };
        const dispatch = await routedCmd({
            ...dispatchBody,
            workspaceId: state.w1,
            ctx,
            label: "subagent.dispatch",
        });
        if (dispatch.status >= 400) {
            ctx.check("subagent.dispatch accepted", false, {
                expected: 202,
                observed: apiError(dispatch),
            });
            ctx.note(`dispatch error code: ${dispatch.json?.code ?? "<none>"}`);
            deviation(
                "subagent-dispatch-error",
                "`subagent.dispatch` failed",
                `Ack ${dispatch.status} ${fmt(dispatch.json, 200)}.`,
                ctx.id,
            );
            return;
        }
        ctx.check("subagent.dispatch → 202 ack", dispatch.status === 202, { expected: 202, observed: apiError(dispatch) });

        // Replaying the same clientRequestId must not create a second batch.
        const replayBody = {
            ...dispatchBody,
            ...(dispatch.retriedWithWorkspace ? { params: { ...dispatchBody.params, workspaceId: state.w1 } } : {}),
        };
        const replay = await cmd(replayBody);
        ctx.check(
            "a replayed clientRequestId is deduplicated (identical ack, no second batch)",
            replay.status === dispatch.status && JSON.stringify(replay.json ?? {}) === JSON.stringify(dispatch.json ?? {}),
            {
                expected: fmt(dispatch.json, 200),
                observed: fmt(replay.json, 200),
            },
        );

        let firstSignal = null;
        try {
            firstSignal = await client.waitFor((frame) => isEvent(frame, "pi2:batch") || isEvent(frame, "pi2:subagents"), {
                from,
                timeoutMs: 120_000,
                label: "pi2:batch / pi2:subagents",
            });
        } catch {
            firstSignal = null;
        }
        ctx.check("pi2:batch or pi2:subagents observed within 120s", Boolean(firstSignal), {
            expected: "pi2:batch | pi2:subagents",
            observed: "none",
        });
        if (!firstSignal) {
            const stateNow = (await snapshotOf(client, state.sid, state.w1, { rounds: 2 }))?.payload?.state ?? null;
            ctx.note(`batches=${fmt(stateNow?.batches, 200)} subagents=${fmt(stateNow?.subagents, 200)}`);
            return;
        }

        const signalFrames = client.since(from).filter((frame) => isEvent(frame, "pi2:batch") || isEvent(frame, "pi2:subagents"));
        const batchEvents = signalFrames.filter((frame) => isEvent(frame, "pi2:batch")).map(eventOf);
        const subagentEvents = signalFrames.filter((frame) => isEvent(frame, "pi2:subagents")).map(eventOf);
        let children = subagentEvents.flatMap((event) => event.subagents ?? []);
        let child = children.find((candidate) => candidate?.id) ?? null;
        const batchRefs = batchEvents
            .flatMap((event) => event.items ?? [])
            .map((item) => item?.ref)
            .filter((ref) => typeof ref === "string");
        // `pi2:batch.items[].ref` may be the item's position in the batch ("0"),
        // not a session id. The authoritative manifest is the snapshot's
        // `subagents[]` (ids match the session ids `:PiSessions` lists).
        if (!child) {
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
                const stateNow = (await snapshotOf(client, state.sid, state.w1, { rounds: 2 }))?.payload?.state ?? null;
                const manifest = stateNow?.subagents ?? [];
                const found = manifest.find((candidate) => candidate?.id) ?? null;
                if (found) {
                    child = found;
                    children = manifest;
                    break;
                }
                const batch = (stateNow?.batches ?? [])[0];
                if (batch && ["completed", "failed", "cancelled", "partial"].includes(batch.status)) break;
                await sleep(1_000);
            }
        }
        state.childId = child?.id ?? batchRefs.find((ref) => /-/.test(ref)) ?? null;
        ctx.check("the child subagent is identified by its session id", typeof state.childId === "string" && state.childId !== "", {
            expected: "child session id (subagents[].id or a session-shaped batch ref)",
            observed: {
                child,
                children: children.map((candidate) => `${candidate.id}:${candidate.status}`),
                batchRefs,
                batches: batchEvents.map((event) => `${event.batchId}:${event.status}`),
            },
        });
        ctx.check(
            "the child reaches an active/completed state",
            children.some((candidate) => ["active", "completed", "dormant"].includes(candidate?.status)) ||
                batchEvents.some((event) => ["running", "completed", "partial"].includes(event?.status)),
            {
                expected: "active|completed",
                observed: { children: children.map((candidate) => `${candidate.id}:${candidate.status}`), batches: batchEvents.map((event) => `${event.batchId}:${event.status}`) },
            },
        );
        const finalState = (await snapshotOf(client, state.sid, state.w1, { rounds: 2 }))?.payload?.state ?? null;
        ctx.check("the snapshot exposes batches/subagents", Array.isArray(finalState?.batches) && Array.isArray(finalState?.subagents), {
            expected: "batches[] + subagents[]",
            observed: { batches: finalState?.batches?.length, subagents: finalState?.subagents?.length },
            severity: "warn",
        });
        // A terminal child status can arrive through either valid shape: the
        // reducer projection `state.subagents[]` (`{id: <subagent session id>,
        // status}`) or `state.batches[].items[]` (`{ref, status}`, where
        // pi2.nvim may emit the item index as `ref`, so `ref` is not
        // necessarily a session id). Resolve the projection id first — it is the
        // subagent's session id — and keep the batch ref as a second key.
        const DISPATCH_NAME = "e2e-sub";
        const batchRef = state.childId;
        const projectedChild =
            (finalState?.subagents ?? []).find((candidate) => candidate?.id === batchRef) ??
            (finalState?.subagents ?? []).find((candidate) => candidate?.name === DISPATCH_NAME && candidate?.id) ??
            null;
        const childId = typeof projectedChild?.id === "string" && projectedChild.id !== "" ? projectedChild.id : batchRef;
        if (childId !== state.childId) {
            ctx.note(`batch item ref ${fmt(state.childId, 60)} resolved to subagent session ${fmt(childId, 60)}`);
            state.childId = childId;
        }

        const listedRows = (await sessionsList(state.w1)).rows;
        const listed = typeof childId === "string" && listedRows.some((row) => row.sessionId === childId);
        ctx.check("the child session is listed by the workspace query", listed, {
            expected: `row for ${childId}`,
            observed: listedRows.map((row) => row.sessionId),
            severity: "warn",
        });

        // A one-shot SUB task is usually done by now, so a settled child is a
        // valid outcome; `subagent.stop` is only sent (and only has to ack) when
        // the child is still running.
        const SETTLED = ["completed", "dormant", "interrupted", "failed"];
        const childStatuses = (value) => {
            const statuses = [];
            for (const candidate of value?.subagents ?? []) {
                if (candidate?.id === childId && typeof candidate?.status === "string") statuses.push(candidate.status);
            }
            for (const batch of value?.batches ?? []) {
                if (batch?.batchId === childId && typeof batch?.status === "string") statuses.push(batch.status);
                for (const item of batch?.items ?? []) {
                    const key = item?.ref ?? item?.id;
                    if ((key === childId || key === batchRef) && typeof item?.status === "string") statuses.push(item.status);
                }
            }
            return statuses;
        };
        const isChildSettled = (value) => childStatuses(value).some((status) => SETTLED.includes(status));

        if (typeof childId === "string") {
            const settledBeforeStop = isChildSettled(finalState);
            let stop = null;
            if (settledBeforeStop) {
                ctx.note(`child ${childId} already settled (${childStatuses(finalState).join("|")}); subagent.stop is optional and was skipped`);
            } else {
                stop = await routedCmd({
                    method: "subagent.stop",
                    sessionId: state.sid,
                    params: { targets: [childId] },
                    workspaceId: state.w1,
                    ctx,
                    label: "subagent.stop",
                });
                ctx.check("subagent.stop → 202 ack", stop.status === 202, { expected: 202, observed: apiError(stop) });
            }
            const settled = settledBeforeStop
                ? { state: finalState, timedOut: false }
                : await pollSnapshotState(client, state.sid, state.w1, isChildSettled, { timeoutMs: 30_000 });
            ctx.check("the child ends settled (completed|dormant|interrupted|failed)", !settled.timedOut, {
                expected: "completed|dormant|interrupted|failed (state.subagents[] or batches[].items[])",
                observed: {
                    statuses: childStatuses(settled.state),
                    childId,
                    batchRef,
                    subagents: fmt(settled.state?.subagents, 300),
                    batches: fmt(settled.state?.batches, 300),
                },
            });
            ctx.evidence.subagentChild = {
                id: childId,
                batchRef,
                settledBeforeStop,
                stop: stop ? apiError(stop) : "skipped (child already settled)",
                status: childStatuses(settled.state),
            };
        } else {
            ctx.note(`no child id resolved; the stop/settle checks were skipped (subagents=${fmt(finalState?.subagents, 200)})`);
        }
        ctx.evidence.subagents = {
            batches: batchEvents.map((event) => `${event.batchId}:${event.status}`),
            children: children.map((candidate) => `${candidate.id}:${candidate.status}`),
        };
    } finally {
        await client.close();
    }
});

// ---------------------------------------------------------------------------
// A11 — attention / diff review (pre-execution)
// ---------------------------------------------------------------------------

scenario("A11", "Attention / diff review", async (ctx) => {
    if (!state.sid || !state.w1) skip("A3 did not produce a session");
    const cwd = (await workspaceRow(state.w1))?.cwd ?? join(WORKSPACE_ROOTS, "w1");
    const target = join(cwd, ATTENTION_FILE);
    const rejectTarget = join(cwd, ATTENTION_REJECT_FILE);
    state.attentionFile = target;
    for (const path of [target, rejectTarget]) {
        try {
            rmSync(path, { force: true });
        } catch {
            /* ignore */
        }
    }

    const client = await WsClient.open("a11");

    /** Subscribe once and wait until the session is idle (the daemon caches state). */
    async function ensureSubscribed() {
        const { snapshot } = await subscribeSession(client, state.sid, state.w1, ctx, { timeoutMs: 8_000 });
        if (!snapshot) {
            ctx.check("subscribed for attention events", false, { expected: "snapshot", observed: "none" });
            return false;
        }
        await waitForIdle(client, state.sid, state.w1, 120_000, ctx);
        return true;
    }

    /**
     * Wait for the diff attention request. The plugin emits
     * `pi2:attention_request` first and queues the entry; the snapshot is only
     * the fallback because a slow subscriber might miss the event.
     */
    async function awaitAttention(from, file, label) {
        const hit = await client
            .waitFor(
                (frame) =>
                    (isEvent(frame, "pi2:attention_request") &&
                        (eventOf(frame).method === "diff" || eventOf(frame).payload?.files !== undefined)) ||
                    (frame.type === "snapshot" && (frame.payload?.state?.attention ?? []).length > 0),
                { from, timeoutMs: 90_000, label },
            )
            .catch(() => null);
        const event = hit && isEvent(hit, "pi2:attention_request") ? eventOf(hit) : null;
        let item = event;
        if (!item) {
            const later = (await snapshotOf(client, state.sid, state.w1, { rounds: 3 }))?.payload?.state ?? null;
            item = (later?.attention ?? []).find((candidate) => (candidate.payload?.files ?? []).some((f) => f?.path === file)) ?? (later?.attention ?? [])[0] ?? null;
        }
        return { event, item };
    }

    /** Resolve the request and wait for `pi2:attention_resolved`. */
    async function resolveAttention(requestId, response, label) {
        const from = client.mark();
        const res = await routedCmd({
            method: "attention.respond",
            sessionId: state.sid,
            params: { requestId, response },
            workspaceId: state.w1,
            ctx,
            label,
        });
        const resolved = await client
            .waitFor((frame) => isEvent(frame, "pi2:attention_resolved") && eventOf(frame).requestId === requestId, {
                from,
                timeoutMs: 15_000,
                label: `${label}: pi2:attention_resolved`,
            })
            .catch(() => null);
        return { res, resolved };
    }

    try {
        if (!(await ensureSubscribed())) return;

        // ------------------------------------------------------------------
        // accept case
        // ------------------------------------------------------------------
        const acceptFrom = client.mark();
        const send = await routedCmd({
            method: "prompt.send",
            sessionId: state.sid,
            params: { text: ATTENTION_PROMPT },
            workspaceId: state.w1,
            ctx,
            label: "prompt.send (attention)",
        });
        ctx.check("attention prompt.send → 202", send.status === 202, { expected: 202, observed: apiError(send) });
        if (send.status !== 202) return;

        let { event, item } = await awaitAttention(acceptFrom, ATTENTION_FILE, "pi2:attention_request");
        if (!item) {
            // A wrong model (e.g. one that answers the PONG prompt with an empty
            // message) makes the following turns hang. Recover once by aborting
            // and re-prompting before declaring a failure.
            const extensionErrors = client
                .since(0)
                .filter((frame) => isEvent(frame, "extension_error"))
                .map(eventOf)
                .slice(-2);
            ctx.note("no attention request on the first attempt; aborting and re-prompting once");
            await routedCmd({
                method: "prompt.abort",
                sessionId: state.sid,
                params: {},
                workspaceId: state.w1,
                ctx,
                label: "prompt.abort (attention retry)",
            });
            await client
                .waitFor((frame) => isEvent(frame, "agent_settled"), { from: 0, timeoutMs: 20_000, label: "settle after abort" })
                .catch(() => null);
            await waitForIdle(client, state.sid, state.w1, 60_000, ctx);
            const retry = await routedCmd({
                method: "prompt.send",
                sessionId: state.sid,
                params: { text: ATTENTION_PROMPT },
                workspaceId: state.w1,
                ctx,
                label: "prompt.send (attention retry)",
            });
            ctx.check("attention prompt.send (retry) → 202", retry.status === 202, {
                expected: 202,
                observed: apiError(retry),
            });
            ({ event, item } = await awaitAttention(client.mark(), ATTENTION_FILE, "pi2:attention_request (retry)"));
            if (!item) {
                ctx.check("the attention extension emits an extension_ui_request", false, {
                    expected: "pi2:attention_request (method diff) or a snapshot attention[] entry",
                    observed: { extensionErrors, prompt: ATTENTION_PROMPT },
                });
                ctx.note(
                    "A11 wiring: scripts/e2e/host-init.lua sets cli.args = {\"--extension\", <repo>/scripts/e2e/attention-ext.ts}; without a request the extension may have failed to load (see extensionErrors) or the backend turn never started",
                );
                ctx.evidence.attention = { delivered: false, extensionErrors };
                return;
            }
        }

        const requestId = item.requestId ?? null;
        ctx.check("the attention request carries a requestId", typeof requestId === "string" && requestId !== "", {
            expected: "requestId",
            observed: item,
        });
        if (!requestId) return;

        ctx.eq("the request is surfaced as a diff review (method=diff)", item.method, "diff");
        const files = item.payload?.files ?? [];
        ctx.check("the diff payload carries the requested file", files.some((file) => file?.path === ATTENTION_FILE), {
            expected: `${ATTENTION_FILE} in payload.files[].path`,
            observed: fmt(files, 300),
        });
        ctx.check("the request is a real extension_ui_request event (not just a snapshot)", Boolean(event), {
            expected: "pi2:attention_request frame",
            observed: event ? "frame" : "snapshot-only",
            severity: "warn",
        });
        ctx.check("the request exposes selectable options", Array.isArray(item.options) && item.options.length >= 2, {
            expected: "[Accept, Reject]",
            observed: item.options,
            severity: "warn",
        });
        ctx.eq("the file does not exist before consent", existsSyncSafe(target), false);

        const pendingState = (await snapshotOf(client, state.sid, state.w1, { rounds: 2 }))?.payload?.state ?? null;
        ctx.check(
            "snapshot.attention lists the pending request",
            (pendingState?.attention ?? []).some((candidate) => candidate.requestId === requestId),
            { expected: `attention[] with ${requestId}`, observed: fmt(pendingState?.attention, 300) },
        );

        const accepted = await resolveAttention(requestId, { value: JSON.stringify({ result: "Accepted" }) }, "attention.respond");
        ctx.check("attention.respond{Accepted} → 202 ack", accepted.res.status === 202, {
            expected: 202,
            observed: apiError(accepted.res),
        });
        ctx.check("pi2:attention_resolved observed", Boolean(accepted.resolved), {
            expected: "pi2:attention_resolved",
            observed: "none",
        });

        let content = null;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            try {
                content = readFileSync(target, "utf8");
                if (content.includes("hello-e2e")) break;
            } catch {
                content = null;
            }
            await sleep(250);
        }
        ctx.check("the accepted file exists with the requested content", typeof content === "string" && content.trim() === "hello-e2e", {
            expected: "hello-e2e",
            observed: content,
        });

        const secondRespond = await routedCmd({
            method: "attention.respond",
            sessionId: state.sid,
            params: { requestId, response: { value: JSON.stringify({ result: "Accepted" }) } },
            workspaceId: state.w1,
            ctx,
            label: "attention.respond (2nd)",
        });
        ctx.check(
            "a second attention.respond is rejected with E_ATTENTION_RESOLVED",
            secondRespond.status === 409 && secondRespond.json?.code === "E_ATTENTION_RESOLVED",
            { expected: { status: 409, code: "E_ATTENTION_RESOLVED" }, observed: apiError(secondRespond) },
        );

        const settled = await client
            .waitFor((frame) => isEvent(frame, "agent_settled"), { from: client.mark(), timeoutMs: 180_000, label: "settle after accept" })
            .catch(() => null);
        ctx.check("the accepted turn settles", Boolean(settled), {
            expected: "agent_settled",
            observed: settled ? "observed" : "none",
        });
        if (settled) ctx.eq("the accepted turn reports aborted=false", eventOf(settled).aborted, false);

        const afterAccept = (await snapshotOf(client, state.sid, state.w1, { rounds: 2 }))?.payload?.state ?? null;
        const toolBlocks = (afterAccept?.entries ?? [])
            .flatMap((entry) => entry?.blocks ?? [])
            .filter((block) => block?.type === "tool" && block?.name === "e2e_request");
        ctx.check("the transcript carries the e2e_request tool block", toolBlocks.length > 0, {
            expected: "tool block e2e_request",
            observed: fmt(
                (afterAccept?.entries ?? []).map((entry) => `${entry.role}:${(entry.blocks ?? []).map((block) => block.type).join("+")}`),
                300,
            ),
            severity: "warn",
        });
        ctx.check(
            "the model reports DONE after the accepted review",
            /\bDONE\b/.test(
                (afterAccept?.entries ?? [])
                    .filter((entry) => entry.role === "assistant")
                    .flatMap((entry) => (entry.blocks ?? []).filter((block) => block.type === "text").map((block) => block.text))
                    .join(" "),
            ),
            {
                expected: "assistant text containing DONE",
                observed: fmt(
                    (afterAccept?.entries ?? [])
                        .filter((entry) => entry.role === "assistant")
                        .flatMap((entry) => (entry.blocks ?? []).filter((block) => block.type === "text").map((block) => block.text))
                        .slice(-1),
                    200,
                ),
                severity: "warn",
            },
        );
        // ------------------------------------------------------------------
        // reject case (cheap: one more turn, cancelled response)
        // ------------------------------------------------------------------
        await waitForIdle(client, state.sid, state.w1, 120_000, ctx);
        const rejectFrom = client.mark();
        const rejectSend = await routedCmd({
            method: "prompt.send",
            sessionId: state.sid,
            params: { text: ATTENTION_REJECT_PROMPT },
            workspaceId: state.w1,
            ctx,
            label: "prompt.send (attention reject)",
        });
        ctx.check("reject prompt.send → 202", rejectSend.status === 202, { expected: 202, observed: apiError(rejectSend) });

        let rejectAnswered = false;
        let rejectApi = null;
        let rejectResolved = null;
        let rejectSettled = null;
        if (rejectSend.status === 202) {
            const reject = await awaitAttention(rejectFrom, ATTENTION_REJECT_FILE, "pi2:attention_request (reject)");
            const rejectId = reject.item?.requestId ?? null;
            ctx.check("the reject case surfaces a diff request with a requestId", typeof rejectId === "string" && rejectId !== "", {
                expected: "requestId",
                observed: reject.item,
            });
            ctx.check(
                "the reject payload targets the reject file",
                (reject.item?.payload?.files ?? []).some((file) => file?.path === ATTENTION_REJECT_FILE),
                { expected: ATTENTION_REJECT_FILE, observed: fmt(reject.item?.payload, 300) },
            );
            ctx.eq("the reject target does not exist before consent", existsSyncSafe(rejectTarget), false);
            if (rejectId) {
                const rejected = await resolveAttention(rejectId, { cancelled: true }, "attention.respond (reject)");
                rejectAnswered = rejected.res.status === 202;
                rejectApi = apiError(rejected.res);
                rejectResolved = rejected.resolved;
                ctx.check("attention.respond{cancelled} → 202 ack", rejectAnswered, {
                    expected: 202,
                    observed: rejectApi,
                });
                ctx.check("pi2:attention_resolved observed for the reject", Boolean(rejectResolved), {
                    expected: "pi2:attention_resolved",
                    observed: "none",
                });
                await sleep(1_500);
                ctx.eq("a rejected review writes no file", existsSyncSafe(rejectTarget), false);
            }
            rejectSettled = await client
                .waitFor((frame) => isEvent(frame, "agent_settled"), {
                    from: client.mark(),
                    timeoutMs: 180_000,
                    label: "settle after reject",
                })
                .catch(() => null);
            ctx.check("the rejected turn settles without an error state", Boolean(rejectSettled), {
                expected: "agent_settled",
                observed: rejectSettled ? "observed" : "none",
            });
            if (rejectSettled) ctx.eq("the rejected turn reports aborted=false", eventOf(rejectSettled).aborted, false);
        }

        ctx.evidence.attention = {
            requestId,
            method: item.method,
            payloadFiles: files.map((file) => file?.path),
            acceptedContent: content,
            secondRespond: apiError(secondRespond),
            settled: Boolean(settled),
            reject: {
                answered: rejectAnswered,
                api: rejectApi,
                resolved: Boolean(rejectResolved),
                settled: Boolean(rejectSettled),
            },
        };
        ctx.note(
            "attention trigger: scripts/e2e/attention-ext.ts loaded through host-init.lua `cli.args = {\"--extension\", …}`",
        );
    } finally {
        await client.close();
    }
});


function existsSyncSafe(path) {
    try {
        statSync(path);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// A12 — errors
// ---------------------------------------------------------------------------

scenario("A12", "Errors", async (ctx) => {
    const unknown = await cmd({ method: "prompt.send", sessionId: "e2e-no-such-session", params: { text: "hi" } });
    ctx.eq("unknown session → 404", unknown.status, 404);
    ctx.eq("unknown session code", unknown.json?.code, "E_SESSION_NOT_FOUND");

    if (state.sid) {
        const unknownMethod = await routedCmd({
            method: "e2e.no_such_method",
            sessionId: state.sid,
            params: {},
            workspaceId: state.w1,
            ctx,
            label: "unknown method",
        });
        ctx.check("unknown method → E_METHOD_NOT_ALLOWED", unknownMethod.json?.code === "E_METHOD_NOT_ALLOWED", {
            expected: "E_METHOD_NOT_ALLOWED",
            observed: apiError(unknownMethod),
        });
        if (unknownMethod.json?.code !== "E_METHOD_NOT_ALLOWED") {
            deviation(
                "unknown-method-internal",
                "Unknown plugin methods answer `E_INTERNAL` instead of `E_METHOD_NOT_ALLOWED`",
                `POST /api/v1/cmd {method:"e2e.no_such_method"} → ${unknownMethod.status} ${fmt(unknownMethod.json, 200)}. The bridge dispatches handlers directly and never reaches pi.web.commands.dispatch (which maps unknown → E_METHOD_NOT_ALLOWED).`,
                ctx.id,
            );
        }
    } else {
        ctx.check("unknown method → E_METHOD_NOT_ALLOWED", false, { expected: "E_METHOD_NOT_ALLOWED", observed: "no session" });
    }

    const malformed = await http("POST", "/api/v1/cmd", { token: CLI_TOKEN, rawBody: '{"method":' });
    ctx.check("malformed JSON body → 4xx", malformed.status >= 400 && malformed.status < 500, {
        expected: "400",
        observed: malformed.status,
    });
    ctx.eq("malformed body code", malformed.json?.code, "E_BAD_REQUEST");

    const notAnObject = await http("POST", "/api/v1/cmd", { token: CLI_TOKEN, rawBody: "[1,2,3]" });
    ctx.check("array body → 4xx", notAnObject.status >= 400 && notAnObject.status < 500, {
        expected: "400",
        observed: notAnObject.status,
    });

    const missingMethod = await cmd({ params: {} });
    ctx.check("missing method → 4xx", missingMethod.status >= 400 && missingMethod.status < 500, {
        expected: "400",
        observed: apiError(missingMethod),
    });

    const errorShapes = [
        ["unknown session", unknown],
        ["malformed json", malformed],
        ["missing method", missingMethod],
    ];
    const badShape = errorShapes.filter(([, result]) => {
        const body = result.json ?? {};
        return typeof body.code !== "string" || typeof body.message !== "string" || typeof body.retryable !== "boolean";
    });
    ctx.eq("every error body carries {code, message, retryable}", badShape.length, 0);

    const health = await http("GET", "/api/v1/health", { token: CLI_TOKEN });
    ctx.check("the daemon is still healthy after the bad requests", health.status === 200 && health.json?.ok === true, {
        expected: { status: 200, ok: true },
        observed: { status: health.status, body: fmt(health.json, 200) },
    });
    const list = await http("GET", "/api/v1/workspaces", { token: CLI_TOKEN });
    ctx.eq("the next request is still 200", list.status, 200);

    // Auth errors on the WS surface.
    const ws = new WebSocket(WS_URL, { handshakeTimeout: WS_OPEN_MS });
    try {
        const outcome = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ kind: "timeout" }), 8_000);
            ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "auth", token: "definitely-bogus" })));
            ws.on("message", (data) => {
                try {
                    const frame = JSON.parse(data.toString());
                    if (frame.type === "error") {
                        clearTimeout(timer);
                        resolve({ kind: "error", code: frame.payload?.code });
                    }
                } catch {
                    /* ignore */
                }
            });
            ws.on("close", (code) => {
                clearTimeout(timer);
                resolve({ kind: "close", code });
            });
        });
        ctx.check("WS with a bogus token is rejected", outcome.kind !== "timeout", {
            expected: "error frame or close",
            observed: outcome,
        });
    } finally {
        try {
            ws.terminate();
        } catch {
            /* ignore */
        }
    }
});

// ---------------------------------------------------------------------------
// A13 — console login (local browser handoff)
// ---------------------------------------------------------------------------

scenario("A13", "Console login handoff", async (ctx) => {
    const session = () => http("POST", "/api/v1/console/session", { token: CLI_TOKEN });

    const first = await session();
    ctx.eq("POST /api/v1/console/session → 200", first.status, 200);
    const token = first.json?.token;
    const url = typeof first.json?.url === "string" ? first.json.url : "";
    const deviceId = first.json?.device?.id;

    ctx.eq("the session names the local-browser device", first.json?.device?.name, "local browser");
    ctx.eq("the local-browser device is a laptop", first.json?.device?.kind, "laptop");
    ctx.eq("the local-browser device holds every scope", first.json?.device?.scopes, [
        "read",
        "steer",
        "control",
        "admin",
    ]);
    ctx.check("the handoff url puts the token in the fragment", /\/#t=[A-Za-z0-9_-]{20,}$/.test(url), {
        expected: "http://127.0.0.1:<port>/#t=<token>",
        observed: url.replace(/#t=.{6}.*/, "#t=<redacted>"),
    });
    ctx.check("the handoff url never carries the token in the query string", !url.includes("?t="), {
        expected: "no ?t=",
        observed: url.replace(/#t=.{6}.*/, "#t=<redacted>"),
    });
    ctx.check("the handoff url targets loopback", url.startsWith("http://127.0.0.1:"), {
        expected: "http://127.0.0.1:<port>/#t=…",
        observed: url.replace(/#t=.{6}.*/, "#t=<redacted>"),
    });

    const used = await http("GET", "/api/v1/workspaces", { token });
    ctx.eq("the handed-off token authenticates → 200", used.status, 200);

    // `:PiWeb` twice must not log the tab that is already open out.
    const second = await session();
    ctx.eq("a second login reuses the same token", second.json?.token, token);
    const stillUsed = await http("GET", "/api/v1/workspaces", { token });
    ctx.eq("the first tab keeps working after a second :PiWeb", stillUsed.status, 200);

    const anonymous = await http("POST", "/api/v1/console/session");
    ctx.eq("no cli token → 401", anonymous.status, 401);
    const asDevice = await http("POST", "/api/v1/console/session", { token });
    ctx.eq("a device token cannot mint another console session", asDevice.status, 401);

    const devices = await http("GET", "/api/v1/devices", { token: CLI_TOKEN });
    const browsers = (Array.isArray(devices.json) ? devices.json : []).filter(
        (device) => device?.name === "local browser",
    );
    ctx.eq("exactly one local-browser device exists", browsers.length, 1);

    // Revocation drops the stored plaintext, so the next login mints a new token.
    const revoked = await http("DELETE", `/api/v1/devices/${encodeURIComponent(deviceId)}`, { token: CLI_TOKEN });
    ctx.eq("revoking the local browser → 204", revoked.status, 204);
    const afterRevoke = await session();
    ctx.check("the next login mints a new token", afterRevoke.status === 200 && afterRevoke.json?.token !== token, {
        expected: "200 with a different token",
        observed: { status: afterRevoke.status, sameToken: afterRevoke.json?.token === token },
    });
    const deadToken = await http("GET", "/api/v1/workspaces", { token });
    ctx.eq("the revoked token is rejected → 401", deadToken.status, 401);
    const freshToken = await http("GET", "/api/v1/workspaces", { token: afterRevoke.json?.token });
    ctx.eq("the new token works → 200", freshToken.status, 200);
});

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function tailOf(path, lines = 80) {
    try {
        const text = readFileSync(path, "utf8");
        const split = text.trimEnd().split("\n");
        return split.slice(-lines).join("\n");
    } catch {
        return null;
    }
}

function findLogs(root, depth = 3, acc = []) {
    if (depth < 0) return acc;
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git") continue;
            findLogs(path, depth - 1, acc);
        } else if (/\.(log|jsonl)$/.test(entry.name) && acc.length < 12) {
            acc.push(path);
        }
    }
    return acc;
}

function collectLogTails() {
    const targets = [];
    const push = (label, path) => {
        const tail = tailOf(path);
        if (tail) targets.push({ label, path, tail });
    };
    push("daemon", join(E2E_ROOT, "logs", "daemon.log"));
    push("daemon.stdout", join(E2E_ROOT, "logs", "daemon.stdout"));
    for (const path of findLogs(join(STATE_DIR, "instances"))) push(`instance ${path.split("/").slice(-2).join("/")}`, path);
    for (const path of findLogs(STATE_DIR)) {
        if (targets.some((target) => target.path === path)) continue;
        if (/pi2-web|pi2-daemon|instance/.test(path)) push(`state ${path.split("/").slice(-2).join("/")}`, path);
    }
    return targets;
}

function renderSummaryMarkdown(results, counts, durationMs) {
    const lines = [];
    lines.push("# A0–A12 API/WS suite");
    lines.push("");
    lines.push(`- base: \`${BASE}\``);
    lines.push(`- root: \`${E2E_ROOT}\``);
    lines.push(`- duration: ${(durationMs / 1000).toFixed(1)}s`);
    lines.push(`- result: **PASS ${counts.pass} · FAIL ${counts.fail} · SKIP ${counts.skip}** (of ${counts.total})`);
    lines.push("");
    lines.push("| scenario | status | duration | evidence |");
    lines.push("|---|---|---|---|");
    for (const result of results) {
        const evidence = [];
        if (result.failure) evidence.push(`first failure: ${result.failure.name} (expected ${fmt(result.failure.expected, 120)} · observed ${fmt(result.failure.observed, 120)})`);
        if (result.skipReason) evidence.push(result.skipReason);
        for (const note of result.notes.slice(0, 4)) evidence.push(note.replace(/\|/g, "\\|"));
        lines.push(
            `| ${result.id} ${result.title.replace(/\|/g, "\\|")} | ${result.status} | ${(result.durationMs / 1000).toFixed(1)}s | ${evidence.join("<br>").replace(/\n/g, " ")} |`,
        );
    }
    lines.push("");
    if (DEVIATIONS.size) {
        lines.push("## Suspected product bugs / contract deviations");
        lines.push("");
        let index = 0;
        for (const [key, entry] of DEVIATIONS) {
            index += 1;
            lines.push(`${index}. **${entry.title}** (\`${key}\`, seen in ${[...entry.scenarios].join(", ") || "suite"})`);
            lines.push(`   ${entry.detail}`);
        }
        lines.push("");
    }
    lines.push("## Reproduction");
    lines.push("");
    lines.push("```bash");
    lines.push(`cd "${REPO_ROOT}" && E2E_SKIP_BUILD=1 bash scripts/e2e/run-api.sh`);
    lines.push("```");
    return `${lines.join("\n")}\n`;
}

function renderReconMarkdown(results, counts, durationMs, logs) {
    const lines = [];
    lines.push("# pi2 daemon API/WS E2E (A0–A12) — run report");
    lines.push("");
    lines.push(`- driver: \`${join(dirname(fileURLToPath(import.meta.url)), "api-e2e.mjs")}\``);
    lines.push(`- base: \`${BASE}\` · root: \`${E2E_ROOT}\``);
    lines.push(`- ran: ${new Date().toISOString()} · duration: ${(durationMs / 1000).toFixed(1)}s`);
    lines.push(`- result: **PASS ${counts.pass} · FAIL ${counts.fail} · SKIP ${counts.skip}**`);
    lines.push("");
    for (const result of results) {
        lines.push(`## ${result.id} — ${result.title} — ${result.status} (${(result.durationMs / 1000).toFixed(1)}s)`);
        lines.push("");
        if (result.skipReason) {
            lines.push(`SKIP: ${result.skipReason}`);
            lines.push("");
        }
        if (result.failure) {
            lines.push("First failing assertion:");
            lines.push("");
            lines.push("```");
            lines.push(`assertion: ${result.failure.name}`);
            lines.push(`expected : ${fmt(result.failure.expected, 800)}`);
            lines.push(`observed : ${fmt(result.failure.observed, 800)}`);
            lines.push("```");
            lines.push("");
        }
        const failed = result.checks.filter((check) => !check.ok);
        if (failed.length > 1) {
            lines.push("Other failing/warn checks:");
            lines.push("");
            for (const check of failed.slice(1)) {
                lines.push(`- ${check.severity === "warn" ? "WARN" : "FAIL"} **${check.name}** — expected ${fmt(check.expected, 200)} · observed ${fmt(check.observed, 200)}`);
            }
            lines.push("");
        }
        if (result.notes.length) {
            lines.push("Notes:");
            lines.push("");
            for (const note of result.notes) lines.push(`- ${note}`);
            lines.push("");
        }
        if (result.evidence && Object.keys(result.evidence).length) {
            lines.push("Evidence:");
            lines.push("");
            lines.push("```json");
            lines.push(JSON.stringify(result.evidence, null, 2));
            lines.push("```");
            lines.push("");
        }
    }
    if (DEVIATIONS.size) {
        lines.push("## Suspected product bugs");
        lines.push("");
        let index = 0;
        for (const [key, entry] of DEVIATIONS) {
            index += 1;
            lines.push(`### ${index}. ${entry.title}`);
            lines.push("");
            lines.push(`- key: \`${key}\``);
            lines.push(`- scenarios: ${[...entry.scenarios].join(", ") || "suite"}`);
            lines.push(`- detail: ${entry.detail}`);
            lines.push("");
        }
    }
    lines.push("## Daemon / plugin log tails");
    lines.push("");
    if (!logs.length) {
        lines.push("_no logs found_");
    }
    for (const log of logs) {
        lines.push(`### ${log.label}`);
        lines.push("");
        lines.push(`\`${log.path}\``);
        lines.push("");
        lines.push("```");
        lines.push(log.tail);
        lines.push("```");
        lines.push("");
    }
    return `${lines.join("\n")}\n`;
}

function writeReports(results, counts, durationMs, startedAt) {
    mkdirSync(REPORT_DIR, { recursive: true });
    const logTails = collectLogTails();
    const payload = {
        suite: "api",
        scenarioIds: "A0–A12",
        base: BASE,
        root: E2E_ROOT,
        startedAt: new Date(startedAt).toISOString(),
        durationMs,
        counts,
        deviations: [...DEVIATIONS.entries()].map(([key, entry]) => ({
            key,
            title: entry.title,
            detail: entry.detail,
            scenarios: [...entry.scenarios],
        })),
        scenarios: results,
    };
    writeFileSync(join(REPORT_DIR, "api-results.json"), `${JSON.stringify(payload, null, 2)}\n`);
    writeFileSync(join(REPORT_DIR, "summary.md"), renderSummaryMarkdown(results, counts, durationMs));
    writeFileSync(join(REPORT_DIR, "logs-tails.md"), logTails.map((log) => `## ${log.label}\n\n\`${log.path}\`\n\n\`\`\`\n${log.tail}\n\`\`\`\n`).join("\n"));
    try {
        mkdirSync(dirname(RECON_REPORT), { recursive: true });
        writeFileSync(RECON_REPORT, renderReconMarkdown(results, counts, durationMs, logTails));
    } catch (error) {
        console.error(`api-e2e: could not write ${RECON_REPORT}: ${error?.message ?? error}`);
    }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

function printTable(results) {
    const width = results.reduce((max, result) => Math.max(max, result.id.length), 2);
    console.log("");
    console.log("scenario  status  duration  notes");
    console.log("--------  ------  --------  -----");
    for (const result of results) {
        const detail = result.skipReason
            ? result.skipReason
            : result.failure
              ? `${result.failure.name} (expected ${fmt(result.failure.expected, 80)} · observed ${fmt(result.failure.observed, 80)})`
              : result.notes[0] ?? "";
        console.log(
            `${result.id.padEnd(width)}  ${result.status.padEnd(6)}  ${(result.durationMs / 1000).toFixed(1).padStart(7)}s  ${String(detail).slice(0, 160)}`,
        );
    }
}

async function runScenario(definition, budgetDeadline) {
    const ctx = new Ctx(definition.id, definition.title);
    CURRENT = ctx;
    const started = Date.now();
    const result = {
        id: definition.id,
        title: definition.title,
        status: "PASS",
        durationMs: 0,
        checks: ctx.checks,
        notes: ctx.notes,
        evidence: ctx.evidence,
        failure: null,
        skipReason: null,
    };

    if (Date.now() > budgetDeadline) {
        result.status = "SKIP";
        result.skipReason = "total runtime budget exhausted before the scenario started";
        result.durationMs = 0;
        CURRENT = null;
        return result;
    }

    try {
        await withTimeout(Promise.resolve(definition.fn(ctx)), definition.timeoutMs, `${definition.id} scenario`);
    } catch (error) {
        if (error instanceof SkipScenario) {
            result.status = "SKIP";
            result.skipReason = error.reason;
        } else {
            result.status = "FAIL";
            ctx.check("scenario completed without throwing", false, {
                expected: "no exception",
                observed: error instanceof TimeoutError ? error.message : `${error?.name ?? "Error"}: ${error?.message ?? error}`,
            });
        }
    } finally {
        await closeAllSockets().catch(() => {});
        result.durationMs = Date.now() - started;
        result.checks = ctx.checks;
        result.notes = ctx.notes;
        result.evidence = ctx.evidence;
        result.failure = ctx.failures()[0] ?? null;
        if (result.status === "PASS" && result.failure) result.status = "FAIL";
        if (result.status === "FAIL" && !result.failure && ctx.warns().length === 0) {
            result.failure = { name: "unknown", expected: "no failure", observed: "scenario failed" };
        }
        CURRENT = null;
    }
    return result;
}

async function main() {
    const startedAt = Date.now();
    const budgetDeadline = startedAt + TOTAL_BUDGET_MS;
    const results = [];

    console.log(`api-e2e: ${BASE} (driver ${process.version}, ws module ${require.resolve("ws")})`);
    let ready = false;
    try {
        const health = await http("GET", "/api/v1/health", { token: CLI_TOKEN });
        ready = health.status === 200;
    } catch {
        ready = false;
    }
    if (!ready) {
        console.error(`api-e2e: daemon is not answering ${BASE}/api/v1/health`);
        process.exitCode = 1;
        return;
    }

    for (const definition of SCENARIOS) {
        const result = await runScenario(definition, budgetDeadline);
        results.push(result);
        console.log(
            `[${result.id}] ${result.status} (${(result.durationMs / 1000).toFixed(1)}s)${result.skipReason ? ` — ${result.skipReason}` : ""}`,
        );
        for (const note of result.notes) console.log(`      · ${note}`);
    }

    const durationMs = Date.now() - startedAt;
    const counts = {
        total: results.length,
        pass: results.filter((result) => result.status === "PASS").length,
        fail: results.filter((result) => result.status === "FAIL").length,
        skip: results.filter((result) => result.status === "SKIP").length,
    };
    printTable(results);
    console.log(`\nPASS ${counts.pass} · FAIL ${counts.fail} · SKIP ${counts.skip} (of ${counts.total}) in ${(durationMs / 1000).toFixed(1)}s`);
    console.log(`report: ${join(REPORT_DIR, "summary.md")}`);
    if (DEVIATIONS.size) {
        console.log("\nSuspected product bugs:");
        let index = 0;
        for (const [key, entry] of DEVIATIONS) {
            index += 1;
            console.log(`  ${index}. ${entry.title} [${key}]`);
        }
    }

    writeReports(results, counts, durationMs, startedAt);
    process.exitCode = counts.fail > 0 ? 1 : 0;
    await closeAllSockets();
}

process.on("unhandledRejection", (reason) => {
    console.error(`api-e2e: unhandled rejection: ${reason?.stack ?? reason}`);
});

main()
    .catch((error) => {
        console.error(`api-e2e: fatal: ${error?.stack ?? error}`);
        process.exitCode = 1;
    })
    .finally(() => {
        // Give stdout a tick to flush, then leave; every socket is closed by then.
        setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
    });
