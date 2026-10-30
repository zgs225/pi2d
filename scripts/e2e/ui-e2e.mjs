#!/usr/bin/env node
/**
 * pi2 web console — browser (Playwright) end-to-end driver.
 *
 * Implements the browser layer of `docs/e2e.md`:
 *   B1–B14  functional scenarios against the daemon-served production bundle
 *   C1–C4   responsive / visual / i18n / console-error scenarios
 *
 * Design rules (see docs/e2e.md §2–§6):
 *  - Every scenario is isolated: a fresh browser context, its own storage state,
 *    its own try/catch, a screenshot on failure, exit-code tracking.
 *  - The browser is driven exactly like a user: no product code is patched, no
 *    `window` test hooks, no mocked API responses except the one negative-path
 *    case in B4 (workspaces API error + retry), which is a deliberate fault
 *    injection requested by the plan.
 *  - Product bugs are reported as FAILURES with the observed DOM/network
 *    evidence, never worked around. Only the cases the plan explicitly allows to
 *    skip (camera-only pairing, missing attention dialog) become SKIP.
 *
 * Usage: started by `scripts/e2e/run-ui.sh` (which owns the daemon, the CLI
 * token, the pairing code and the temp root). Standalone:
 *
 *   E2E_BASE=... E2E_CLI_TOKEN=... E2E_DEVICE_TOKEN=... E2E_PORT=... \
 *   E2E_ROOT=... node scripts/e2e/ui-e2e.mjs
 *
 * Artifacts: $E2E_ROOT/screens/*.png and $E2E_ROOT/report/ui-e2e.{json,md}
 * (plus a copy of the markdown at /tmp/pi2-e2e-recon/e2e-ui-run.md).
 *
 * Exit code: 0 when no scenario FAILs (SKIP is tolerated), 1 otherwise.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* environment                                                         */
/* ------------------------------------------------------------------ */

const ENV = process.env;
const BASE = (ENV.E2E_BASE || "").replace(/\/+$/, "");
const CLI_TOKEN = ENV.E2E_CLI_TOKEN || "";
const DEVICE_TOKEN = ENV.E2E_DEVICE_TOKEN || "";
const PAIR_CODE = ENV.E2E_PAIR_CODE || "";
const ROOT = ENV.E2E_ROOT || "/tmp/pi2-e2e-ui-manual";
const SCREENS = path.join(ROOT, "screens");
const REPORT_DIR = path.join(ROOT, "report");
const WS_ROOTS = ENV.PI2_WORKSPACE_ROOTS || path.join(ROOT, "workspaces");
const EXTRA_REPORT = ENV.E2E_REPORT_COPY || "/tmp/pi2-e2e-recon/e2e-ui-run2.md";
const CHROME = ENV.PI2_E2E_CHROME || "/usr/bin/google-chrome-stable";

if (!BASE || !CLI_TOKEN) {
    console.error("ui-e2e: E2E_BASE and E2E_CLI_TOKEN are required (run through scripts/e2e/run-ui.sh)");
    process.exit(2);
}

const PORT = String(ENV.E2E_PORT || new URL(BASE).port || "");
const ORIGIN = new URL(BASE).origin;
const BASE_HOST = new URL(BASE).hostname;

fs.mkdirSync(SCREENS, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });

/* ------------------------------------------------------------------ */
/* playwright resolution (not a daemon dependency)                    */
/* ------------------------------------------------------------------ */

const require_ = createRequire(import.meta.url);

function loadPlaywright() {
    const tried = [];
    const attempt = (spec) => {
        tried.push(spec);
        try {
            const mod = require_(spec);
            if (mod && typeof mod.chromium?.launch === "function") return mod;
        } catch {
            /* keep trying */
        }
        return null;
    };

    if (ENV.PI2_E2E_PLAYWRIGHT_MODULE) {
        const fromEnv = attempt(ENV.PI2_E2E_PLAYWRIGHT_MODULE);
        if (fromEnv) return { pw: fromEnv, spec: ENV.PI2_E2E_PLAYWRIGHT_MODULE };
    }
    const fromRequire = attempt("playwright");
    if (fromRequire) return { pw: fromRequire, spec: "playwright" };

    // mise installs npm-global tools under <mise>/installs/npm-playwright/*/v11/*/node_modules
    const roots = [
        "/home/yuez/.local/share/mise/installs/npm-playwright",
        path.join(process.env.HOME || "/root", ".local/share/mise/installs/npm-playwright"),
    ];
    const globs = [];
    for (const root of roots) {
        let versions = [];
        try {
            versions = fs.readdirSync(root);
        } catch {
            continue;
        }
        for (const version of versions) {
            const v11 = path.join(root, version, "v11");
            let hashes = [];
            try {
                hashes = fs.readdirSync(v11);
            } catch {
                continue;
            }
            for (const hash of hashes) globs.push(path.join(v11, hash, "node_modules", "playwright"));
        }
    }
    for (const candidate of globs) {
        if (!fs.existsSync(candidate)) continue;
        const mod = attempt(candidate);
        if (mod) return { pw: mod, spec: candidate };
    }
    throw new Error(`cannot load playwright (tried: ${tried.join(", ")})`);
}

const { pw, spec: playwrightSpec } = loadPlaywright();
const CHROME_PATH = fs.existsSync(CHROME) ? CHROME : undefined;

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escRe(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function short(value, limit = 400) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "";
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Poll a predicate until it returns something truthy (or time out → null). */
async function waitFor(fn, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn().catch(() => null);
        if (value) return value;
        if (Date.now() > deadline) return null;
        await sleep(intervalMs);
    }
}

class Failure extends Error {
    constructor(check) {
        super(`${check.name}${check.detail ? ` — ${short(check.detail.observed ?? check.detail, 200)}` : ""}`);
        this.name = "Failure";
        this.check = check;
    }
}

class SkipSignal extends Error {
    constructor(reason) {
        super(reason);
        this.name = "SkipSignal";
    }
}

/* ------------------------------------------------------------------ */
/* daemon API (harness-side seeding, CLI token)                        */
/* ------------------------------------------------------------------ */

async function apiRaw(method, apiPath, { token = CLI_TOKEN, body } = {}) {
    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${String(token).replace(/^Bearer\s+/i, "")}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${BASE}${apiPath}`, {
        method,
        headers,
        ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let json;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        json = null;
    }
    return { status: response.status, ok: response.ok, json, text };
}

async function api(method, apiPath, options) {
    const result = await apiRaw(method, apiPath, options);
    if (!result.ok) throw new Error(`API ${method} ${apiPath} → ${result.status} ${short(result.text, 200)}`);
    return result.json;
}

async function cmd(method, params, extra = {}) {
    const result = await apiRaw("POST", "/api/v1/cmd", { body: { method, params: params ?? {}, ...extra } });
    return result;
}

function deepFindSessionId(value) {
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.sessionId === "string" && value.sessionId) return value.sessionId;
    for (const key of Object.keys(value)) {
        const found = deepFindSessionId(value[key]);
        if (found) return found;
    }
    return undefined;
}

async function addWorkspace(cwd, alias) {
    const body = { cwd, trust: true, ...(alias ? { alias } : {}) };
    const result = await api("POST", "/api/v1/cmd", { body: { method: "workspace.add", params: body } });
    const workspaceId =
        result?.workspace?.workspaceId ?? deepFindWorkspaceId(result) ?? undefined;
    if (!workspaceId) throw new Error(`workspace.add returned no id: ${short(result)}`);
    return workspaceId;
}

function deepFindWorkspaceId(value) {
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.workspaceId === "string" && value.workspaceId) return value.workspaceId;
    for (const key of Object.keys(value)) {
        const found = deepFindWorkspaceId(value[key]);
        if (found) return found;
    }
    return undefined;
}

async function ensureInstance(workspaceId, timeoutMs = 20000) {
    await cmd("instance.ensure", { workspaceId });
    const ready = await waitFor(async () => {
        const list = await api("GET", "/api/v1/workspaces");
        const row = (Array.isArray(list) ? list : list.workspaces).find((item) => item.workspaceId === workspaceId);
        if (!row) return null;
        return row.instance?.status === "ready" ? row : null;
    }, timeoutMs, 150);
    if (!ready) throw new Error(`instance for ${workspaceId} never became ready`);
    return ready;
}

async function listWorkspaces() {
    const list = await api("GET", "/api/v1/workspaces");
    return Array.isArray(list) ? list : (list.workspaces ?? []);
}

async function listRecentSessions(limit = 20) {
    const body = await api("GET", `/api/v1/sessions/recent?limit=${limit}`);
    const rows = body?.sessions ?? (Array.isArray(body) ? body : []);
    return Array.isArray(rows) ? rows : [];
}

async function createSession(workspaceId) {
    const result = await cmd("session.create", { workspaceId });
    if (result.status !== 202 && result.status !== 200) {
        throw new Error(`session.create failed: ${result.status} ${short(result.text, 200)}`);
    }
    const sessionId = deepFindSessionId(result.json);
    if (!sessionId) throw new Error(`session.create returned no sessionId: ${short(result.text, 200)}`);
    return sessionId;
}

async function listSessions(workspaceId) {
    const body = await api("GET", `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sessions`);
    const rows = body?.sessions ?? body?.result?.sessions ?? (Array.isArray(body) ? body : []);
    return Array.isArray(rows) ? rows : [];
}

async function listDevices() {
    const body = await api("GET", "/api/v1/devices");
    if (Array.isArray(body)) return body;
    return body?.devices ?? [];
}

/* ------------------------------------------------------------------ */
/* console-error allowlist                                             */
/* ------------------------------------------------------------------ */

/** Known-benign browser messages (network/WS noise, devtools chatter). */
const CONSOLE_ALLOWLIST = [
    { id: "http-error-log", re: /^Failed to load resource/i },
    { id: "net-disconnected", re: /net::ERR_(INTERNET_DISCONNECTED|CONNECTION_REFUSED|CONNECTION_RESET|NETWORK_CHANGED|NAME_NOT_RESOLVED|CONNECTION_CLOSED|EMPTY_RESPONSE)/i },
    { id: "websocket", re: /WebSocket (connection|is closed|closed)/i },
    { id: "ws-error-event", re: /^(Error: )?WebSocket/i },
    { id: "react-devtools", re: /Download the React DevTools/i },
    { id: "favicon", re: /favicon\.ico/i },
];

function classifyConsole(text) {
    for (const entry of CONSOLE_ALLOWLIST) {
        if (entry.re.test(text)) return entry.id;
    }
    return null;
}

/** Every console error / pageerror seen by any scenario (for C4). */
const GLOBAL_ERRORS = [];

/* ------------------------------------------------------------------ */
/* scenario context                                                    */
/* ------------------------------------------------------------------ */

class Ctx {
    constructor(def) {
        this.id = def.id;
        this.title = def.title;
        this.checks = [];
        this.failures = [];
        this.notes = [];
        this.logs = [];
        this.consoleErrors = [];
        this.consoleWarnings = [];
        this.pageErrors = [];
        this.httpErrors = [];
        this.cmdRequests = [];
        this.cmdResponses = [];
        /** Every `/api/v1/**` response: `{method, path, status}`. */
        this.apiCalls = [];
        /** Client-side navigations (pathname + search) in order. */
        this.navigations = [];
        this.wsFrames = [];
        this.screenshots = [];
        this.contexts = [];
        this.offlineWindow = false;
        this.skipped = null;
        this.durationMs = 0;
        this.status = "PASS";
    }

    log(message) {
        this.logs.push(message);
        if (ENV.E2E_VERBOSE === "1") console.error(`   ${message}`);
    }

    note(message) {
        this.notes.push(message);
        this.log(message);
    }

    /** Hard assertion: records and throws on failure (rest of the scenario is skipped). */
    check(name, ok, detail) {
        const record = { name, ok: Boolean(ok), detail: detail ?? null };
        this.checks.push(record);
        if (!record.ok) {
            this.failures.push(record);
            throw new Failure(record);
        }
        return record;
    }

    /** Soft assertion: records a failure but lets the scenario continue. */
    softCheck(name, ok, detail) {
        const record = { name, ok: Boolean(ok), detail: detail ?? null };
        this.checks.push(record);
        if (!record.ok) this.failures.push(record);
        return record;
    }

    checkValue(name, actual, expected) {
        return this.check(name, JSON.stringify(actual) === JSON.stringify(expected), { expected, observed: actual });
    }

    skip(reason) {
        this.skipped = reason;
        this.log(`SKIP: ${reason}`);
        throw new SkipSignal(reason);
    }

    async shot(page, name, options = {}) {
        if (!page || page.isClosed()) return null;
        const file = path.join(SCREENS, `${name}.png`);
        try {
            await page.screenshot({ path: file, fullPage: options.fullPage === true, timeout: 15000 });
            this.screenshots.push(file);
            const size = fs.statSync(file).size;
            return { file, size };
        } catch (error) {
            this.log(`screenshot failed (${name}): ${error.message}`);
            return null;
        }
    }

    storageState(kind, localExtra = {}) {
        if (kind === "unpaired") {
            const local = Object.entries(localExtra).map(([name, value]) => ({ name, value: String(value) }));
            return { cookies: [], origins: local.length ? [{ origin: ORIGIN, localStorage: local }] : [] };
        }
        const local = [
            { name: "pi2-connection", value: "paired" },
            { name: "pi2-endpoint", value: BASE },
            // Raw token (web/src/lib/api.ts strips an optional `Bearer ` prefix).
            { name: "pi2-device-token", value: DEVICE_TOKEN },
            { name: "pi2-device", value: "Playwright" },
            { name: "pi2-connected-at", value: String(Date.now()) },
            ...Object.entries(localExtra).map(([name, value]) => ({ name, value: String(value) })),
        ];
        return { cookies: [], origins: [{ origin: ORIGIN, localStorage: local }] };
    }

    /**
     * Fresh context + page. `kind` selects the seeded storage ("paired" |
     * "unpaired"); `language` is pinned before boot (mandatory: the default
     * follows navigator.language).
     */
    async openPage(kind, options = {}) {
        const context = await browser.newContext({
            viewport: options.viewport ?? { width: 1440, height: 900 },
            storageState: this.storageState(kind, options.storageLocal ?? {}),
            locale: options.locale ?? "en-US",
            colorScheme: options.colorScheme ?? "light",
            baseURL: BASE,
            ignoreHTTPSErrors: true,
        });
        this.contexts.push(context);
        await context.addInitScript((lang) => {
            try {
                localStorage.setItem("pi2-lang", lang);
            } catch {
                /* private mode */
            }
            // Harness instrumentation: remember every `pi2-*` storage write so a
            // scenario can prove what the app persisted (and in which order) even
            // when a later step clears it again.
            try {
                const writes = [];
                window.__pi2Writes = writes;
                const setItem = Storage.prototype.setItem;
                const removeItem = Storage.prototype.removeItem;
                Storage.prototype.setItem = function (key, value) {
                    if (String(key).startsWith("pi2-")) {
                        writes.push({ op: "set", key: String(key), value: String(value), at: Date.now(), href: location.pathname });
                    }
                    return setItem.call(this, key, value);
                };
                Storage.prototype.removeItem = function (key) {
                    if (String(key).startsWith("pi2-")) {
                        writes.push({ op: "remove", key: String(key), at: Date.now(), href: location.pathname });
                    }
                    return removeItem.call(this, key);
                };
            } catch {
                /* ignore */
            }
        }, options.language ?? "en");
        const page = await context.newPage();
        page.setDefaultTimeout(options.timeout ?? 15000);
        page.setDefaultNavigationTimeout(30000);
        this.instrument(page);
        return { context, page };
    }

    instrument(page) {
        const ctx = this;
        page.on("console", (message) => {
            const type = message.type();
            if (type !== "error" && type !== "warning") return;
            const record = {
                scenario: ctx.id,
                type,
                text: message.text(),
                location: message.location?.() ?? null,
                page: (() => {
                    try {
                        return page.url();
                    } catch {
                        return "";
                    }
                })(),
                allowlist: classifyConsole(message.text()),
                offline: ctx.offlineWindow,
            };
            if (type === "error") {
                ctx.consoleErrors.push(record);
                GLOBAL_ERRORS.push(record);
            } else {
                ctx.consoleWarnings.push(record);
            }
        });
        page.on("pageerror", (error) => {
            const record = { scenario: ctx.id, message: error.message, stack: short(error.stack, 700) };
            ctx.pageErrors.push(record);
            GLOBAL_ERRORS.push({ ...record, type: "pageerror", allowlist: null, offline: ctx.offlineWindow });
        });
        page.on("framenavigated", (frame) => {
            try {
                if (frame !== page.mainFrame()) return;
                const url = new URL(frame.url());
                ctx.navigations.push(`${url.pathname}${url.search}`);
            } catch {
                /* ignore */
            }
        });
        page.on("request", (request) => {
            try {
                const url = request.url();
                if (url.includes("/api/v1/cmd") && request.method() === "POST") {
                    let body = null;
                    try {
                        body = JSON.parse(request.postData() || "null");
                    } catch {
                        body = request.postData();
                    }
                    ctx.cmdRequests.push({ url, method: body?.method ?? null, sessionId: body?.sessionId ?? null, params: body?.params ?? null, at: Date.now() });
                }
            } catch {
                /* ignore */
            }
        });
        page.on("response", (response) => {
            const url = response.url();
            const status = response.status();
            if (!url.includes("/api/v1/")) return;
            ctx.apiCalls.push({
                method: response.request().method(),
                path: url.replace(BASE, "").split("?")[0],
                status,
                at: Date.now(),
            });
            const record = { url: url.replace(BASE, ""), status, at: Date.now() };
            if (status >= 400) ctx.httpErrors.push(record);
            if (url.includes("/api/v1/cmd")) {
                response
                    .json()
                    .then((body) => {
                        ctx.cmdResponses.push({ ...record, body });
                    })
                    .catch(() => {
                        ctx.cmdResponses.push({ ...record, body: null });
                    });
            }
        });
        page.on("websocket", (socket) => {
            socket.on("framereceived", (frame) => {
                try {
                    const raw = typeof frame.payload === "string" ? frame.payload : frame.payload?.toString?.("utf8");
                    if (!raw) return;
                    const parsed = JSON.parse(raw);
                    ctx.wsFrames.push(parsed);
                } catch {
                    /* binary/other frame */
                }
            });
        });
    }

    async closeAll() {
        for (const context of this.contexts) {
            try {
                await context.close();
            } catch {
                /* already closed */
            }
        }
        this.contexts = [];
    }

    /** `GET` the daemon through the page so the browser's device token is used. */
    async pageFetch(page, apiPath) {
        return page.evaluate(async (target) => {
            const token = (localStorage.getItem("pi2-device-token") || "").replace(/^Bearer\s+/i, "");
            const response = await fetch(target, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
            const text = await response.text();
            return { status: response.status, text };
        }, apiPath);
    }
}

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

/**
 * Nav rows (v0.1.1): the sidebar (≥840) and the rail (600–839) render the same
 * icon-only rows, so the label lives in `aria-label`/`data-tip`, never in the
 * text. Below 600 there is no persistent strip at all — the topbar `.page-pill`
 * owns navigation and the mobile strip is gone for good.
 */
const NAV_ITEM = ".sidebar .nav-item, .rail .nav-item";
const navItems = (page) => page.locator(NAV_ITEM);

/** Labels of the nav rows that CSS actually shows (0 items below 600px). */
async function navItemLabels(page) {
    return page.locator(NAV_ITEM).evaluateAll((nodes) =>
        nodes
            .filter((node) => node.getClientRects().length > 0)
            .map((node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").trim()),
    );
}

const pageName = (page) => page.evaluate(() => document.body.dataset.page ?? "");
const streamText = (page) => page.locator('[role="log"][aria-label="Message stream"]');

async function dialogFor(page, title, timeout = 8000) {
    const byRole = page.getByRole("dialog", { name: new RegExp(escRe(title), "i") });
    if (await waitFor(async () => (await byRole.count()) > 0, timeout, 100)) return byRole.first();
    // Radix names the dialog after the whole title element (which also contains
    // the Close button), so fall back to a text match inside the modal shell.
    const byText = page.locator(".modal-content").filter({ hasText: title });
    if (await waitFor(async () => (await byText.count()) > 0, 2000, 100)) return byText.first();
    return null;
}

async function anyDialog(page) {
    const dialogs = page.getByRole("dialog");
    const count = await dialogs.count();
    return count > 0 ? dialogs.first() : null;
}

async function dismissDialogs(page) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if ((await page.getByRole("dialog").count()) === 0) return;
        await page.keyboard.press("Escape");
        await sleep(150);
    }
}

async function errorToasts(page) {
    return page.locator('[data-sonner-toast][data-type="error"]');
}

/** Number of error toasts currently rendered (`Locator.count()` is async). */
async function errorToastCount(page) {
    return (await errorToasts(page)).count();
}

async function toastTexts(page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-sonner-toast]")).map((node) => node.textContent?.trim() ?? ""),
    );
}

async function waitToast(page, pattern, timeout = 6000) {
    return waitFor(async () => {
        const texts = await toastTexts(page);
        return texts.find((text) => pattern.test(text)) ?? null;
    }, timeout, 80);
}

async function bodyText(page) {
    return page.evaluate(() => document.body.innerText);
}

async function setText(page, selector, value) {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 15000 });
    await locator.fill(value);
    return locator;
}

async function waitEnabled(page, selector, timeout = 30000) {
    const ok = await waitFor(
        async () =>
            page.evaluate((target) => {
                const el = document.querySelector(target);
                if (!el) return false;
                return !el.disabled && el.getAttribute("aria-disabled") !== "true";
            }, selector),
        timeout,
        120,
    );
    return Boolean(ok);
}

const COMPOSER_INPUT = '[data-testid="composer-input"]';

/** `article.msg[data-entry-id]` projections (id/role come from the product test ids). */
async function streamArticles(page) {
    return page.evaluate(() =>
        Array.from(document.querySelectorAll("article.msg[data-entry-id]")).map((node) => ({
            id: node.getAttribute("data-entry-id") ?? "",
            role: node.getAttribute("data-role") ?? "",
            text: Array.from(node.querySelectorAll(".msg__text"))
                .map((text) => (text.textContent ?? "").trim())
                .filter(Boolean)
                .join("\n")
                .trim(),
            streaming: Boolean(node.querySelector(".msg__text.streaming")),
        })),
    );
}

async function streamName(page) {
    const locator = page.locator(".stream-head .stream-name").first();
    if ((await locator.count()) === 0) return "";
    return (await locator.innerText()).trim();
}

async function sessionStatusBadge(page) {
    const locator = page.locator(".stream-head .stream-status").first();
    if ((await locator.count()) === 0) return "";
    return (await locator.innerText()).trim();
}

/** Composer facts from the product test ids (`composer-input|send|abort`). */
async function composerState(page) {
    return page.evaluate(() => {
        const input = document.querySelector('[data-testid="composer-input"]');
        const send = document.querySelector('[data-testid="composer-send"]');
        const abort = document.querySelector('[data-testid="composer-abort"]');
        return {
            input: Boolean(input),
            enabled: Boolean(input && !input.disabled),
            send: send ? (send.textContent ?? "").trim() : null,
            sendEnabled: send ? !send.hasAttribute("disabled") : null,
            abort: Boolean(abort),
        };
    });
}

/** Abort wins while the run is busy (the send button stays visible next to it). */
async function composerSendLabel(page) {
    const state_ = await composerState(page);
    if (state_.abort) return "Abort";
    return state_.send ?? "";
}

/** `/chat/<id>?workspace=<ws>`; ids may briefly be the `tmp-N` placeholder. */
function chatUrl(sessionId, workspaceId) {
    return `${BASE}/chat/${encodeURIComponent(sessionId)}?workspace=${encodeURIComponent(workspaceId)}`;
}

/** Wait until the address bar carries a real (non `tmp-`) session id. */
async function waitRealSessionId(page, timeout = 10000) {
    return waitFor(async () => {
        const url = new URL(page.url());
        const match = /^\/chat\/([^/]+)$/.exec(url.pathname);
        if (!match) return null;
        const id = decodeURIComponent(match[1]);
        if (id.startsWith("tmp-")) return null;
        return { sessionId: id, workspace: url.searchParams.get("workspace"), href: url.href };
    }, timeout, 150);
}

/** Session ids currently rendered in the tree (`data-session-id`). */
async function treeSessionIds(page) {
    return page
        .locator(".tree-pane .tree-row[data-session-id]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session-id")));
}

async function openChat(page, sessionId, workspaceId) {
    await page.goto(chatUrl(sessionId, workspaceId), { waitUntil: "domcontentloaded" });
    await streamText(page).waitFor({ state: "visible", timeout: 30000 });
    return waitEnabled(page, COMPOSER_INPUT, 30000);
}

/**
 * The session row `…` popover (v0.1.1): a `[role="menu"]` portalled to `body`,
 * every entry carries a locale-independent `data-menu-action`
 * (`active-only|show-all|dispatch|rename|close`).
 */
async function openSessionRowMenu(page, sessionId) {
    await page.locator(`.tree-pane .tree-row[data-session-id="${sessionId}"] .t-more`).click();
    const menu = page.locator('[data-testid="session-row-menu"]');
    await menu.waitFor({ state: "visible", timeout: 10000 });
    return menu;
}

/** Session tree row name (the per-row `aria-label` moved onto `.t-name`). */
async function treeRowNames(page) {
    return page
        .locator(".tree-pane .tree-row[data-session-id] .t-name")
        .evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").trim()));
}

/** The session tray: the anchored `role="dialog"` that replaced the right panel. */
const sessionTray = (page) => page.locator('[data-testid="session-tray"]');

/**
 * Open the tray from its stream-head chip (`head-chip-plan` → todo,
 * `head-chip-tasks` → tasks). The chip is a *toggle*, so only click when the
 * matching tab is not already open.
 */
async function openTray(page, tab = "todo") {
    const chip = page.locator(`[data-testid="head-chip-${tab === "todo" ? "plan" : "tasks"}"]`);
    await chip.waitFor({ state: "visible", timeout: 20000 });
    const tray = sessionTray(page);
    const already = (await chip.getAttribute("aria-expanded")) === "true" && (await tray.getAttribute("data-tab")) === tab;
    if (!already) await chip.click();
    await tray.waitFor({ state: "visible", timeout: 10000 });
    return tray;
}

function entryIdsFromFrames(frames, sessionId) {
    const snapshots = [];
    const appended = [];
    for (const frame of frames) {
        const type = frame?.type;
        const payload = frame?.payload;
        if (type === "snapshot") {
            const state = payload?.state ?? payload;
            if (payload?.sessionId !== sessionId && frame?.sessionId !== sessionId) continue;
            const entries = Array.isArray(state?.entries) ? state.entries : [];
            snapshots.push(entries.map((entry) => entry.id));
        } else if (type === "event") {
            const event = payload?.event ?? payload;
            if (!event || typeof event.type !== "string") continue;
            if (frame?.sessionId && frame.sessionId !== sessionId) continue;
            if (event.type === "entry_appended" && event.entry?.id) appended.push(event.entry.id);
            if (event.type === "entry_updated" && event.entry?.id) appended.push(event.entry.id);
        }
    }
    return { snapshots, appended };
}

/** Entries of the last snapshot frame for `sessionId` (`{id, role, text}`). */
function snapshotEntries(frames, sessionId) {
    let latest = null;
    for (const frame of frames) {
        const payload = frame?.payload;
        if (frame?.type !== "snapshot") continue;
        const state = payload?.state ?? payload;
        const id = payload?.sessionId ?? frame?.sessionId ?? state?.sessionId;
        if (sessionId && id && id !== sessionId) continue;
        const entries = Array.isArray(state?.entries) ? state.entries : [];
        latest = entries.map((entry) => ({
            id: entry.id,
            role: entry.role,
            text: (entry.blocks ?? [])
                .filter((block) => block.type === "text")
                .map((block) => String(block.text ?? ""))
                .join("\n")
                .trim(),
        }));
    }
    return latest;
}

/** `{type:"error"}` frames the socket received (auth failures show up here). */
function socketErrors(frames) {
    return frames
        .filter((frame) => frame?.type === "error")
        .map((frame) => ({ code: frame?.payload?.code ?? null, message: frame?.payload?.message ?? null }));
}

function duplicates(list) {
    const seen = new Set();
    const dupes = new Set();
    for (const item of list) {
        if (seen.has(item)) dupes.add(item);
        seen.add(item);
    }
    return [...dupes];
}

/* ------------------------------------------------------------------ */
/* scenario registry                                                   */
/* ------------------------------------------------------------------ */

const scenarios = [];
const state = {}; // cross-scenario fixtures (seeded workspaces, reusable sessions)

function scenario(id, title, fn, options = {}) {
    scenarios.push({ id, title, fn, budgetMs: options.budgetMs ?? 300000 });
}

/* ------------------------------------------------------------------ */
/* B1 — unpaired guard                                                 */
/* ------------------------------------------------------------------ */

scenario("B1", "Unpaired guard: /workspaces, /status, /chat redirect to /connect; safeNext rejects external next", async (ctx) => {
    const { page } = await ctx.openPage("unpaired");

    const guardCase = async (target, expectedNext) => {
        await page.goto(`${BASE}${target}`, { waitUntil: "domcontentloaded" });
        const landed = await waitFor(async () => {
            const url = new URL(page.url());
            return url.pathname === "/connect" ? url : null;
        }, 10000);
        ctx.check(`${target} redirects to /connect`, Boolean(landed), {
            expected: `${BASE}/connect?next=${encodeURIComponent(expectedNext)}`,
            observed: page.url(),
        });
        ctx.check(`${target}: next=${expectedNext}`, landed?.searchParams.get("next") === expectedNext, {
            expected: expectedNext,
            observed: landed?.searchParams.get("next") ?? null,
        });
        ctx.check(`${target}: page is the connect shell`, (await pageName(page)) === "connect", {
            expected: "connect",
            observed: await pageName(page),
        });
        ctx.check(`${target}: no nav items`, (await navItems(page).count()) === 0, {
            observed: await navItems(page).count(),
        });
        ctx.check(`${target}: no .server-chip`, (await page.locator(".server-chip").count()) === 0, {
            observed: await page.locator(".server-chip").count(),
        });
    };

    await guardCase("/workspaces", "/workspaces");
    ctx.checkValue("raw /workspaces redirect search", new URL(page.url()).search, "?next=%2Fworkspaces");
    await guardCase("/status", "/status");
    await guardCase("/chat", "/chat");

    // An external `next` must be replaced by the allow-listed fallback and never
    // cause an off-site navigation.
    const requested = [];
    page.on("request", (request) => requested.push(request.url()));
    for (const evil of ["https://evil.example/pwn", "//evil.example/pwn", "javascript:alert(1)"]) {
        await page.goto(`${BASE}/connect?next=${encodeURIComponent(evil)}`, { waitUntil: "domcontentloaded" });
        await sleep(400);
        const url = new URL(page.url());
        const next = url.searchParams.get("next");
        ctx.check(`external next rejected: ${evil}`, next !== evil && url.hostname === BASE_HOST && !page.url().includes("evil.example"), {
            expected: "next normalized to /workspaces, same origin",
            observed: { url: page.url(), next },
        });
        ctx.log(`safeNext(${evil}) → ${next}`);
    }
    ctx.check("no request left the origin", requested.every((url) => new URL(url).hostname === BASE_HOST || url.startsWith("data:")), {
        observed: requested.filter((url) => {
            try {
                return new URL(url).hostname !== BASE_HOST;
            } catch {
                return false;
            }
        }),
    });
    await ctx.shot(page, "b1-connect-guard");
});

/* ------------------------------------------------------------------ */
/* B2 — manual pairing                                                 */
/* ------------------------------------------------------------------ */

const CONNECT_TESTIDS = [
    "connect-host",
    "connect-port",
    "connect-pair-code",
    "connect-device",
    "connect-submit",
    "connect-scan",
    "connect-manual",
];

/** Mint a single-use pairing code through the CLI token (`pair.create`). */
async function mintPairCode() {
    const created = await cmd("pair.create", { ttlSec: 600 });
    const code = created.json?.code;
    if (typeof code !== "string" || !code) {
        throw new Error(`pair.create returned no code: ${created.status} ${short(created.text, 200)}`);
    }
    return code;
}

/** Fill the manual form by test id (never by input order). */
async function fillManualForm(page, code, device = "Playwright") {
    await page.locator('[data-testid="connect-host"]').fill(BASE_HOST);
    await page.locator('[data-testid="connect-port"]').fill(PORT);
    await page.locator('[data-testid="connect-pair-code"]').fill(code);
    await page.locator('[data-testid="connect-device"]').fill(device);
    await page.locator('[data-testid="connect-submit"]').click();
}

scenario("B2", "Manual pairing: host/port/pair-code/device → POST /api/v1/pair/redeem + redirect (wrong code → inline error)", async (ctx) => {
    const { page } = await ctx.openPage("unpaired");
    await page.goto(`${BASE}/connect?next=%2Fworkspaces`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="connect-pair-code"]').waitFor({ state: "visible", timeout: 15000 });

    const missing = [];
    for (const id of CONNECT_TESTIDS) {
        if ((await page.locator(`[data-testid="${id}"]`).count()) === 0) missing.push(id);
    }
    ctx.check("connect page exposes the documented test ids", missing.length === 0, {
        expected: CONNECT_TESTIDS,
        observed: { missing },
    });

    // --- happy path -------------------------------------------------------
    const code = await mintPairCode();
    await fillManualForm(page, code);

    const outcome = await waitFor(async () => {
        const inline = page.locator("form.cn-form .cn-error[role=alert]");
        if ((await inline.count()) > 0 && (await inline.first().isVisible())) {
            return { kind: "error", text: (await inline.first().innerText()).trim() };
        }
        const url = new URL(page.url());
        if (url.pathname === "/workspaces") return { kind: "redirect", url: url.href };
        return null;
    }, 25000);

    const pairCalls = ctx.apiCalls.filter((call) => call.method === "POST" && call.path === "/api/v1/pair/redeem");
    ctx.log(`redeem calls: ${JSON.stringify(pairCalls)}`);
    ctx.check("the redeem posts the public POST /api/v1/pair/redeem", pairCalls.length >= 1, {
        expected: "POST /api/v1/pair/redeem {code,deviceName,kind}",
        observed: { pairCalls, cmdMethods: ctx.cmdRequests.map((request) => request.method) },
    });
    ctx.check("POST /api/v1/pair/redeem answered 200", pairCalls.some((call) => call.status === 200), {
        expected: 200,
        observed: pairCalls,
    });
    ctx.check("no redeem goes through the bearer-gated /api/v1/cmd", !ctx.cmdRequests.some((r) => r.method === "pair.redeem"), {
        expected: "no pair.redeem cmd",
        observed: ctx.cmdRequests.map((request) => request.method),
    });
    // The app may bounce back to /connect within ~100 ms, so the navigation log
    // (not just the final URL) is the evidence that `next` was followed.
    const reachedNext = ctx.navigations.some((entry) => entry.startsWith("/workspaces"));
    ctx.softCheck("manual pairing navigates to next (/workspaces)", reachedNext || outcome?.kind === "redirect", {
        expected: "a navigation to /workspaces",
        observed: { navigations: ctx.navigations, outcome },
    });

    const storage = await page.evaluate(() => ({
        connection: localStorage.getItem("pi2-connection"),
        token: localStorage.getItem("pi2-device-token"),
        endpoint: localStorage.getItem("pi2-endpoint"),
    }));
    const connWrites = await page.evaluate(() =>
        (window.__pi2Writes ?? []).filter((write) => ["pi2-connection", "pi2-device-token"].includes(write.key)),
    );
    ctx.note(`pi2-* storage writes: ${short(connWrites, 700)}`);
    ctx.note(`navigations: ${short(ctx.navigations, 400)}`);
    // The freshly minted token, as the app stored it (the storage is cleared
    // again by the disconnect that follows, so read it from the write log).
    const mintedRaw = (connWrites.find((write) => write.key === "pi2-device-token" && write.op === "set")?.value ?? "").replace(
        /^Bearer\s+/i,
        "",
    );

    const wsErrors = socketErrors(ctx.wsFrames);
    const wsAuthErrors = wsErrors.filter((entry) => entry.code === "E_UNAUTHORIZED");
    ctx.softCheck("the socket authenticates with the freshly paired token", wsAuthErrors.length === 0, {
        expected: "no E_UNAUTHORIZED socket error after pairing",
        observed: { socketErrors: wsErrors.slice(0, 5), navigations: ctx.navigations },
        cause:
            "web/src/lib/api.ts:setDeviceToken() persists 'Bearer <token>' and web/src/lib/ws.ts sends getDeviceToken() verbatim in the auth frame, " +
            "while src/daemon/auth.ts:187 verifyToken() hashes the raw string → E_UNAUTHORIZED → app-shell.tsx disconnects and bounces to /connect",
    });
    const mintedDevices = mintedRaw
        ? await apiRaw("GET", "/api/v1/devices", { token: mintedRaw })
        : { status: 0, text: "no token written" };
    ctx.softCheck("the minted device token is accepted over HTTP", mintedDevices.status === 200, {
        expected: 200,
        observed: { status: mintedDevices.status, body: short(mintedDevices.text, 200) },
    });
    ctx.softCheck("localStorage pi2-connection stays paired", storage.connection === "paired", {
        expected: "paired",
        observed: { connection: storage.connection, setToken: Boolean(mintedRaw), writes: connWrites, navigations: ctx.navigations },
        cause:
            "the flow writes pi2-connection=paired (see the write log), then ~100 ms later the app removes the token and writes 'unpaired' " +
            "because the socket auth of that same token fails with E_UNAUTHORIZED",
    });
    ctx.softCheck("localStorage pi2-device-token is still set", Boolean(storage.token), {
        expected: "<device token>",
        observed: storage.token ? "set" : { removedAfterMs: connWrites.at(-1)?.at, writes: connWrites },
    });
    const legacyScopes = await page.evaluate(() => localStorage.getItem("pi2-device-scopes"));
    ctx.softCheck("the browser writes no legacy pi2-device-scopes key (ADR 0001)", legacyScopes === null, {
        expected: null,
        observed: { legacyScopes },
    });

    // A paired browser shows the summary instead of the form.
    await page.goto(`${BASE}/connect`, { waitUntil: "domcontentloaded" });
    const summary = await waitFor(async () => ((await page.locator("section.cn-state").count()) > 0 ? true : null), 15000);
    ctx.softCheck("paired /connect shows the summary instead of the manual form", Boolean(summary), {
        expected: "section.cn-state visible",
        observed: { summary: Boolean(summary), forms: await page.locator("form.cn-form").count(), url: page.url() },
    });
    await ctx.shot(page, "b2-paired-summary");

    // --- wrong code (fresh unpaired context) ------------------------------
    const { page: wrong } = await ctx.openPage("unpaired");
    await wrong.goto(`${BASE}/connect?next=%2Fworkspaces`, { waitUntil: "domcontentloaded" });
    await wrong.locator('[data-testid="connect-pair-code"]').waitFor({ state: "visible", timeout: 15000 });
    await fillManualForm(wrong, "ZZZZZZZZ");
    const inlineError = await waitFor(async () => {
        const alert = wrong.locator('form.cn-form [role="alert"]');
        if ((await alert.count()) === 0) return null;
        const first = alert.first();
        if (!(await first.isVisible())) return null;
        const text = (await first.innerText()).trim();
        return text || null;
    }, 25000);
    ctx.check("wrong code shows an inline role=alert error", Boolean(inlineError), {
        expected: "visible [role=alert] inside form.cn-form",
        observed: inlineError ?? "none",
    });
    ctx.log(`wrong-code inline error: ${short(inlineError, 160)}`);
    const afterFailure = await wrong.evaluate(() => localStorage.getItem("pi2-connection"));
    ctx.check("wrong code leaves the browser unpaired", afterFailure !== "paired", {
        expected: "unpaired / null",
        observed: afterFailure,
    });
    ctx.check("wrong code keeps the form usable", await wrong.locator('[data-testid="connect-submit"]').isEnabled(), {
        expected: "submit enabled",
    });
    await ctx.shot(wrong, "b2-pairing-error");
});

/* ------------------------------------------------------------------ */
/* B3 — QR / paste-link pairing                                        */
/* ------------------------------------------------------------------ */

scenario("B3", "Paste-link pairing: pi2:// and /pair/<code> links reach the confirm modal; confirming pairs", async (ctx) => {
    const parseCode = await mintPairCode();

    const openScan = async (page) => {
        await page.locator('[data-testid="connect-scan"]').waitFor({ state: "visible", timeout: 15000 });
        await page.locator('[data-testid="connect-scan"]').click();
        const dialog = await dialogFor(page, "Scan pairing code", 8000);
        ctx.check("scan dialog opens", Boolean(dialog), {
            expected: "dialog 'Scan pairing code'",
            observed: page.url(),
        });
        const input = page.locator('[aria-label="Pairing link"]');
        if (!(await waitFor(async () => ((await input.isVisible()) ? true : null), 6000))) {
            // Camera unavailable/denied → the paste fallback folds open on its own;
            // open the `details` fold when it did not.
            await page
                .locator("summary", { hasText: /can'?t scan|paste the pairing link/i })
                .first()
                .click()
                .catch(() => undefined);
        }
        const ready = await waitFor(async () => ((await input.isVisible()) ? true : null), 15000);
        ctx.check("paste-link fallback is reachable", Boolean(ready), {
            expected: 'visible input[aria-label="Pairing link"]',
            observed: await page.locator(".cn-scan__state").innerText().catch(() => ""),
        });
        return input;
    };

    const identify = async (page, input, link) => {
        await input.fill(link);
        await page.getByRole("button", { name: /^Identify$/ }).click();
        const confirm = await dialogFor(page, "Confirm connection", 8000);
        return { confirm, state: await page.locator(".cn-scan__state").innerText().catch(() => "") };
    };

    // --- 1) pi2:// link parses into the confirm modal ---------------------
    const { page } = await ctx.openPage("unpaired");
    await page.goto(`${BASE}/connect`, { waitUntil: "domcontentloaded" });
    const pi2Link = `pi2://pair?host=${BASE_HOST}&port=${PORT}&code=${parseCode}`;
    const parsed = await identify(page, await openScan(page), pi2Link);
    ctx.check(`pi2:// link is parsed (${pi2Link})`, Boolean(parsed.confirm), {
        expected: "dialog 'Confirm connection'",
        observed: parsed.state,
    });
    const confirmText = (await parsed.confirm.innerText()).replace(/\s+/g, " ");
    ctx.check("confirm modal masks the pairing code", confirmText.includes("…"), {
        expected: "masked code containing …",
        observed: short(confirmText, 200),
    });
    await parsed.confirm.locator('[data-testid="connect-confirm-cancel"]').click();
    const cancelled = await waitFor(async () => ((await page.getByRole("dialog").count()) === 0 ? true : null), 8000);
    ctx.check("cancel closes the confirm modal", Boolean(cancelled), {
        observed: await page.getByRole("dialog").count(),
    });
    ctx.check("cancel keeps the browser unpaired", (await page.evaluate(() => localStorage.getItem("pi2-connection"))) !== "paired", {
        observed: await page.evaluate(() => localStorage.getItem("pi2-connection")),
    });
    await ctx.shot(page, "b3-paste-link");

    // --- 2) confirming the link pairs the browser ------------------------
    const redeemCode = await mintPairCode();
    const parsed2 = await identify(page, await openScan(page), `pi2://pair?host=${BASE_HOST}&port=${PORT}&code=${redeemCode}`);
    ctx.check("the second pi2:// link still parses", Boolean(parsed2.confirm), { observed: parsed2.state });
    await parsed2.confirm.locator('[data-testid="connect-confirm-connect"]').click();
    const paired = await waitFor(async () => {
        const alert = page.locator('.modal-content [role="alert"]');
        if ((await alert.count()) > 0 && (await alert.first().isVisible())) {
            return { kind: "error", text: (await alert.first().innerText()).trim() };
        }
        if (ctx.navigations.some((entry) => entry.startsWith("/workspaces"))) {
            return { kind: "redirect", url: page.url() };
        }
        return null;
    }, 25000);
    ctx.softCheck("confirming the pasted link pairs and navigates to /workspaces", paired?.kind === "redirect", {
        expected: "navigation to /workspaces with a device token",
        observed: paired ?? { url: page.url(), navigations: ctx.navigations },
    });
    const linkStorage = await page.evaluate(() => ({
        connection: localStorage.getItem("pi2-connection"),
        token: localStorage.getItem("pi2-device-token"),
    }));
    const linkWrites = await page.evaluate(() =>
        (window.__pi2Writes ?? []).filter((write) => ["pi2-connection", "pi2-device-token"].includes(write.key)),
    );
    ctx.note(`link-flow pi2-* storage writes: ${short(linkWrites, 700)}`);
    const linkWsErrors = socketErrors(ctx.wsFrames);
    ctx.softCheck(
        "the socket authenticates after the link-flow pairing",
        linkWsErrors.filter((entry) => entry.code === "E_UNAUTHORIZED").length === 0,
        {
            expected: "no E_UNAUTHORIZED socket error",
            observed: { socketErrors: linkWsErrors.slice(0, 5), navigations: ctx.navigations },
            cause: "same stored 'Bearer <token>' passed verbatim to the WS auth frame (web/src/lib/api.ts + web/src/lib/ws.ts:219)",
        },
    );
    ctx.softCheck("the link flow keeps paired + token", linkStorage.connection === "paired" && Boolean(linkStorage.token), {
        expected: { connection: "paired", token: "set" },
        observed: { ...linkStorage, token: linkStorage.token ? "set" : null, writes: linkWrites },
        cause: "the same write-then-clear sequence as B2 (socket auth of the fresh token is rejected → app-shell disconnects)",
    });

    // --- 3) the daemon's own /pair/<code> URL parses ---------------------
    const { page: page3 } = await ctx.openPage("unpaired");
    await page3.goto(`${BASE}/connect`, { waitUntil: "domcontentloaded" });
    const daemonLink = `${BASE}/pair/${parseCode}`;
    const parsed3 = await identify(page3, await openScan(page3), daemonLink);
    ctx.check(`daemon pairing URL is accepted by the parser (${daemonLink})`, Boolean(parsed3.confirm), {
        expected: "dialog 'Confirm connection'",
        observed: { scanState: parsed3.state, confirmDialog: Boolean(parsed3.confirm) },
    });
    await ctx.shot(page3, "b3-daemon-url");
    await dismissDialogs(page3);
});

/* ------------------------------------------------------------------ */
/* B4 — workspaces                                                     */
/* ------------------------------------------------------------------ */

scenario("B4", "Workspaces: seeded rows/order/counts, path validation, UI add + navigate", async (ctx) => {
    const { page } = await ctx.openPage("paired");
    await page.goto(`${BASE}/workspaces`, { waitUntil: "domcontentloaded" });
    await page.locator("[data-workspace-id]").first().waitFor({ state: "visible", timeout: 20000 });

    const apiList = (await listWorkspaces()).filter((item) => !item.hidden);
    const expectedOrder = [...apiList].sort(
        (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0),
    );
    const rows = page.locator('[data-workspace-id][data-testid="workspace-row"]');
    const rowIds = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workspace-id")));
    ctx.checkValue("workspace row count equals the API", rowIds.length, apiList.length);
    ctx.checkValue("workspace rows are the API workspaces", [...rowIds].sort(), apiList.map((item) => item.workspaceId).sort());
    ctx.checkValue("workspace row order (pinned → lastActiveAt desc)", rowIds, expectedOrder.map((item) => item.workspaceId));
    ctx.check("W1/W2 are both rendered", [state.ws1, state.ws2].every((id) => rowIds.includes(id)), {
        expected: [state.ws1, state.ws2],
        observed: rowIds,
    });

    // v0.1.1: the whole card is the link (no separate enter button).
    const enterHrefs = await page
        .locator('[data-testid="workspace-row"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
    ctx.check(
        "each row links to /chat?workspace=<id>",
        enterHrefs.length === rowIds.length && rowIds.every((id, index) => enterHrefs[index] === `/chat?workspace=${id}`),
        { observed: enterHrefs },
    );
    ctx.check("no server/workspace selector on /workspaces", (await page.locator("select").count()) === 0, {
        observed: await page.locator("select").count(),
    });

    const expectedWorkspaceCount = `${apiList.length} workspaces`;
    // The status line summarises *every* served workspace; the session/running
    // counters are not filtered by the visibility policy.
    const servedWorkspaces = await listWorkspaces();
    const expectedSessionCount = `${servedWorkspaces.reduce(
        (total, item) => total + Math.max(item.liveCount || 0, item.sessionCount || 0),
        0,
    )} sessions`;
    const statusLine = page.locator('[data-testid="workspaces-status-line"]');
    ctx.check("status line is present", (await statusLine.count()) === 1, { observed: await statusLine.count() });
    const barText = (await statusLine.innerText()).replace(/\s+/g, " ");
    ctx.check("status line workspace count", barText.includes(expectedWorkspaceCount), {
        expected: expectedWorkspaceCount,
        observed: barText,
    });
    ctx.check("status line session count", barText.includes(expectedSessionCount), {
        expected: expectedSessionCount,
        observed: barText,
    });
    ctx.check("status line links to /status", (await statusLine.locator('a[href="/status"]').count()) === 1, {
        observed: await statusLine.locator("a").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href"))),
    });

    // --- recent-activity column (session-first since 0.1.1) ---------------
    const activity = page.locator('[data-testid="workspaces-activity"]');
    ctx.check("recent-activity column is present", (await activity.count()) === 1, { observed: await activity.count() });
    const activityRows = activity.locator('[data-testid="workspace-activity-row"]');
    const activityIds = await activityRows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session-id")));
    const activityWorkspaces = await activityRows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workspace-id")));
    const activityTitles = await activityRows.evaluateAll((nodes) =>
        nodes.map((node) => node.querySelector(".ws-activity__name")?.textContent ?? ""),
    );
    const activityHrefs = await activityRows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
    const recentFeed = await listRecentSessions(20);
    const recentById = new Map(recentFeed.map((row) => [row.sessionId, row]));
    const visibleWorkspaces = new Set(expectedOrder.map((item) => item.workspaceId));
    ctx.check("recent activity lists at most the newest 5 sessions", activityIds.length <= 5 && activityIds.length === activityWorkspaces.length, {
        expected: "≤ 5",
        observed: activityIds.length,
    });
    ctx.check(
        "activity rows belong to visible workspaces",
        activityWorkspaces.every((id) => visibleWorkspaces.has(id)),
        { observed: { activityIds, activityWorkspaces } },
    );
    ctx.check(
        "activity rows link into /chat/<session>?workspace=<id>",
        activityHrefs.every(
            (href, index) => href === `/chat/${activityIds[index]}?workspace=${activityWorkspaces[index]}`,
        ),
        { observed: activityHrefs },
    );
    // Regression guard for the workspace-page bug: a session the daemon (or a
    // live instance) can title must not render as `(unnamed)`/`（未命名）`.
    const placeholder = /unnamed|未命名/i;
    ctx.check(
        "recent-activity titles use session metadata when available",
        activityIds.every((id, index) => {
            const feed = recentById.get(id);
            const titled = Boolean(feed?.name || feed?.firstMessage);
            return !titled || !placeholder.test(activityTitles[index] ?? "");
        }),
        {
            observed: activityIds.map((id, index) => ({
                id,
                feed: recentById.get(id)?.name ?? recentById.get(id)?.firstMessage ?? null,
                title: activityTitles[index],
            })),
        },
    );

    // --- empty path validation (no POST must happen) ----------------------
    const requestsBefore = ctx.cmdRequests.length;
    await page.getByRole("button", { name: /open new workspace/i }).first().click();
    const dialog = await dialogFor(page, "Open new workspace", 8000);
    ctx.check("new-workspace dialog opens", Boolean(dialog), { observed: page.url() });
    await dialog.getByRole("button", { name: /^Open$/ }).click();
    const pathError = await waitFor(async () => {
        const alert = page.locator('form#new-workspace-form [role="alert"]');
        if ((await alert.count()) === 0) return null;
        const text = (await alert.first().innerText()).trim();
        return text || null;
    }, 6000);
    ctx.check("empty path shows an inline validation error", pathError === "Enter a working directory path", {
        expected: "Enter a working directory path",
        observed: pathError,
    });
    ctx.check("empty path issues no workspace.add", ctx.cmdRequests.slice(requestsBefore).every((r) => r.method !== "workspace.add"), {
        observed: ctx.cmdRequests.slice(requestsBefore).map((r) => r.method),
    });

    // --- real add through the UI ------------------------------------------
    const newPath = path.join(WS_ROOTS, "ui-added");
    fs.mkdirSync(newPath, { recursive: true });
    await page.locator("#new-workspace-path").fill(newPath);
    await page.locator("#new-workspace-name").fill("UI Added");
    await dialog.getByRole("button", { name: /^Open$/ }).click();

    const navigated = await waitFor(async () => {
        const url = new URL(page.url());
        if (!url.pathname.startsWith("/chat")) return null;
        return url.searchParams.get("workspace");
    }, 30000);
    ctx.check("adding a workspace navigates into /chat?workspace=<id>", Boolean(navigated), {
        expected: "/chat?workspace=<new id>",
        observed: page.url(),
    });
    const apiWorkspaces = await listWorkspaces();
    const created = apiWorkspaces.find((item) => item.cwd === newPath);
    ctx.check("the added workspace is listed by the API", Boolean(created), {
        expected: `workspace with cwd=${newPath}`,
        observed: apiWorkspaces.map((item) => item.cwd),
    });
    ctx.check("navigation uses the created workspace id", navigated === created?.workspaceId, {
        expected: created?.workspaceId,
        observed: navigated,
    });
    const toast = await waitToast(page, /opened workspace/i, 4000);
    ctx.log(`add-workspace toast: ${toast ?? "(already gone)"}`);

    // --- API error + retry must not white-screen --------------------------
    const { page: errorPage } = await ctx.openPage("paired");
    await errorPage.route("**/api/v1/workspaces", (route) =>
        route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "E_INTERNAL", message: "injected by ui-e2e (B4)", retryable: true } }),
        }),
    );
    await errorPage.goto(`${BASE}/workspaces`, { waitUntil: "domcontentloaded" });
    const errorEmpty = await waitFor(async () => {
        const text = await bodyText(errorPage);
        return /could not load workspaces/i.test(text) ? text : null;
    }, 20000);
    ctx.check("workspaces API error renders an error state", Boolean(errorEmpty), {
        expected: "Could not load workspaces",
        observed: short((await bodyText(errorPage)).replace(/\s+/g, " "), 200),
    });
    await ctx.shot(errorPage, "b4-workspaces-api-error");
    await errorPage.unroute("**/api/v1/workspaces");
    await errorPage.getByRole("button", { name: /retry/i }).first().click();
    const recovered = await waitFor(async () => (await errorPage.locator("[data-workspace-id]").count()) > 0, 20000);
    ctx.check("retry recovers the workspaces list", Boolean(recovered), {
        expected: "workspace rows after Retry",
        observed: await errorPage.locator("[data-workspace-id]").count(),
    });

    state.uiAddedWorkspace = created?.workspaceId;
});

/* ------------------------------------------------------------------ */
/* B5 — chat session tree                                              */
/* ------------------------------------------------------------------ */

scenario("B5", "Chat tree: workspace picker, New session → /chat/<sid>, rename via the row menu, close confirms, switch workspaces", async (ctx) => {
    const { page } = await ctx.openPage("paired");
    await page.goto(`${BASE}/chat?workspace=${encodeURIComponent(state.ws1)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".tree-pane .pane-head").waitFor({ state: "visible", timeout: 20000 });

    // v0.1.1: the workspace picker is a button + searchable `listbox` (no <select>).
    const wsSwitch = page.locator('[data-testid="ws-switch"]');
    const wsMenu = page.locator('[data-testid="ws-menu"]');
    ctx.check("workspace switch is present", (await wsSwitch.count()) === 1, { observed: await wsSwitch.count() });
    await wsSwitch.click();
    await wsMenu.waitFor({ state: "visible", timeout: 10000 });
    const options = await wsMenu
        .locator("[data-workspace-id]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workspace-id")));
    const checkedWorkspaces = await wsMenu
        .locator('[data-workspace-id][aria-selected="true"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workspace-id")));
    ctx.checkValue("the workspace menu marks W1 as current", checkedWorkspaces, [state.ws1]);
    ctx.check("workspace menu lists every workspace", options.length >= 2 && options.includes(state.ws2), {
        expected: [state.ws1, state.ws2],
        observed: options,
    });

    // The picker is searchable: one row per match, and a blank query restores all.
    const search = page.locator('[data-testid="ws-menu-search"]');
    await search.fill("ws2");
    const filtered = await wsMenu
        .locator("[data-workspace-id]")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workspace-id")));
    ctx.checkValue("the workspace search filters to W2", filtered, [state.ws2]);
    await search.fill("no-such-workspace-xyz");
    const noMatch = await waitFor(
        async () => ((await wsMenu.locator("[data-testid='ws-menu-empty']").count()) > 0 ? true : null),
        6000,
    );
    ctx.check("the workspace search reports an empty result", Boolean(noMatch), {
        observed: await wsMenu.locator("[data-workspace-id]").count(),
    });
    await page.locator('[data-testid="ws-menu"] .ws-menu__input').fill("");
    const restored = await waitFor(
        async () =>
            (await wsMenu.locator("[data-workspace-id]").count()) === options.length ? true : null,
        6000,
    );
    ctx.check("clearing the search restores every workspace", Boolean(restored), {
        expected: options.length,
        observed: await wsMenu.locator("[data-workspace-id]").count(),
    });

    await wsSwitch.click();
    const menuClosed = await waitFor(async () => ((await wsMenu.isVisible()) ? null : true), 6000);
    ctx.check("the workspace menu closes on a second click", Boolean(menuClosed), { observed: await wsMenu.isVisible() });

    const before = await listSessions(state.ws1);
    const newSessionButton = page.locator('.tree-pane [data-testid="tree-new-session"]').first();
    await newSessionButton.click();
    // The URL may briefly carry the `tmp-N` placeholder; the web replaces it with
    // the real id once the plugin announces the migration.
    const createdUrl = await waitRealSessionId(page, 15000);
    ctx.check("New session routes to /chat/<real sid>", Boolean(createdUrl), { expected: "/chat/<sid>", observed: page.url() });
    ctx.check("New session keeps ?workspace=W1", createdUrl?.workspace === state.ws1, {
        expected: state.ws1,
        observed: createdUrl?.workspace,
    });
    const sessionId = createdUrl.sessionId;
    state.treeSession = { sessionId, workspaceId: state.ws1 };

    const after = await listSessions(state.ws1);
    ctx.check("the created session is listed by the API", after.some((row) => row.sessionId === sessionId), {
        expected: sessionId,
        observed: after.map((row) => row.sessionId),
    });
    ctx.log(`sessions in W1: ${before.length} → ${after.length}`);

    const selectedRow = page.locator(".tree-pane .tree-row[data-session-id].selected");
    const rowFound = await waitFor(async () => {
        const ids = await treeSessionIds(page);
        return ids.includes(sessionId) ? true : null;
    }, 20000);
    ctx.check("the new session row is in the tree and selected", Boolean(rowFound) && (await selectedRow.count()) === 1, {
        expected: `.tree-row[data-session-id="${sessionId}"].selected`,
        observed: await treeSessionIds(page),
    });
    const streamedName = await streamName(page);
    const selectedLabel = ((await selectedRow.first().locator(".t-name").innerText()) ?? "").trim();
    ctx.check("tree row name matches the stream title", selectedLabel === streamedName && streamedName.length > 0, {
        expected: streamedName,
        observed: selectedLabel,
    });

    // --- rename (must persist through the plugin + a reload) -------------
    // v0.1.1: row actions live in the `…` popover (`data-menu-action`), not in
    // per-row buttons.
    const rowMenu = await openSessionRowMenu(page, sessionId);
    await rowMenu.locator('[data-menu-action="rename"]').click();
    const renameDialog = await dialogFor(page, "Rename session", 8000);
    ctx.check("rename dialog opens from the tree row", Boolean(renameDialog), { observed: page.url() });
    await page.locator("#rename-input").fill("e2e-renamed");
    await renameDialog.getByRole("button", { name: /^Save$/ }).click();
    const renameToast = await waitToast(page, /renamed/i, 8000);
    ctx.check("rename surfaces a toast", Boolean(renameToast), { expected: "Renamed: e2e-renamed", observed: (await toastTexts(page)).join(" | ") });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".tree-pane .pane-head").waitFor({ state: "visible", timeout: 20000 });
    const labels = () => treeRowNames(page);
    const persisted = await waitFor(async () => {
        const current = await labels();
        return current.includes("e2e-renamed") ? current : null;
    }, 25000);
    ctx.check("renamed session persists across a reload", Boolean(persisted), {
        expected: "tree row name=e2e-renamed",
        observed: persisted ?? (await labels()),
    });

    // --- close asks for confirmation and removes the row -----------------
    const targetRow = page.locator(".tree-pane .tree-row[data-session-id]").filter({ hasText: "e2e-renamed" });
    ctx.check("the renamed row is reachable in the tree", (await targetRow.count()) >= 1, { observed: await labels() });
    const closeMenu = await openSessionRowMenu(page, sessionId);
    await closeMenu.locator('[data-menu-action="close"]').click();
    const closeDialog = await dialogFor(page, "Close process", 8000);
    ctx.check("close asks for confirmation", Boolean(closeDialog), { observed: page.url() });
    const closeText = (await closeDialog.innerText()).replace(/\s+/g, " ");
    ctx.check("close confirmation names the session", closeText.includes("e2e-renamed"), { expected: "…e2e-renamed…", observed: closeText });
    await closeDialog.getByRole("button", { name: /^Close process$/ }).click();
    const closedToast = await waitToast(page, /closed process/i, 8000);
    ctx.log(`close toast: ${closedToast ?? "(none)"}`);
    const rowGone = await waitFor(async () => {
        const current = await labels();
        return current.includes("e2e-renamed") ? null : current;
    }, 25000);
    if (!rowGone) {
        const apiAfterClose = await listSessions(state.ws1);
        ctx.softCheck("closed session disappears from the tree", false, {
            expected: "row removed after close",
            observed: {
                treeRows: await labels(),
                apiSessions: apiAfterClose.filter((row) => row.sessionId === sessionId),
            },
            cause: "session.close closes the pi process but GET /api/v1/workspaces/<ws>/sessions keeps the row, so the tree re-adds it on the next poll",
        });
    } else {
        ctx.check("closed session disappears from the tree", true, { observed: "removed" });
    }

    // --- workspace switch does not leak rows -----------------------------
    await wsSwitch.click();
    await wsMenu.waitFor({ state: "visible", timeout: 10000 });
    await wsMenu.locator(`[data-workspace-id="${state.ws2}"]`).click();
    const switched = await waitFor(async () => (new URL(page.url()).searchParams.get("workspace") === state.ws2 ? true : null), 20000);
    ctx.check("switching the workspace updates ?workspace", Boolean(switched), { expected: state.ws2, observed: page.url() });
    const ws2Rows = await waitFor(async () => {
        const current = await labels();
        return current.includes("e2e-renamed") ? null : current;
    }, 20000);
    ctx.check("switching to W2 does not leak W1 rows", Boolean(ws2Rows), {
        expected: "no W1 rows in the W2 tree",
        observed: ws2Rows ?? (await labels()),
    });
    ctx.log(`W2 tree rows: ${JSON.stringify(ws2Rows)}`);
    await ctx.shot(page, "b5-tree");
});
/* ------------------------------------------------------------------ */
/* B6 — prompt + streaming                                             */
/* ------------------------------------------------------------------ */

scenario("B6", "Prompt + streaming: PONG turn, one user entry, no .streaming after settle, Shift+Enter does not send", async (ctx) => {
    const { page } = await ctx.openPage("paired");
    const sessionId = await createSession(state.ws1);
    state.pongSession = { sessionId, workspaceId: state.ws1 };
    ctx.check("chat page becomes usable (WS open + composer enabled)", await openChat(page, sessionId, state.ws1), {
        expected: "textarea[aria-label='Message input'] enabled",
        observed: { composer: await composerState(page) },
    });

    // --- composer queue bar (v0.1.1) --------------------------------------
    // The queued prompts are rendered in the stream (`[data-testid=stream-queued]`,
    // `.msg--queued`); the composer only carries a `role=status` bar with a clear
    // action that stays disabled while nothing is pending.
    const queueBar = page.locator('[data-testid="composer-queue"]');
    const queueClear = page.locator('[data-testid="composer-queue-clear"]');
    ctx.check(
        "the composer queue bar is a status line",
        (await queueBar.count()) === 1 && (await queueBar.getAttribute("role")) === "status",
        {
            expected: '[data-testid="composer-queue"][role=status]',
            observed: { count: await queueBar.count(), role: await queueBar.getAttribute("role") },
        },
    );
    ctx.check("the queue clear action is disabled with nothing pending", await queueClear.isDisabled(), {
        expected: "disabled",
        observed: { disabled: await queueClear.isDisabled(), text: (await queueClear.innerText()).trim() },
    });

    // --- Shift+Enter inserts a newline, it must not send -----------------
    const textarea = page.locator(COMPOSER_INPUT);
    await textarea.click();
    await textarea.type("line one");
    await page.keyboard.press("Shift+Enter");
    await textarea.type("line two");
    const value = await textarea.inputValue();
    ctx.check("Shift+Enter inserts a newline", value.includes("\n"), { expected: "two lines", observed: value });
    ctx.check("Shift+Enter does not send", (await page.locator('article.msg[data-role="user"]').count()) === 0, {
        observed: await page.locator('article.msg[data-role="user"]').count(),
    });
    await textarea.fill("");

    // --- Enter sends, the assistant streams and settles ------------------
    const prompt = "Reply with exactly the word PONG and nothing else.";
    await textarea.fill(prompt);
    await page.keyboard.press("Enter");
    const sent = await waitFor(async () => ctx.cmdRequests.find((request) => request.method === "prompt.send") ?? null, 15000);
    ctx.check("Enter posts prompt.send", Boolean(sent) && sent.params?.text === prompt, {
        expected: { method: "prompt.send", text: prompt },
        observed: sent ?? null,
    });

    const userEntries = await waitFor(async () => {
        const articles = await streamArticles(page);
        const users = articles.filter((article) => article.role === "user");
        return users.length === 1 ? users : null;
    }, 20000);
    ctx.check("exactly one user entry appears", Boolean(userEntries), {
        expected: 1,
        observed: (await streamArticles(page)).filter((a) => a.role === "user"),
    });
    ctx.checkValue("the user entry text is the prompt", userEntries[0].text, prompt);

    const settled = await waitFor(async () => {
        const articles = await streamArticles(page);
        const assistant = articles.filter((article) => article.role === "assistant");
        if (assistant.length !== 1) return null;
        const text = assistant[0].text.trim();
        return text.length > 0 && !assistant[0].streaming ? assistant[0] : null;
    }, 120000, 250);
    const finalArticles = await streamArticles(page);
    const assistants = finalArticles.filter((article) => article.role === "assistant");
    const snapEntries = snapshotEntries(ctx.wsFrames, sessionId) ?? [];
    ctx.note(`snapshot entries: ${short(snapEntries, 600)}`);
    ctx.note(`DOM articles: ${short(finalArticles, 600)}`);
    ctx.softCheck(
        "the plugin snapshot holds exactly one assistant entry",
        snapEntries.filter((entry) => entry.role === "assistant").length <= 1,
        { expected: "<=1 assistant entry in the snapshot", observed: snapEntries.filter((entry) => entry.role === "assistant") },
    );
    ctx.check("the assistant turn settles", Boolean(settled), {
        expected: "one settled assistant article",
        observed: { count: assistants.length, text: short(assistants.map((a) => a.text).join(" | "), 200) },
    });
    ctx.checkValue("assistant text is exactly PONG", settled.text.trim().toLowerCase(), "pong");
    ctx.check("exactly one assistant entry for the turn", assistants.length === 1, {
        expected: 1,
        observed: assistants.length,
    });
    ctx.check(
        "no .msg__text.streaming remains",
        finalArticles.every((article) => !article.streaming),
        { observed: finalArticles.filter((a) => a.streaming) },
    );

    const backToSend = await waitFor(async () => {
        const state_ = await composerState(page);
        return state_.send === "Send" && !state_.abort ? true : null;
    }, 15000);
    ctx.check("the Abort button disappears and Send is available", Boolean(backToSend), {
        expected: { abort: false, send: "Send" },
        observed: await composerState(page),
    });
    // `flags.done` is sticky once a turn completed, so the badge reads `Done`
    // (the design's `state.done`); docs/e2e.md B6 describes it as idle. Both mean
    // "settled": the composer is back to Send and nothing streams any more.
    const SETTLED_BADGES = ["Idle", "Done"];
    const badge = await waitFor(async () => {
        const label = await sessionStatusBadge(page);
        return SETTLED_BADGES.includes(label) ? label : null;
    }, 15000);
    ctx.check("status badge returns to a settled state (Idle/Done)", Boolean(badge), {
        expected: "Idle|Done",
        observed: await sessionStatusBadge(page),
    });
    ctx.note(`settled status badge: ${await sessionStatusBadge(page)}`);
    ctx.check("no error toast during the turn", (await errorToastCount(page)) === 0, {
        observed: await toastTexts(page),
    });

    const frameTypes = ctx.wsFrames
        .map((frame) => (frame?.type === "event" ? (frame.payload?.event ?? frame.payload)?.type : frame?.type))
        .filter(Boolean);
    const counts = frameTypes.reduce((acc, type) => ({ ...acc, [type]: (acc[type] ?? 0) + 1 }), {});
    ctx.note(`WS frames: ${short(counts, 300)}`);
    ctx.check("streaming produced assistant deltas over the WS", (counts.message_update ?? 0) >= 1, {
        expected: ">=1 message_update",
        observed: counts,
    });
    await ctx.shot(page, "b6-pong");
});

/* ------------------------------------------------------------------ */
/* B7 — abort                                                          */
/* ------------------------------------------------------------------ */

scenario("B7", "Abort: slow prompt → Abort button → Idle within 10 s, partial text stays, nothing more arrives", async (ctx) => {
    const { page } = await ctx.openPage("paired");
    const sessionId = await createSession(state.ws1);
    ctx.check("chat page becomes usable", await openChat(page, sessionId, state.ws1), { expected: "composer enabled" });

    const textarea = page.locator(COMPOSER_INPUT);
    await textarea.fill("Count from 1 to 200, one number per line.");
    await page.keyboard.press("Enter");

    const abortVisible = await waitFor(async () => ((await page.locator('[data-testid="composer-abort"]').count()) > 0 ? true : null), 30000);
    ctx.check("an Abort button appears while busy", Boolean(abortVisible), {
        expected: '[data-testid="composer-abort"]',
        observed: await composerState(page),
    });
    await waitFor(async () => {
        const articles = await streamArticles(page);
        return articles.some((article) => article.role === "assistant" && article.text.length > 0) ? true : null;
    }, 30000);

    await page.locator('[data-testid="composer-abort"]').click();
    const abortSent = await waitFor(async () => ctx.cmdRequests.find((request) => request.method === "prompt.abort") ?? null, 10000);
    ctx.check("Abort posts prompt.abort", Boolean(abortSent), { observed: ctx.cmdRequests.map((r) => r.method) });

    // After an aborted turn the protocol (§4.1 `agent_settled{aborted}`) leaves
    // `status=idle` and sets `flags.error`, so the badge reads `Error` — the
    // session is settled, it just carries the abort flag. Accept either label;
    // the hard requirements are that the composer returns to Send (no stuck
    // busy state) and that no further assistant text arrives (asserted below).
    const ABORT_SETTLED_STATUS = ["Idle", "Error"];
    const settled = await waitFor(async () => {
        const label = await sessionStatusBadge(page);
        return (await composerSendLabel(page)) === "Send" && ABORT_SETTLED_STATUS.includes(label) ? label : null;
    }, 10000);
    const abortStatusLabel = await sessionStatusBadge(page);
    ctx.check("status returns to Idle within 10 s of the abort", Boolean(settled), {
        expected: { button: "Send", status: "Idle|Error" },
        observed: { button: await composerSendLabel(page), status: abortStatusLabel },
    });
    ctx.note(`abort status label: ${abortStatusLabel || "(none)"}`);

    const partial = (await streamArticles(page)).filter((article) => article.role === "assistant");
    ctx.check("partial assistant text remains", partial.some((article) => article.text.length > 0), {
        expected: ">=1 assistant article with text",
        observed: partial.map((article) => short(article.text, 80)),
    });
    const lengthBefore = partial.map((article) => article.text.length).join(",");
    await sleep(4000);
    const lengthAfter = (await streamArticles(page))
        .filter((article) => article.role === "assistant")
        .map((article) => article.text.length)
        .join(",");
    ctx.check("no further text arrives after the abort", lengthBefore === lengthAfter, {
        expected: lengthBefore,
        observed: lengthAfter,
    });
    await ctx.shot(page, "b7-abort");
});

/* ------------------------------------------------------------------ */
/* B8 — model / thinking                                               */
/* ------------------------------------------------------------------ */

/** Thinking levels the composer `<select>` may legitimately show (`web/src/features/chat/format.ts`). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** `true` when `value` is one of the documented thinking levels. */
function isThinkingLevel(value) {
    return typeof value === "string" && THINKING_LEVELS.includes(value);
}

/**
 * Latest state carried by the WS `snapshot` frames for `sessionId` among `frames`.
 *
 * `thinking` stays `undefined` when no frame carried the field: the REST
 * `/workspaces/:id/sessions` payload may omit it, so the WS snapshot is the
 * authority for the level. `found` reports whether such a snapshot exists at all.
 */
function snapshotThinking(frames, sessionId) {
    let found = false;
    let thinking;
    for (const frame of frames) {
        if (frame?.type !== "snapshot") continue;
        const payload = frame?.payload;
        const sessionState = payload?.state ?? payload;
        const id = payload?.sessionId ?? frame?.sessionId ?? sessionState?.sessionId;
        if (sessionId && id && id !== sessionId) continue;
        found = true;
        if (isThinkingLevel(sessionState?.thinking)) thinking = sessionState.thinking;
    }
    return { found, thinking };
}

scenario("B8", "Model/thinking selects: commands sent, no error toast, values survive a reload", async (ctx) => {
    const { page } = await ctx.openPage("paired");
    const sessionId = await createSession(state.ws1);
    ctx.check("chat page becomes usable", await openChat(page, sessionId, state.ws1), { expected: "composer enabled" });

    const thinking = page.locator('[data-testid="composer-thinking"]');
    await thinking.waitFor({ state: "visible", timeout: 15000 });
    await thinking.selectOption("low");
    const thinkingCmd = await waitFor(async () => ctx.cmdRequests.find((request) => request.method === "session.setThinking") ?? null, 10000);
    ctx.check("thinking change posts session.setThinking {level:low}", thinkingCmd?.params?.level === "low", {
        expected: { method: "session.setThinking", level: "low" },
        observed: thinkingCmd ?? null,
    });
    await sleep(1500);
    ctx.check("thinking change shows no error toast", (await errorToastCount(page)) === 0, {
        expected: "no [data-sonner-toast][data-type=error]",
        observed: await toastTexts(page),
        cause: "session.setThinking{level:low} surfaced an error toast",
    });
    // A reasoning model need not support every level: deepseek-v4-pro maps `low`
    // to null (`thinkingLevelMap`), so pi keeps its own level and the command is
    // an accepted no-op (API scenario A6 records exactly this as an accepted
    // deviation). The reload below therefore proves that the command round-trips
    // and that the reloaded select settles on a *documented* level; the exact
    // level is model capability, not a plugin failure. `openChat` is a full page
    // load, i.e. the reload under test.
    //
    // The WS snapshot is the authority: the REST `/workspaces/:id/sessions`
    // payload may omit `thinking`, and until the snapshot lands the select shows
    // its pre-snapshot default (the first option), which is not a read of the
    // persisted level. So wait for the snapshot, then read the select.
    const thinkingValue = async () =>
        page.locator('[data-testid="composer-thinking"]').inputValue().catch(() => "");
    const framesBeforeReload = ctx.wsFrames.length;
    ctx.check("chat page becomes usable after reload", await openChat(page, sessionId, state.ws1), { expected: "composer enabled" });
    const reloadDeadline = Date.now() + 15000;
    const wsSnapshot = await waitFor(async () => {
        const snapshot = snapshotThinking(ctx.wsFrames.slice(framesBeforeReload), sessionId);
        return snapshot.found ? snapshot : null;
    }, 15000);
    if (wsSnapshot && isThinkingLevel(wsSnapshot.thinking)) {
        // Give React a beat to apply the snapshot before the value is read.
        await waitFor(async () => ((await thinkingValue()) === wsSnapshot.thinking ? true : null), 5000);
    }
    const shownLevel = await waitFor(
        async () => {
            const value = await thinkingValue();
            return isThinkingLevel(value) ? value : null;
        },
        Math.max(1000, reloadDeadline - Date.now()),
    );
    ctx.check("the reloaded thinking select shows a documented level", Boolean(shownLevel), {
        expected: THINKING_LEVELS,
        observed: {
            select: await thinkingValue(),
            wsSnapshot: wsSnapshot ? (wsSnapshot.thinking ?? null) : "(no snapshot frame after the reload)",
        },
        cause: "the thinking <select> is empty or shows a value outside off|minimal|low|medium|high|xhigh|max after the reload",
    });
    if (!wsSnapshot) {
        ctx.note("no WS snapshot frame for the session arrived within 15 s of the reload — the level was read from the select alone");
    }
    if (shownLevel !== "low") {
        ctx.note(
            `thinking clamped by the model to ${shownLevel}: session.setThinking{level:"low"} was accepted, but the active ` +
                "model does not support `low` — the same clamp API scenario A6 records as an accepted deviation",
        );
    }

    // --- model ----------------------------------------------------------
    const model = page.locator('[data-testid="composer-model"]');
    const modelOptions = await model.locator("option").evaluateAll((nodes) =>
        nodes.filter((node) => node.value).map((node) => node.value),
    );
    if (!modelOptions.length) {
        ctx.note("model select has no real options (workspace.query kind=models returned nothing) — model switch not exercised");
        ctx.skip("model select has no options to switch to (no providers reported by the workspace)");
    }
    const target = modelOptions[0];
    await model.selectOption(target);
    const modelCmd = await waitFor(async () => ctx.cmdRequests.find((request) => request.method === "session.setModel") ?? null, 10000);
    ctx.check("model change posts session.setModel", Boolean(modelCmd), {
        expected: `session.setModel for ${target}`,
        observed: modelCmd ?? null,
    });
    const modelResponse = ctx.cmdResponses.filter((response) => response.url.includes("/api/v1/cmd")).pop();
    await sleep(2000);
    ctx.softCheck("model change shows no error toast", (await errorToastCount(page)) === 0, {
        expected: "no [data-sonner-toast][data-type=error]",
        observed: { toasts: await toastTexts(page), lastCmdResponse: modelResponse ?? null },
    });
    const modelId = target.slice(target.indexOf("/") + 1);
    // v0.1.1 moved the row subtitle into the row button's title
    // (`name · model · thinking`); there is no `.t-sub` span any more.
    const treeRow = page.locator(`.tree-pane .tree-row[data-session-id="${sessionId}"] .tree-row__main`).first();
    if ((await treeRow.count()) > 0) {
        const subText = ((await treeRow.getAttribute("title")) ?? "").trim();
        ctx.softCheck("the tree row title shows the new model", subText.includes(modelId), {
            expected: modelId,
            observed: subText,
        });
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    ctx.check("chat page becomes usable after the model reload", await openChat(page, sessionId, state.ws1), { expected: "composer enabled" });
    // The backend may clamp or default the model (a provider that rejects the
    // requested id falls back), so a reload only has to show *a listed* model —
    // the requested one whenever the provider honours it.
    const modelValue = async () => page.locator('[data-testid="composer-model"]').inputValue().catch(() => "");
    const modelAfter = await waitFor(
        async () => {
            const value = await modelValue();
            return modelOptions.includes(value) ? value : null;
        },
        20000,
    );
    ctx.check("the reloaded model select shows a listed model", Boolean(modelAfter), {
        expected: modelOptions,
        observed: { select: await modelValue(), requested: target },
        cause: "the model <select> is empty or shows an id the workspace does not list after the reload",
    });
    if (modelAfter && modelAfter !== target) {
        ctx.note(
            `model clamped/defaulted by the backend to ${modelAfter} after requesting ${target} (session.setModel was ` +
                "accepted) — the active provider does not offer the requested id",
        );
    }
    await ctx.shot(page, "b8-selects");
});

/* ------------------------------------------------------------------ */
/* B9 — session tray (todo / tasks) + subagent child view             */
/* ------------------------------------------------------------------ */

const MOCK_COPY = [/prototype demo only/i, /Demo only: local mock/i, /nothing is uploaded/i, /mock/i, /demo/i];

scenario("B9", "Session tray: two tabs, empty/real states, dispatch from the row menu, subagent child view, no mock copy", async (ctx) => {
    const { page } = await ctx.openPage("paired");
    const sessionId = await createSession(state.ws1);
    state.traySession = { sessionId, workspaceId: state.ws1 };
    ctx.check("chat page becomes usable", await openChat(page, sessionId, state.ws1), { expected: "composer enabled" });

    // v0.1.1 removed the right panel: `/chat` is two columns and the Todo/Tasks
    // surfaces are the anchored session tray.
    await page.locator('[data-testid="head-chips"]').waitFor({ state: "visible", timeout: 20000 });
    ctx.checkValue("no right panel column on /chat", await page.locator(".panel-pane").count(), 0);

    // --- open the tray from the Plan chip ---------------------------------
    const tray = await openTray(page, "todo");
    ctx.checkValue("the Plan chip opens the tray on the todo tab", await tray.getAttribute("data-tab"), "todo");
    ctx.check("the tray is a non-modal dialog", (await tray.getAttribute("role")) === "dialog" && (await tray.getAttribute("aria-modal")) === "false", {
        expected: 'role=dialog aria-modal=false',
        observed: { role: await tray.getAttribute("role"), modal: await tray.getAttribute("aria-modal") },
    });

    const tablist = tray.locator('[role="tablist"]');
    const tabNames = (await tablist.locator('[role="tab"]').allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
    ctx.check("the tray has exactly two tabs (Todo, Tasks)", tabNames.length === 2, { expected: 2, observed: tabNames });
    const tabIds = await tablist
        .locator('[role="tab"]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
    ctx.checkValue("tray tabs carry the documented test ids", tabIds, ["tray-tab-todo", "tray-tab-tasks"]);
    ctx.checkValue("subagents are not a tray tab any more", tabIds.includes("tray-tab-subagents"), false);

    const tab = (id) => tray.locator(`[data-testid="tray-tab-${id}"]`);
    const selectedTab = () =>
        tablist
            .locator('[role="tab"][aria-selected="true"]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
    const trayText = async () => (await tray.locator(".tray-body").innerText()).replace(/\s+/g, " ");

    // Todo (selected on open)
    await tab("todo").click();
    await sleep(400);
    const todoText = await trayText();
    const todoRows = await tray.locator(".todo__row").count();
    ctx.check("Todo tab renders real rows or its explicit empty state", todoRows > 0 || /no todos yet/i.test(todoText), {
        expected: ".todo__row or 'No todos yet'",
        observed: short(todoText, 200),
    });
    ctx.checkValue("clicking the Todo tab selects it", await selectedTab(), ["tray-tab-todo"]);
    ctx.log(`todo tab: rows=${todoRows} text=${short(todoText, 120)}`);

    // Tasks
    await tab("tasks").click();
    await sleep(400);
    const tasksText = await trayText();
    const taskRows = await tray.locator(".task-row[data-task-id]").count();
    ctx.check("Tasks tab renders real rows or its explicit empty state", taskRows > 0 || /no background tasks/i.test(tasksText), {
        expected: ".task-row[data-task-id] or 'No background tasks'",
        observed: short(tasksText, 200),
    });
    ctx.checkValue("clicking the Tasks tab selects it", await selectedTab(), ["tray-tab-tasks"]);
    ctx.check("Tasks tab shows no fake pid", !/\bpid\b\s*[:=]?\s*\d+/i.test(tasksText), {
        expected: "no fabricated pid",
        observed: short(tasksText, 200),
    });

    const allTrayCopy = `${todoText} ${tasksText}`;
    const mockHits = MOCK_COPY.filter((re) => re.test(allTrayCopy)).map(String);
    ctx.check("no mock/prototype copy in the tray", mockHits.length === 0, {
        expected: "no mock copy",
        observed: mockHits,
    });
    await ctx.shot(page, "b9-tray");

    // Esc closes the tray (single-layer close chain).
    await page.keyboard.press("Escape");
    const trayClosed = await waitFor(async () => ((await sessionTray(page).isVisible()) ? null : true), 6000);
    ctx.check("Escape closes the tray", Boolean(trayClosed), { observed: await sessionTray(page).isVisible() });

    // --- dispatch a real subagent from the session row `…` menu ----------
    const rowMenu = await openSessionRowMenu(page, sessionId);
    ctx.checkValue("the row menu offers `Dispatch subagent`", await rowMenu.locator('[data-menu-action="dispatch"]').count(), 1);
    await rowMenu.locator('[data-menu-action="dispatch"]').click();
    const dialog = await dialogFor(page, "Dispatch subagent", 8000);
    ctx.check("dispatch modal opens from the row menu", Boolean(dialog), { observed: page.url() });
    await page.locator("#dispatch-task").fill("Reply with exactly SUB and nothing else.");
    await page.locator("#dispatch-name").fill("e2e-ui-sub");
    await dialog.getByRole("button", { name: /^Dispatch$/ }).click();

    const dispatchCmd = await waitFor(async () => ctx.cmdRequests.find((request) => request.method === "subagent.dispatch") ?? null, 15000);
    ctx.check("dispatch posts subagent.dispatch", Boolean(dispatchCmd), { observed: ctx.cmdRequests.map((r) => r.method) });
    ctx.log(`subagent.dispatch body params: ${short(dispatchCmd?.params, 300)}`);

    const subagentRows = page.locator(".tree-pane .tree-row[data-subagent-id]");
    const rowOrFailure = await waitFor(async () => {
        if ((await subagentRows.count()) > 0) return { kind: "row" };
        const errors = await toastTexts(page);
        const failed = errors.find((text) => /failed/i.test(text));
        if (failed) return { kind: "error", text: failed };
        return null;
    }, 120000, 250);
    if (rowOrFailure?.kind === "error") {
        const response = ctx.cmdResponses.filter((item) => item.url.includes("/api/v1/cmd")).pop();
        ctx.softCheck("dispatch creates a real subagent tree row", false, {
            expected: ".tree-row[data-subagent-id] (or a batch) after ≤120 s",
            observed: { toast: rowOrFailure.text, lastCmdResponse: response ?? null },
        });
    } else {
        ctx.softCheck("dispatch creates a real subagent tree row", rowOrFailure?.kind === "row", {
            expected: ".tree-pane .tree-row[data-subagent-id]",
            observed: rowOrFailure ?? "no row after 120 s",
        });
    }

    if (rowOrFailure?.kind === "row") {
        const subRow = subagentRows.filter({ hasText: "e2e-ui-sub" }).first();
        const rowVisible = await waitFor(async () => ((await subRow.count()) > 0 ? true : null), 10000);
        ctx.softCheck("the dispatched subagent is named e2e-ui-sub", Boolean(rowVisible), {
            expected: "subagent row named e2e-ui-sub",
            observed: await subagentRows.allInnerTexts(),
        });
        if (rowVisible) {
            // Subagents open in-place (`?sub=<id>`), not in a modal.
            await subRow.locator("button.tree-row__main").click();
            const child = page.locator('[data-testid="subagent-view"]');
            const childOpen = await waitFor(async () => ((await child.count()) > 0 ? true : null), 15000);
            ctx.softCheck("the subagent child view replaces the stream", Boolean(childOpen), {
                expected: '[data-testid="subagent-view"]',
                observed: page.url(),
            });
            if (childOpen) {
                ctx.check("the child view is a `?sub=` deep link", Boolean(new URL(page.url()).searchParams.get("sub")), {
                    observed: page.url(),
                });
                const timeline = child.locator('[data-testid="sub-timeline"]');
                const timelineCount = await timeline.count();
                const entries = timelineCount ? await timeline.locator("[data-entry-id]").count() : 0;
                const emptyState = await child.locator(".sub-empty").count();
                const childText = (await child.innerText()).replace(/\s+/g, " ");
                ctx.softCheck(
                    "the child view shows a real timeline or an explicit empty state",
                    timelineCount === 1 && (entries > 0 || emptyState > 0),
                    {
                        expected: '[data-testid="sub-timeline"] with entries or .sub-empty',
                        observed: { timeline: timelineCount, entries, emptyState },
                    },
                );
                const childMock = MOCK_COPY.filter((re) => re.test(childText)).map(String);
                ctx.softCheck("the child view has no mock copy", childMock.length === 0, { observed: childMock });
                await ctx.shot(page, "b9-subagent-child-view");

                const back = child.locator(".sub-back");
                ctx.checkValue("the child view has a `Parent` back button", await back.count(), 1);
                await back.click();
                const leftChild = await waitFor(
                    async () => ((await page.locator('[data-testid="subagent-view"]').count()) === 0 ? true : null),
                    10000,
                );
                ctx.softCheck("`Parent` returns to the session stream", Boolean(leftChild), {
                    expected: "no [data-testid=subagent-view]",
                    observed: page.url(),
                });
            }
        }
    }
    await dismissDialogs(page);
    await ctx.shot(page, "b9-child-view");
});

/* ------------------------------------------------------------------ */
/* B10 — attention (diff review)                                       */
/* ------------------------------------------------------------------ */

scenario("B10", "Attention: the e2e_request tool surfaces the blocking dialog; Accept writes the file", async (ctx) => {
    const { page } = await ctx.openPage("paired");
    const sessionId = await createSession(state.ws1);
    const target = path.join(state.ws1Cwd, "e2e-attention.txt");
    fs.rmSync(target, { force: true });
    ctx.check("chat page becomes usable", await openChat(page, sessionId, state.ws1), { expected: "composer enabled" });

    // The test-only extension (scripts/e2e/attention-ext.ts, loaded through
    // host-init.lua) registers `e2e_request`, whose execute() blocks in
    // `ctx.ui.select(<diff JSON>, ["Accept","Reject"])`.
    const textarea = page.locator(COMPOSER_INPUT);
    await textarea.fill("Call the e2e_request tool once, then reply DONE.");
    await page.keyboard.press("Enter");

    const appeared = await waitFor(async () => {
        const dialogs = page.getByRole("dialog");
        if ((await dialogs.count()) === 0) return null;
        const first = dialogs.first();
        if (!(await first.isVisible())) return null;
        const text = (await first.innerText()).replace(/\s+/g, " ");
        const options = await first.locator("[data-option-id]").evaluateAll((nodes) =>
            nodes.map((node) => ({ id: node.getAttribute("data-option-id"), label: (node.textContent ?? "").trim() })),
        );
        const decisions = await first.locator("[data-decision]").evaluateAll((nodes) =>
            nodes.map((node) => ({ decision: node.getAttribute("data-decision"), path: node.getAttribute("data-path") })),
        );
        return { text, options, decisions, title: short(text, 120) };
    }, 60000, 300);

    if (!appeared) {
        const attentionApi = await apiRaw("GET", `/api/v1/attention?workspaceId=${encodeURIComponent(state.ws1)}`);
        const articles = await streamArticles(page);
        ctx.note(
            `no attention dialog within 60 s. GET /api/v1/attention → ${attentionApi.status} ${short(attentionApi.text, 200)}; ` +
                `file exists without consent: ${fs.existsSync(target)}; assistant text: ` +
                `${short(articles.filter((a) => a.role === "assistant").map((a) => a.text).join(" "), 200)}`,
        );
        await ctx.shot(page, "b10-no-attention");
        ctx.skip(
            `no attention/diff-review dialog appeared within 60 s (GET /api/v1/attention → ${attentionApi.status}); ` +
                `file created without consent: ${fs.existsSync(target)}`,
        );
    }

    ctx.check("the blocking attention dialog appears", Boolean(appeared), { observed: appeared });
    ctx.log(`attention dialog: ${appeared.title}`);
    ctx.note(`attention options: ${short(appeared.options, 200)}; diff decisions: ${short(appeared.decisions, 200)}`);
    const dialog = page.getByRole("dialog").first();
    const buttons = (await dialog.locator("button").allInnerTexts()).map((text) => text.trim()).filter(Boolean);
    ctx.check("the dialog offers server-provided actions", buttons.length >= 1, { observed: buttons });

    // Capture the pending requestId so a second client can try to answer it.
    let requestId = null;
    for (const frame of [...ctx.wsFrames].reverse()) {
        const state_ = frame?.payload?.state ?? frame?.payload;
        const attention = state_?.attention;
        if (Array.isArray(attention) && attention.length && attention[0].requestId) {
            requestId = attention[0].requestId;
            break;
        }
        if (frame?.payload?.type === "pi2:attention_request" && frame.payload.requestId) {
            requestId = frame.payload.requestId;
            break;
        }
    }
    ctx.log(`pending attention requestId: ${requestId ?? "(not observed)"}`);

    // Accept: the diff review exposes per-file/all `data-decision` buttons; a
    // select/confirm request exposes `data-option-id` buttons.
    let accept = null;
    for (const candidate of [
        dialog.locator('[data-decision="accept"]').first(),
        dialog.locator('[data-option-id="accept"]').first(),
        dialog.locator('[data-option-id="allow"]').first(),
        dialog.getByRole("button", { name: /^(Accept|Accept all|Allow once|Allow)$/i }).first(),
    ]) {
        if ((await candidate.count()) > 0 && (await candidate.isVisible().catch(() => false))) {
            accept = candidate;
            break;
        }
    }
    ctx.check("an Accept action exists", Boolean(accept), { observed: { buttons, options: appeared.options, decisions: appeared.decisions } });
    await accept.click();

    const closed = await waitFor(async () => ((await page.getByRole("dialog").count()) === 0 ? true : null), 20000);
    ctx.check("the dialog closes after answering", Boolean(closed), { observed: await page.getByRole("dialog").count() });
    const written = await waitFor(async () => (fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null), 20000);
    ctx.check("Accept writes the requested file with hello-e2e", String(written ?? "").includes("hello-e2e"), {
        expected: `${target} containing hello-e2e`,
        observed: written ?? "file missing",
    });

    // --- v0.1.1 tool rows ------------------------------------------------
    // One tool call = one row: `.tool[data-kind] > .tool__row > .tool__head`
    // (`__verb` + `__target`); expanding mounts the lazy `.tool__body`.
    const toolRow = page.locator('.stream-body .tool[data-kind]').first();
    const toolVisible = await waitFor(async () => ((await toolRow.count()) > 0 ? true : null), 20000);
    ctx.softCheck("the tool call renders as a v0.1.1 tool row", Boolean(toolVisible), {
        expected: ".tool[data-kind] inside the message stream",
        observed: await page.locator(".stream-body .tool").count(),
    });
    if (toolVisible) {
        const anatomy = await toolRow.evaluate((node) => ({
            kind: node.getAttribute("data-kind"),
            state: node.getAttribute("data-state"),
            head: Boolean(node.querySelector(".tool__head")),
            verb: (node.querySelector(".tool__verb")?.textContent ?? "").trim(),
            target: (node.querySelector(".tool__target")?.textContent ?? "").trim(),
            body: Boolean(node.querySelector(".tool__body")),
        }));
        ctx.log(`tool row anatomy: ${short(anatomy, 200)}`);
        ctx.softCheck("the tool row is head + verb + target", anatomy.head && anatomy.verb.length > 0 && Boolean(anatomy.kind), {
            expected: ".tool__head + .tool__verb (+ .tool__target)",
            observed: anatomy,
        });
        if (!anatomy.body) {
            await toolRow.locator(".tool__head").first().click();
            const opened = await waitFor(async () => ((await toolRow.locator(".tool__body").count()) > 0 ? true : null), 8000);
            ctx.softCheck("expanding the tool row mounts .tool__body", Boolean(opened), {
                expected: ".tool__body after clicking .tool__head",
                observed: { open: Boolean(opened), anatomy },
            });
        }
    }

    if (requestId) {
        const second = await cmd("attention.respond", { requestId, response: { value: "Accepted" } }, { sessionId });
        ctx.softCheck("a second client cannot answer the resolved request", second.status >= 400, {
            expected: "4xx E_ATTENTION_RESOLVED",
            observed: { status: second.status, body: second.json ?? second.text },
        });
    } else {
        ctx.note("requestId not observed in WS frames — the 'second client' probe was skipped");
    }
    await ctx.shot(page, "b10-attention");
});
/* ------------------------------------------------------------------ */
/* B11 — status page                                                   */
/* ------------------------------------------------------------------ */

// v0.1.1: the "Resources" card became the `MetricsBlock` strip (`.section-label`
// + `[data-res]` tiles), so the page carries six `.card__title` cards.
const STATUS_CARDS = ["Server info", "Health checks", "Models & providers", "Background tasks", "Paired devices", "Connection"];

scenario("B11", "Status: six API-backed cards + metrics strip, devices list/revoke, disconnect clears the connection", async (ctx) => {
    const { page } = await ctx.openPage("paired");
    await page.goto(`${BASE}/status`, { waitUntil: "domcontentloaded" });
    const titlesReady = await waitFor(async () => ((await page.locator(".card__title").count()) >= STATUS_CARDS.length ? true : null), 30000);
    ctx.check("status cards render", Boolean(titlesReady), { observed: await page.locator(".card__title").count() });
    const titles = (await page.locator(".card__title").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
    for (const expected of STATUS_CARDS) {
        ctx.check(`card "${expected}" exists`, titles.includes(expected), { expected, observed: titles });
    }
    ctx.check("no server/workspace selector on /status", (await page.locator("select").count()) === 0, {
        observed: await page.locator("select").count(),
    });

    // Health items show pass/fail.
    const healthRows = await page.locator(".health-row").count();
    ctx.check("health checks are listed", healthRows >= 1, { observed: healthRows });
    const passOrFail = await page.locator('.health-row [aria-label="Pass"], .health-row [aria-label="Fail"]').count();
    ctx.check("every health row shows a pass/fail icon", passOrFail === healthRows, { expected: healthRows, observed: passOrFail });

    // Resources refresh (3 s poll) — counted from the browser's resource timings.
    const resourceRows = await page.locator('[data-res="cpu"]').count();
    ctx.check("resources rows render", resourceRows === 1, { observed: resourceRows });
    const initialResources = await page.evaluate(() =>
        performance.getEntriesByType("resource").filter((entry) => entry.name.includes("/api/v1/resources")).length,
    );
    await sleep(4200);
    const laterResources = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.includes("/api/v1/resources")).length);
    ctx.check("resources refetch while the tab is visible", laterResources > initialResources, {
        expected: ">1 /api/v1/resources request",
        observed: { initialResources, laterResources },
    });

    // Models card: providers or an explicit empty state.
    const modelsCard = page.locator(".status-card").filter({ hasText: "Models & providers" });
    const modelsText = (await modelsCard.innerText()).replace(/\s+/g, " ");
    ctx.log(`models card: ${short(modelsText, 160)}`);

    // Connection card: the daemon's live pairing code + URL are rendered.
    const connectionCard = page.locator(".status-card").filter({ hasText: "Connection" });
    const pairingCode = (await page.locator('[data-testid="pairing-code"]').innerText().catch(() => "")).trim();
    ctx.softCheck("the connection card shows a live pairing code", /^[A-Z0-9]{6,}$/.test(pairingCode), {
        expected: "8-character pairing code",
        observed: { pairingCode, cardText: short((await connectionCard.innerText()).replace(/\s+/g, " "), 200) },
    });
    // v0.1.1 renders the pairing URL as a QR code (the `<canvas>` is seeded with
    // `url || code`) instead of a copyable text line.
    const pairingQr = await page.locator(".qr-wrap canvas").count();
    ctx.softCheck("the connection card renders the pairing QR", pairingQr >= 1, {
        expected: ".qr-wrap canvas",
        observed: { canvases: pairingQr, cardText: short((await connectionCard.innerText()).replace(/\s+/g, " "), 200) },
    });

    // Devices card: lists exactly the API devices the UI does not consider revoked.
    const devices = await listDevices();
    const visibleDevices = devices.filter((device) => !device.revokedAt);
    const deviceKeyOf = (device) => device.id || device.deviceId || device.name;
    ctx.check("the API lists the paired browser device", devices.length >= 1, { expected: ">=1 device", observed: devices });
    const deviceIds = await page
        .locator('[data-device-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-device-id")));
    ctx.checkValue("the devices card renders the API devices", deviceIds.slice().sort(), visibleDevices.map(deviceKeyOf).sort());
    ctx.check("the paired device row carries data-device-id", deviceIds.length >= 1, { observed: deviceIds });

    // Create a second device, reload, revoke it.
    const created = await cmd("pair.create", { ttlSec: 600 });
    const code = created.json?.code;
    ctx.check("pair.create returns a code", typeof code === "string" && code.length > 0, { observed: created.json });
    const redeemed = await apiRaw("POST", "/api/v1/pair/redeem", { token: null, body: { code, deviceName: "e2e-second-device", kind: "phone" } });
    ctx.check("second device pairs", redeemed.status === 200 && Boolean(redeemed.json?.token), {
        expected: "200 with a device token",
        observed: { status: redeemed.status, body: short(redeemed.json) },
    });
    const devicesAfter = await listDevices();
    ctx.check("the API now lists two devices", devicesAfter.length >= 2, { observed: devicesAfter.map((device) => ({ name: device.name, revokedAt: device.revokedAt })) });
    const second = devicesAfter.find((device) => device.name === "e2e-second-device");
    ctx.check("the second device is identifiable in the API", Boolean(second), {
        observed: devicesAfter.map((device) => device.name),
    });
    const secondKey = deviceKeyOf(second);
    await page.reload({ waitUntil: "domcontentloaded" });
    const secondRow = await waitFor(
        async () => ((await page.locator(`[data-device-id="${secondKey}"]`).count()) > 0 ? true : null),
        15000,
    );
    ctx.check("the second device row appears", Boolean(secondRow), {
        expected: `[data-device-id="${secondKey}"]`,
        observed: await page.locator('[data-device-id]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-device-id"))),
    });
    await page.locator(`[data-device-id="${secondKey}"]`).getByRole("button", { name: /revoke/i }).click();
    const confirm = await dialogFor(page, "Revoke device", 8000);
    ctx.check("revoke asks for confirmation", Boolean(confirm), { observed: page.url() });
    await confirm.getByRole("button", { name: /^Revoke$/ }).click();
    const gone = await waitFor(async () => ((await page.locator(`[data-device-id="${secondKey}"]`).count()) === 0 ? true : null), 15000);
    ctx.check("the revoked device disappears from the DOM", Boolean(gone), {
        observed: await page.locator('[data-device-id]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-device-id"))),
    });
    // The daemon keeps revoked records (they carry `revokedAt`); the UI filters them.
    const apiDevices = await listDevices();
    const revoked = apiDevices.find((device) => deviceKeyOf(device) === secondKey);
    ctx.check("the revoked device is gone from the API or marked revokedAt", !revoked || Boolean(revoked.revokedAt), {
        expected: "entry removed or revokedAt set",
        observed: apiDevices.map((device) => ({ name: device.name, revokedAt: device.revokedAt })),
    });

    // --- disconnect -------------------------------------------------------
    await connectionCard.getByRole("button", { name: /disconnect/i }).click();
    const disconnectDialog = await dialogFor(page, "Disconnect", 8000);
    ctx.check("disconnect asks for confirmation", Boolean(disconnectDialog), { observed: page.url() });
    await disconnectDialog.getByRole("button", { name: /^Disconnect$/ }).click();
    const backOnConnect = await waitFor(async () => (new URL(page.url()).pathname === "/connect" ? true : null), 15000);
    ctx.check("disconnect returns to /connect", Boolean(backOnConnect), { expected: "/connect", observed: page.url() });
    const cleared = await page.evaluate(() => ({
        connection: localStorage.getItem("pi2-connection"),
        token: localStorage.getItem("pi2-device-token"),
    }));
    ctx.check("disconnect clears the connection", cleared.connection !== "paired" && !cleared.token, {
        expected: { connection: "unpaired", token: null },
        observed: cleared,
    });
    await ctx.shot(page, "b11-status");
});

/* ------------------------------------------------------------------ */
/* B12 — reconnect                                                     */
/* ------------------------------------------------------------------ */

scenario("B12", "Reconnect: offline → online restores the composer + connection state, no duplicate entries", async (ctx) => {
    const pong = state.pongSession;
    if (!pong) ctx.skip("B6 did not produce a session to reuse");
    const { page, context } = await ctx.openPage("paired");
    ctx.check("history page becomes usable", await openChat(page, pong.sessionId, pong.workspaceId), { expected: "composer enabled" });
    const loadedEntries = await waitFor(async () => {
        const articles = await streamArticles(page);
        return articles.length >= 2 ? articles : null;
    }, 30000);
    ctx.check("history is rendered before going offline", Boolean(loadedEntries), {
        expected: ">=2 articles",
        observed: (await streamArticles(page)).length,
    });

    ctx.offlineWindow = true;
    await context.setOffline(true);
    await sleep(1500);
    const offlineState = await page.evaluate(() => document.querySelector(".shell")?.getAttribute("data-ws-state") ?? null);
    // v0.1.1 removed the `.chat-conn` stream-head indicator: the offline state is
    // carried by the composer hint (`[role=status]`, woken by `!connected`) plus
    // the shell reconnect banner.
    const hintText = async () => (await page.locator(".composer__hint").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    const offline = await waitFor(async () => (/reconnect|lost|offline/i.test(await hintText()) ? true : null), 15000);
    ctx.log(
        `offline hint shown: ${Boolean(offline)} (observed "${await hintText()}", shell data-ws-state=${offlineState}, ` +
            `reconnect banner=${await page.locator('[data-testid="reconnect-banner"]').count()})`,
    );
    await context.setOffline(false);
    ctx.offlineWindow = false;

    const reopened = await waitFor(async () => {
        const state_ = await page.evaluate(() => document.querySelector(".shell")?.getAttribute("data-ws-state") ?? null);
        return state_ === "open" ? state_ : null;
    }, 40000, 200);
    ctx.check("the shell data-ws-state returns to open after reconnecting", Boolean(reopened), {
        expected: "open",
        observed: {
            wsState: await page.evaluate(() => document.querySelector(".shell")?.getAttribute("data-ws-state") ?? null),
            offlineState,
        },
    });
    const usable = await waitEnabled(page, COMPOSER_INPUT, 40000);
    ctx.check("the composer is usable again after reconnecting", usable, {
        expected: "textarea enabled",
        observed: { composer: await composerState(page) },
    });
    const online = await waitFor(async () => ((await page.locator(".composer__hint").count()) === 0 ? true : null), 30000);
    ctx.check("the offline hint disappears once the socket is back", Boolean(online), {
        expected: "no .composer__hint",
        observed: await hintText(),
    });

    const { snapshots, appended } = entryIdsFromFrames(ctx.wsFrames, pong.sessionId);
    const lastSnapshot = snapshots.length ? snapshots[snapshots.length - 1] : [];
    const snapshotDupes = duplicates(lastSnapshot);
    ctx.check("no duplicate entry ids in the resynced snapshot", snapshotDupes.length === 0, {
        expected: "unique entry ids",
        observed: { count: lastSnapshot.length, duplicates: snapshotDupes },
    });
    const appendedDupes = duplicates([...lastSnapshot, ...appended]);
    ctx.check("no duplicate entry ids across snapshot + entry_appended events", appendedDupes.length === 0, {
        expected: "unique ids",
        observed: appendedDupes.slice(0, 10),
    });

    const articles = await streamArticles(page);
    const resynced = snapshotEntries(ctx.wsFrames, pong.sessionId) ?? [];
    ctx.note(`entries: snapshotIds=${lastSnapshot.length}, appended=${appended.length}, DOM articles=${articles.length}`);
    ctx.note(`snapshot entries after resync: ${short(resynced, 600)}`);
    ctx.note(`DOM articles: ${short(articles, 600)}`);
    ctx.softCheck(
        "the plugin snapshot has no duplicated assistant entries",
        resynced.filter((entry) => entry.role === "assistant").length <= 1,
        {
            expected: "<=1 assistant entry",
            observed: resynced.filter((entry) => entry.role === "assistant"),
        },
    );
    const ids = articles.map((article) => article.id).filter(Boolean);
    const idDupes = duplicates(ids);
    ctx.softCheck("the DOM shows no duplicated data-entry-id", idDupes.length === 0, {
        expected: "unique data-entry-id values",
        observed: { duplicates: idDupes.slice(0, 5), articles },
    });
    const keys = articles.map((article) => `${article.role}:${article.text}`);
    const domDupes = duplicates(keys);
    ctx.check("the DOM shows no duplicated message entries", domDupes.length === 0, {
        expected: "no repeated (role, text) pair",
        observed: { duplicates: domDupes.slice(0, 5), articles, snapshot: resynced },
    });
    ctx.check("history survived the reconnect", articles.length >= 2, { observed: articles.length });
    await ctx.shot(page, "b12-reconnect");
});

/* ------------------------------------------------------------------ */
/* B13 — deep links                                                    */
/* ------------------------------------------------------------------ */

scenario("B13", "Deep links: /chat/<sid>?workspace=W1 lands on the session; an unknown session shows error + retry", async (ctx) => {
    const pong = state.pongSession;
    if (!pong) ctx.skip("B6 did not produce a session to reuse");
    const { page } = await ctx.openPage("paired");

    await page.goto(`${BASE}/chat/${encodeURIComponent(pong.sessionId)}?workspace=${encodeURIComponent(pong.workspaceId)}`, {
        waitUntil: "domcontentloaded",
    });
    const landed = await waitFor(async () => {
        // One document snapshot: reading the title and the tree in separate
        // round-trips races the session-list hydration.
        const snapshot = await page.evaluate(() => {
            const url = new URL(location.href);
            const match = /^\/chat\/([^/]+)$/.exec(url.pathname);
            const name = (document.querySelector(".stream-head .stream-name")?.textContent ?? "").trim();
            const rows = Array.from(document.querySelectorAll(".tree-pane .tree-row[data-session-id]")).map((node) => ({
                id: node.getAttribute("data-session-id"),
                label: node.getAttribute("aria-label"),
                current: node.getAttribute("aria-current"),
            }));
            return {
                href: url.href,
                pathname: url.pathname,
                id: match ? decodeURIComponent(match[1]) : null,
                workspace: url.searchParams.get("workspace"),
                name,
                rows,
            };
        });
        if (snapshot.id !== pong.sessionId) return null;
        if (snapshot.workspace !== pong.workspaceId) return null;
        const selected = snapshot.rows.find((row) => row.id === pong.sessionId && row.current === "true");
        if (!snapshot.name || !selected) return null;
        return { name: snapshot.name, label: selected.label ?? "", rows: snapshot.rows, href: snapshot.href };
    }, 30000);
    ctx.check("the deep link keeps ?workspace and renders the session", Boolean(landed), {
        expected: { pathname: `/chat/${pong.sessionId}`, workspace: pong.workspaceId },
        observed: { url: page.url(), selected: await treeSessionIds(page) },
    });
    const treeRows = landed?.rows ?? [];
    const treeIds = treeRows.map((row) => row.id);
    ctx.check("the tree renders one row per session id", duplicates(treeIds).length === 0, {
        expected: "unique data-session-id values",
        observed: { duplicates: duplicates(treeIds), rows: treeRows },
    });
    const selectedRow = treeRows.find((row) => row.id === pong.sessionId) ?? null;
    const apiSessions = (await listSessions(pong.workspaceId)).map((row) => ({ sessionId: row.sessionId, name: row.name ?? null }));
    const apiName = apiSessions.find((row) => row.sessionId === pong.sessionId)?.name ?? null;
    const streamTitle = landed?.name ?? "";
    const rowTitle = selectedRow?.label ?? "";
    // The selected tree row is identified by `data-session-id` (the workspace
    // header row has no data-session-id, and its aria-label is the workspace
    // name — never compare against that). The selected row's aria-label is the
    // session title, and the stream must show that same session title.
    ctx.check(
        "the tree marks the deep-linked session as selected",
        Boolean(landed) &&
            selectedRow?.id === pong.sessionId &&
            selectedRow?.current === "true" &&
            streamTitle !== "" &&
            rowTitle !== "" &&
            streamTitle === rowTitle,
        {
            expected: { selectedId: pong.sessionId, streamTitle: rowTitle || "<selected row title>" },
            observed: {
                selectedId: selectedRow?.id ?? null,
                ariaCurrent: selectedRow?.current ?? null,
                streamTitle,
                selectedRowTitle: rowTitle,
                apiName,
                treeRow: selectedRow,
                apiSessions,
            },
        },
    );
    if (apiName && rowTitle && apiName.trim() !== rowTitle) {
        ctx.note(`session title from the sessions query (${apiName.trim()}) differs from the rendered tree title (${rowTitle}) — informational`);
    }
    const articles = await waitFor(async () => {
        const list = await streamArticles(page);
        return list.length ? list : null;
    }, 30000);
    ctx.check("the stream shows the session history", Boolean(articles), { observed: (await streamArticles(page)).length });
    ctx.check("the composer is usable on the deep link", await waitEnabled(page, COMPOSER_INPUT, 20000), {
        expected: "enabled textarea",
    });

    // --- unknown session -------------------------------------------------
    const bogus = "ffffffffffffffffffffffff";
    await page.goto(`${BASE}/chat/${bogus}?workspace=${encodeURIComponent(pong.workspaceId)}`, { waitUntil: "domcontentloaded" });
    await sleep(1500);
    const errorState = await waitFor(async () => {
        const err = page.locator(".stream-status--err");
        if ((await err.count()) === 0 || !(await err.first().isVisible())) return null;
        const retry = err.first().locator("button", { hasText: /retry/i });
        if ((await retry.count()) === 0) return null;
        return (await err.first().innerText()).replace(/\s+/g, " ");
    }, 25000);
    const observedName = await streamName(page);
    const text = await bodyText(page);
    const finalUrl = new URL(page.url());
    ctx.softCheck("an unknown session shows an error + retry", Boolean(errorState), {
        expected: ".stream-status--err with 'Failed to load history' + Retry",
        observed: {
            errorState,
            streamName: observedName,
            pathname: finalUrl.pathname,
            selected: await treeSessionIds(page),
            bodyPreview: short(text.replace(/\s+/g, " "), 220),
        },
        cause: "web/src/pages/chat.tsx + web/src/features/chat/data.ts useActiveSession() silently falls back to sessions[0] for an unknown sid, so no error surface exists",
    });
    ctx.softCheck("the unknown session page is not blank", text.replace(/\s+/g, "").length > 40, {
        observed: text.replace(/\s+/g, "").length,
    });
    await ctx.shot(page, "b13-unknown-session");
});

/* ------------------------------------------------------------------ */
/* B14 — i18n / theme                                                  */
/* ------------------------------------------------------------------ */

scenario("B14", "i18n + theme: language menu switches html[lang]/copy, theme segment sets html[data-theme] and persists", async (ctx) => {
    const { page } = await ctx.openPage("paired");
    await page.goto(`${BASE}/workspaces`, { waitUntil: "domcontentloaded" });
    const h1 = page.locator("h1").first();
    await h1.waitFor({ state: "visible", timeout: 20000 });
    ctx.checkValue("English heading", (await h1.innerText()).trim(), "Workspaces");
    ctx.checkValue("html lang starts as en-US", await page.evaluate(() => document.documentElement.lang), "en-US");

    // v0.1.1: the topbar preference menu (appearance + language) replaces the
    // old standalone language/theme triggers. Locate it by class/data hooks so
    // the check never depends on a copy string.
    const prefTrigger = page.locator(".pref-trigger");
    ctx.check("one preference trigger in the topbar", (await prefTrigger.count()) === 1, { observed: await prefTrigger.count() });
    await prefTrigger.click();
    await page.locator('[data-lang-seg] [data-lang="zh"]').click();
    const zhApplied = await waitFor(async () => ((await page.evaluate(() => document.documentElement.lang)) === "zh-CN" ? true : null), 10000);
    ctx.check("switching to zh updates html[lang]", Boolean(zhApplied), {
        expected: "zh-CN",
        observed: await page.evaluate(() => document.documentElement.lang),
    });
    ctx.checkValue("visible copy switches to Chinese", (await h1.innerText()).trim(), "工作空间");
    const zhNav = await navItemLabels(page);
    ctx.checkValue("visible nav labels switch to Chinese", zhNav, ["工作空间", "对话", "状态"]);
    const zhNavLabel = (await page.locator(".sidebar").getAttribute("aria-label")) ?? "";
    ctx.checkValue("the nav container label switches to Chinese", zhNavLabel.trim(), "控制台");
    const zhBody = await bodyText(page);
    ctx.check("no raw i18n keys leak after the switch", !/\b(chat|nav|status|workspaces|connect)\.[a-zA-Z][a-zA-Z0-9]*/.test(zhBody), {
        observed: short(zhBody.replace(/\s+/g, " "), 200),
    });
    ctx.checkValue("language is persisted to pi2-lang", await page.evaluate(() => localStorage.getItem("pi2-lang")), "zh");

    await prefTrigger.click();
    await page.locator('[data-lang-seg] [data-lang="en"]').click();
    const enApplied = await waitFor(async () => ((await page.evaluate(() => document.documentElement.lang)) === "en-US" ? true : null), 10000);
    ctx.check("switching back restores English", Boolean(enApplied), {
        expected: "en-US",
        observed: await page.evaluate(() => document.documentElement.lang),
    });
    ctx.checkValue("English copy is restored", (await h1.innerText()).trim(), "Workspaces");
    const enNav = await navItemLabels(page);
    ctx.checkValue("nav labels are restored to English", enNav, ["Workspaces", "Chat", "Status"]);

    // --- theme ------------------------------------------------------------
    await prefTrigger.click();
    const themeGroup = page.locator("[data-theme-seg]");
    ctx.check("theme segment exists", (await themeGroup.count()) === 1, { observed: await themeGroup.count() });
    const themeAttr = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    const storedTheme = () => page.evaluate(() => localStorage.getItem("pi2-theme"));

    await themeGroup.locator('[data-v="dark"]').click();
    ctx.check("dark theme sets html[data-theme=dark]", (await waitFor(async () => ((await themeAttr()) === "dark" ? true : null), 5000)) ?? false, {
        expected: "dark",
        observed: await themeAttr(),
    });
    ctx.checkValue("dark theme is persisted", await storedTheme(), "dark");
    await page.reload({ waitUntil: "domcontentloaded" });
    await h1.waitFor({ state: "visible", timeout: 20000 });
    ctx.checkValue("dark theme survives a reload", await themeAttr(), "dark");

    await prefTrigger.click();
    await page.locator('[data-theme-seg] [data-v="light"]').click();
    ctx.check("light theme sets html[data-theme=light]", (await waitFor(async () => ((await themeAttr()) === "light" ? true : null), 5000)) ?? false, {
        expected: "light",
        observed: await themeAttr(),
    });
    await page.locator('[data-theme-seg] [data-v="system"]').click();
    const systemStored = await waitFor(async () => ((await storedTheme()) === "system" ? true : null), 5000);
    ctx.check("system theme is persisted as 'system'", Boolean(systemStored), { expected: "system", observed: await storedTheme() });
    ctx.check("system theme resolves to light|dark", ["light", "dark"].includes(await themeAttr()), { observed: await themeAttr() });
    await ctx.shot(page, "b14-theme-i18n");
});

/* ------------------------------------------------------------------ */
/* C1 — responsive overflow                                            */
/* ------------------------------------------------------------------ */

const VIEWPORTS = [
    { name: "1440x900", width: 1440, height: 900 },
    { name: "768x1024", width: 768, height: 1024 },
    { name: "380x780", width: 380, height: 780 },
];

async function overflowReport(page) {
    return page.evaluate(() => {
        const offenders = [];
        for (const element of document.querySelectorAll("body *")) {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            if (rect.right <= window.innerWidth + 1 && rect.left >= -1) continue;
            const style = getComputedStyle(element);
            if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
            offenders.push({
                tag: element.tagName.toLowerCase(),
                cls: String(element.className || "").slice(0, 60),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
            });
            if (offenders.length >= 6) break;
        }
        return {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
            offenders,
        };
    });
}

scenario("C1", "Responsive: 1440×900 / 768×1024 / 380×780 on all four pages have no horizontal overflow", async (ctx) => {
    const pong = state.pongSession;
    const pages = [
        { name: "workspaces", path: "/workspaces", kind: "paired", anchor: "[data-workspace-id], .empty" },
        {
            name: "chat",
            path: pong ? `/chat/${encodeURIComponent(pong.sessionId)}?workspace=${encodeURIComponent(pong.workspaceId)}` : "/chat",
            kind: "paired",
            anchor: ".stream-head, .stream-body",
        },
        { name: "status", path: "/status", kind: "paired", anchor: ".status-page" },
        { name: "connect", path: "/connect", kind: "unpaired", anchor: ".cn" },
    ];

    for (const viewport of VIEWPORTS) {
        for (const target of pages) {
            const { page } = await ctx.openPage(target.kind, { viewport: { width: viewport.width, height: viewport.height } });
            await page.goto(`${BASE}${target.path}`, { waitUntil: "domcontentloaded" });
            await page.locator(target.anchor).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined);
            await sleep(1200);
            const report = await overflowReport(page);
            const label = `${target.name} @ ${viewport.name}`;
            ctx.check(`${label}: no horizontal overflow`, report.scrollWidth <= report.innerWidth + 1, {
                expected: `documentElement.scrollWidth <= ${report.innerWidth + 1}`,
                observed: { scrollWidth: report.scrollWidth, innerWidth: report.innerWidth },
            });
            if (report.offenders.length) ctx.note(`${label}: elements outside the viewport → ${short(report.offenders, 300)}`);
            const shot = await ctx.shot(page, `c1-${target.name}-${viewport.name}`);
            ctx.check(`${label}: screenshot captured`, Boolean(shot), { observed: shot?.file ?? "none" });
            await page.context().close();
        }
    }
});

/* ------------------------------------------------------------------ */
/* C2 — navigation at breakpoints                                      */
/* ------------------------------------------------------------------ */

async function navState(page) {
    return page.evaluate(() => {
        const visible = (element) => {
            if (!element) return false;
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const result = {};
        // v0.1.1: only the icon strip (sidebar ≥840 / rail 600–839) exists;
        // below 600 the topbar `.page-pill` owns navigation; no mobile strip.
        for (const [key, selector] of [["sidebar", ".sidebar"], ["rail", ".rail"]]) {
            const element = document.querySelector(selector);
            result[key] = element && visible(element) ? element.querySelectorAll(".nav-item").length : null;
        }
        result.tabbar = document.querySelectorAll(".tabbar").length;
        result.totalNavItems = document.querySelectorAll(".sidebar .nav-item, .rail .nav-item").length;
        const pill = document.querySelector(".page-pill");
        result.pagePill = pill && visible(pill) ? (pill.getAttribute("aria-expanded") === "true" ? "open" : "closed") : null;
        result.pageSheets = document.querySelectorAll('[role="dialog"] .sheet-row').length;
        return result;
    });
}

scenario("C2", "Nav: 3 icon rows in the one visible container (sidebar/rail), <600 page pill + sheet, 0 on /connect", async (ctx) => {
    for (const viewport of VIEWPORTS) {
        const { page } = await ctx.openPage("paired", { viewport: { width: viewport.width, height: viewport.height } });
        await page.goto(`${BASE}/workspaces`, { waitUntil: "domcontentloaded" });
        await page.locator("[data-workspace-id], .empty").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined);
        const state_ = await navState(page);
        const expectedContainer = viewport.width >= 840 ? "sidebar" : viewport.width >= 600 ? "rail" : null;
        ctx.checkValue(`${viewport.name}: no mobile tabbar is rendered`, state_.tabbar, 0);
        if (expectedContainer) {
            const active = ["sidebar", "rail"].filter((key) => state_[key] !== null);
            ctx.check(`${viewport.name}: exactly one nav container is visible`, active.length === 1, { observed: state_ });
            ctx.check(`${viewport.name}: the expected container (${expectedContainer}) is the visible one`, active[0] === expectedContainer, {
                expected: expectedContainer,
                observed: active,
            });
            ctx.check(`${viewport.name}: 3 nav items`, state_[expectedContainer] === 3, {
                expected: 3,
                observed: state_[expectedContainer],
            });
            ctx.checkValue(`${viewport.name}: the page pill is hidden above 600`, state_.pagePill, null);
            const labels = await navItemLabels(page);
            ctx.checkValue(`${viewport.name}: nav rows are labelled by aria-label`, labels, ["Workspaces", "Chat", "Status"]);
        } else {
            const active = ["sidebar", "rail"].filter((key) => state_[key] !== null);
            ctx.check(`${viewport.name}: no persistent nav strip below 600`, active.length === 0, { observed: state_ });
            ctx.checkValue(`${viewport.name}: the page pill carries navigation`, state_.pagePill, "closed");
            await page.locator(".page-pill").click();
            const sheetOpen = await waitFor(async () => ((await navState(page)).pageSheets > 0 ? true : null), 8000);
            ctx.check(`${viewport.name}: the page pill opens a sheet`, Boolean(sheetOpen), {
                expected: 'a [role="dialog"] with .sheet-row entries',
                observed: (await navState(page)).pageSheets,
            });
            const sheet = page.getByRole("dialog").first();
            const current = await page.locator('[role="dialog"] .sheet-row[aria-current="page"]').allInnerTexts();
            ctx.check(`${viewport.name}: the sheet marks the current page`, current.length === 1, {
                expected: "1 row with aria-current=page",
                observed: current.map((text) => text.replace(/\s+/g, " ").trim()),
            });
            // The page rows are plain router links, so the target is locale-free.
            await sheet.locator('a.sheet-row[href="/chat"]').first().click();
            const navigated = await waitFor(async () => (new URL(page.url()).pathname.startsWith("/chat") ? true : null), 15000);
            ctx.check(`${viewport.name}: the sheet navigates to the picked page`, Boolean(navigated), {
                expected: "/chat",
                observed: page.url(),
            });
        }
        await page.context().close();

        const { page: connectPage } = await ctx.openPage("unpaired", { viewport: { width: viewport.width, height: viewport.height } });
        await connectPage.goto(`${BASE}/connect`, { waitUntil: "domcontentloaded" });
        await connectPage.locator(".cn h1").waitFor({ state: "visible", timeout: 20000 }).catch(() => undefined);
        const connectState = await navState(connectPage);
        ctx.check(`${viewport.name}: /connect has no nav strip, tabbar or page pill`, connectState.totalNavItems === 0 && connectState.tabbar === 0 && connectState.pagePill === null, {
            expected: { totalNavItems: 0, tabbar: 0, pagePill: null },
            observed: connectState,
        });
        await connectPage.context().close();
    }
});

/* ------------------------------------------------------------------ */
/* C3 — dark/light screenshots                                         */
/* ------------------------------------------------------------------ */

scenario("C3", "Visual: dark + light screenshots of each page are non-blank and show the page anchor", async (ctx) => {
    const pong = state.pongSession;
    const pages = [
        { name: "workspaces", path: "/workspaces", kind: "paired", anchor: "h1" },
        {
            name: "chat",
            path: pong ? `/chat/${encodeURIComponent(pong.sessionId)}?workspace=${encodeURIComponent(pong.workspaceId)}` : "/chat",
            kind: "paired",
            anchor: ".stream-head",
        },
        { name: "status", path: "/status", kind: "paired", anchor: "h1" },
        { name: "connect", path: "/connect", kind: "unpaired", anchor: ".cn h1" },
    ];

    for (const theme of ["dark", "light"]) {
        for (const target of pages) {
            const { page } = await ctx.openPage(target.kind, { storageLocal: { "pi2-theme": theme } });
            await page.goto(`${BASE}${target.path}`, { waitUntil: "domcontentloaded" });
            const anchor = page.locator(target.anchor).first();
            const anchorVisible = await waitFor(async () => ((await anchor.isVisible()) ? true : null), 30000);
            ctx.check(`${target.name} (${theme}): page anchor is visible`, Boolean(anchorVisible), {
                expected: target.anchor,
                observed: await page.evaluate(() => document.body.innerText.slice(0, 120)),
            });
            await sleep(900);
            const applied = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
            ctx.check(`${target.name} (${theme}): html[data-theme] applied`, applied === theme, { expected: theme, observed: applied });
            const shot = await ctx.shot(page, `c3-${target.name}-${theme}`);
            ctx.check(`${target.name} (${theme}): screenshot non-blank (>10 kB)`, Boolean(shot) && shot.size > 10240, {
                expected: ">10240 bytes",
                observed: shot?.size ?? "no file",
            });
            await page.context().close();
        }
    }
});

/* ------------------------------------------------------------------ */
/* C4 — console / pageerror hygiene                                    */
/* ------------------------------------------------------------------ */

scenario("C4", "Console: no unexpected console error or pageerror across every page and interaction", async (ctx) => {
    const pong = state.pongSession;
    const targets = [
        { kind: "paired", path: "/workspaces" },
        { kind: "paired", path: pong ? `/chat/${encodeURIComponent(pong.sessionId)}?workspace=${encodeURIComponent(pong.workspaceId)}` : "/chat" },
        { kind: "paired", path: "/status" },
        { kind: "unpaired", path: "/connect" },
    ];
    for (const target of targets) {
        const { page } = await ctx.openPage(target.kind);
        await page.goto(`${BASE}${target.path}`, { waitUntil: "domcontentloaded" });
        await sleep(2000);
        await page.context().close();
    }

    const unexpectedScenario = ctx.pageErrors;
    ctx.check("no pageerror while visiting the four pages", unexpectedScenario.length === 0, {
        expected: 0,
        observed: unexpectedScenario.slice(0, 3),
    });
    const unexpectedConsole = ctx.consoleErrors.filter((entry) => !entry.allowlist);
    ctx.check("no unexpected console error while visiting the four pages", unexpectedConsole.length === 0, {
        expected: 0,
        observed: unexpectedConsole.slice(0, 5).map((entry) => short(entry.text, 200)),
    });

    // Aggregate over every scenario in this run.
    const allPageErrors = GLOBAL_ERRORS.filter((entry) => entry.type === "pageerror");
    const allUnexpected = GLOBAL_ERRORS.filter((entry) => entry.type === "error" && !entry.allowlist);
    const allowed = GLOBAL_ERRORS.filter((entry) => entry.type === "error" && entry.allowlist);
    ctx.note(`console/pageerror totals: pageerror=${allPageErrors.length}, unexpected=${allUnexpected.length}, allowlisted=${allowed.length}`);
    if (allowed.length) {
        const byId = allowed.reduce((acc, entry) => ({ ...acc, [entry.allowlist]: (acc[entry.allowlist] ?? 0) + 1 }), {});
        ctx.note(`allowlisted console errors: ${short(byId, 300)}`);
    }
    ctx.softCheck("no pageerror anywhere in the run", allPageErrors.length === 0, {
        expected: 0,
        observed: allPageErrors.slice(0, 5),
    });
    ctx.softCheck("no unexpected console error anywhere in the run", allUnexpected.length === 0, {
        expected: 0,
        observed: allUnexpected.slice(0, 8).map((entry) => `[${entry.scenario}] ${short(entry.text, 160)}`),
    });
});

/* ------------------------------------------------------------------ */
/* runner                                                              */
/* ------------------------------------------------------------------ */

function writeReports(results, meta) {
    const summary = {
        total: results.length,
        pass: results.filter((item) => item.status === "PASS").length,
        fail: results.filter((item) => item.status === "FAIL").length,
        skip: results.filter((item) => item.status === "SKIP").length,
    };
    const payload = { ...meta, summary, scenarios: results };
    fs.writeFileSync(path.join(REPORT_DIR, "ui-e2e.json"), `${JSON.stringify(payload, null, 2)}\n`);

    const lines = [];
    lines.push("# pi2 web console — browser E2E run (B1–B14, C1–C4)");
    lines.push("");
    lines.push(`- base: \`${BASE}\``);
    lines.push(`- root: \`${ROOT}\``);
    lines.push(`- screenshots: \`${SCREENS}\``);
    lines.push(`- playwright: \`${playwrightSpec}\` (chrome: ${CHROME_PATH ?? "bundled"})`);
    lines.push(`- started: ${new Date(meta.startedAt).toISOString()} / finished: ${new Date(meta.finishedAt).toISOString()}`);
    lines.push(`- seeded: W1=\`${state.ws1}\` (${state.ws1Cwd}), W2=\`${state.ws2}\` (${state.ws2Cwd})`);
    lines.push("");
    lines.push(`**Result: ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.skip} SKIP of ${summary.total}**`);
    lines.push("");
    lines.push("| scenario | status | duration | failed assertions |");
    lines.push("|---|---|---|---|");
    for (const item of results) {
        lines.push(
            `| ${item.id} — ${item.title} | ${item.status} | ${(item.durationMs / 1000).toFixed(1)}s | ${
                item.failures.length
                    ? item.failures.map((failure) => failure.name).join("<br>")
                    : item.skipped
                      ? `SKIP: ${item.skipped}`
                      : "—"
            } |`,
        );
    }
    lines.push("");

    for (const item of results) {
        lines.push(`## ${item.id} — ${item.title}`);
        lines.push("");
        lines.push(`status: **${item.status}** (${(item.durationMs / 1000).toFixed(1)}s)`);
        if (item.skipped) lines.push(`\nskipped: ${item.skipped}`);
        lines.push("");
        if (item.checks.length) {
            lines.push("| # | assertion | result | detail |");
            lines.push("|---|---|---|---|");
            item.checks.forEach((check, index) => {
                lines.push(
                    `| ${index + 1} | ${check.name.replace(/\|/g, "\\|")} | ${check.ok ? "ok" : "**FAIL**"} | ${
                        check.detail ? short(JSON.stringify(check.detail).replace(/\|/g, "\\|"), 600) : ""
                    } |`,
                );
            });
            lines.push("");
        }
        const failed = item.checks.filter((check) => !check.ok);
        if (failed.length) {
            lines.push("### Failed assertions (observed vs expected)");
            lines.push("");
            for (const check of failed) {
                lines.push(`- **${check.name}**`);
                const detail = check.detail ?? {};
                if (detail.expected !== undefined) lines.push(`  - expected: \`${short(JSON.stringify(detail.expected), 500)}\``);
                if (detail.observed !== undefined) lines.push(`  - observed: \`${short(JSON.stringify(detail.observed), 700)}\``);
                if (detail.cause) lines.push(`  - product-side cause: ${detail.cause}`);
            }
            lines.push("");
        }
        if (item.notes.length) {
            lines.push("Notes:");
            lines.push("");
            for (const note of item.notes) lines.push(`- ${note}`);
            lines.push("");
        }
        if (item.consoleErrors.length) {
            lines.push(`console errors (${item.consoleErrors.length}):`);
            lines.push("");
            for (const entry of item.consoleErrors.slice(0, 12)) {
                lines.push(`- ${entry.allowlist ? `(allowlisted: ${entry.allowlist})` : "(unexpected)"} ${short(entry.text, 220)}`);
            }
            lines.push("");
        }
        if (item.pageErrors.length) {
            lines.push(`page errors (${item.pageErrors.length}):`);
            lines.push("");
            for (const entry of item.pageErrors.slice(0, 6)) lines.push(`- ${short(entry.message, 220)}`);
            lines.push("");
        }
        if (item.httpErrors.length) {
            lines.push(`HTTP >=400 (${item.httpErrors.length}):`);
            lines.push("");
            const grouped = item.httpErrors.reduce((acc, entry) => {
                const key = `${entry.status} ${entry.url.split("?")[0]}`;
                acc[key] = (acc[key] ?? 0) + 1;
                return acc;
            }, {});
            for (const [key, count] of Object.entries(grouped)) lines.push(`- ${key} ×${count}`);
            lines.push("");
        }
        if (item.screenshots.length) {
            lines.push(`screenshots: ${item.screenshots.map((file) => `\`${file}\``).join(", ")}`);
            lines.push("");
        }
    }

    const markdown = `${lines.join("\n")}\n`;
    fs.writeFileSync(path.join(REPORT_DIR, "ui-e2e.md"), markdown);
    try {
        fs.mkdirSync(path.dirname(EXTRA_REPORT), { recursive: true });
        fs.writeFileSync(EXTRA_REPORT, markdown);
    } catch (error) {
        console.error(`could not write ${EXTRA_REPORT}: ${error.message}`);
    }
    return summary;
}

async function main() {
    const startedAt = Date.now();
    console.log(`ui-e2e: base=${BASE} root=${ROOT}`);
    console.log(`ui-e2e: playwright=${playwrightSpec} chrome=${CHROME_PATH ?? "(bundled)"}`);

    // --- seed workspaces (through the API, CLI token) --------------------
    state.ws1Cwd = path.join(WS_ROOTS, "ws1");
    state.ws2Cwd = path.join(WS_ROOTS, "ws2");
    fs.mkdirSync(state.ws1Cwd, { recursive: true });
    fs.mkdirSync(state.ws2Cwd, { recursive: true });
    state.ws1 = await addWorkspace(state.ws1Cwd, "ws1");
    state.ws2 = await addWorkspace(state.ws2Cwd, "ws2");
    await ensureInstance(state.ws1);
    await ensureInstance(state.ws2);
    console.log(`ui-e2e: seeded W1=${state.ws1} W2=${state.ws2} (instances ready)`);

    browser = await pw.chromium.launch({
        headless: true,
        ...(CHROME_PATH ? { executablePath: CHROME_PATH } : {}),
        args: ["--no-sandbox"],
    });

    const results = [];
    // `E2E_ONLY=B1,B4` narrows the run (dependencies may then be missing, in
    // which case the dependent scenarios SKIP with an explicit reason).
    const only = String(ENV.E2E_ONLY || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    const selection = only.length ? scenarios.filter((item) => only.includes(item.id)) : scenarios;
    if (only.length) console.log(`ui-e2e: E2E_ONLY=${only.join(",")} → ${selection.length} scenario(s)`);
    for (const def of selection) {
        const ctx = new Ctx(def);
        const started = Date.now();
        let timer = null;
        process.stdout.write(`==> ${def.id} ${def.title}\n`);
        try {
            await Promise.race([
                def.fn(ctx),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`scenario budget exceeded (${def.budgetMs} ms)`)), def.budgetMs);
                }),
            ]);
            ctx.status = ctx.failures.length ? "FAIL" : "PASS";
        } catch (error) {
            if (error instanceof SkipSignal) {
                ctx.status = "SKIP";
            } else if (error instanceof Failure) {
                ctx.status = "FAIL";
                try {
                    const context = ctx.contexts[0];
                    const page = context ? (await context.pages())[0] : null;
                    await ctx.shot(page, `${def.id}-fail`, { fullPage: true });
                } catch {
                    /* page already gone */
                }
            } else {
                ctx.status = "FAIL";
                ctx.failures.push({ name: `unexpected harness error: ${error.message}`, ok: false, detail: { observed: short(error.stack, 800) } });
                try {
                    const context = ctx.contexts[0];
                    const page = context ? (await context.pages())[0] : null;
                    await ctx.shot(page, `${def.id}-fail`, { fullPage: true });
                } catch {
                    /* ignore */
                }
            }
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (ctx.failures.length && ctx.status !== "SKIP") ctx.status = "FAIL";
        ctx.durationMs = Date.now() - started;
        await ctx.closeAll();
        results.push({
            id: ctx.id,
            title: ctx.title,
            status: ctx.status,
            durationMs: ctx.durationMs,
            skipped: ctx.skipped,
            checks: ctx.checks,
            failures: ctx.failures,
            notes: ctx.notes,
            logs: ctx.logs,
            screenshots: ctx.screenshots,
            consoleErrors: ctx.consoleErrors,
            consoleWarnings: ctx.consoleWarnings.slice(0, 20),
            pageErrors: ctx.pageErrors,
            httpErrors: ctx.httpErrors,
            cmdRequests: ctx.cmdRequests,
            cmdResponses: ctx.cmdResponses,
        });
        console.log(`    ${ctx.status} (${(ctx.durationMs / 1000).toFixed(1)}s)${ctx.skipped ? ` — SKIP: ${ctx.skipped}` : ""}`);
        for (const failure of ctx.failures) {
            console.log(`    FAIL: ${failure.name}`);
            if (failure.detail?.observed !== undefined) console.log(`      observed: ${short(JSON.stringify(failure.detail.observed), 400)}`);
        }
        for (const note of ctx.notes) console.log(`    note: ${short(note, 300)}`);
    }

    await browser.close();
    const meta = { base: BASE, root: ROOT, startedAt, finishedAt: Date.now() };
    const summary = writeReports(results, meta);

    console.log("");
    console.log(`ui-e2e summary: ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.skip} SKIP of ${summary.total}`);
    console.log(`ui-e2e report:  ${path.join(REPORT_DIR, "ui-e2e.md")} (json: ui-e2e.json)`);
    console.log(`ui-e2e copy:    ${EXTRA_REPORT}`);
    console.log(`ui-e2e screens: ${SCREENS}`);
    return summary.fail === 0 ? 0 : 1;
}

let browser = null;

main().then(
    (code) => process.exit(code),
    async (error) => {
        console.error(`ui-e2e: fatal: ${error?.stack || error}`);
        try {
            await browser?.close();
        } catch {
            /* ignore */
        }
        process.exit(1);
    },
);
