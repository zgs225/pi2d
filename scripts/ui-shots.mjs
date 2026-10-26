#!/usr/bin/env node
/**
 * Visual acceptance harness for the pi2 web console (WS-F in
 * `/tmp/pi2d-port/PLAN.md` §3.3).
 *
 * Shoots the built console (`web/dist`) through the zero-dependency fixture
 * server (`scripts/ui-mock-server.mjs`), across 4 pages × 3 viewports × 2
 * themes, and asserts the parity invariants that a screenshot alone cannot
 * prove: no console error, no horizontal overflow, no `.tabbar`, no navigation
 * on `/connect`, and the per-page primary-button budget (workspaces = 1,
 * status = 0, connect = 1).
 *
 * Usage:
 *   pnpm --dir web build                                   # prerequisite
 *   node scripts/ui-shots.mjs --serve-static --round r1 --out /tmp/pi2d-port/shots/r1
 *   node scripts/ui-shots.mjs --base http://127.0.0.1:7676  # against a real daemon
 *   node scripts/ui-shots.mjs --serve-static --matrix=quick # 1440×900 × light/dark
 *
 * Options:
 *   --serve-static        spawn the mock daemon and serve `web/dist` from it
 *   --base <url>          shoot an already running daemon instead (implies no spawn)
 *   --out <dir>           output dir (default: /tmp/pi2d-port/shots/<round>)
 *   --round <label>       label recorded in the report (default: "adhoc")
 *   --matrix full|quick   full = 24 shots, quick = 1440×900 × light/dark = 8
 *   --static-dir <dir>    build output to serve (default: web/dist)
 *   --timeout <ms>        per-shot settle budget (default: 12000)
 *
 * Artifacts: `<out>/<page>-<w>x<h>-<theme>.png` (24 files in `full`) and
 * `<out>/report.json`. Exit code: 0 all assertions pass, 1 otherwise, 2 when
 * the harness itself cannot start (no build, no browser, no server).
 *
 * Design rules: Playwright is *resolved*, never added as a dependency (same
 * loader as `scripts/e2e/ui-e2e.mjs`); nothing here patches product code, so a
 * failing assertion means a real visual regression and must not be "fixed" by
 * editing the UI from this script.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const require_ = createRequire(import.meta.url);
const ENV = process.env;

/* ------------------------------------------------------------------ */
/* argv                                                                */
/* ------------------------------------------------------------------ */

const VIEWPORTS = [
    { id: "mobile", width: 380, height: 780 },
    { id: "tablet", width: 1024, height: 768 },
    { id: "desktop", width: 1440, height: 900 },
];
const THEMES = ["light", "dark"];

/** Pages, their routes, and the primary-button budget (`null` = not asserted). */
const PAGES = [
    { id: "workspaces", route: "/workspaces", primary: [1, 1], nav: true },
    { id: "chat", route: "/chat/s-main?workspace=ws-main", primary: null, nav: true },
    { id: "status", route: "/status", primary: [0, 0], nav: true },
    { id: "connect", route: "/connect", primary: [1, 1], nav: false },
];

function usage() {
    process.stdout.write(
        [
            "usage: node scripts/ui-shots.mjs [--serve-static] [--base <url>] [--out <dir>]",
            "                                  [--round <label>] [--matrix=full|quick]",
            "                                  [--static-dir <dir>] [--timeout <ms>]",
            "",
        ].join("\n"),
    );
}

function parseArgs(argv) {
    const options = {
        serveStatic: false,
        base: null,
        out: null,
        round: "adhoc",
        matrix: "full",
        staticDir: path.join(REPO_ROOT, "web", "dist"),
        timeoutMs: 12_000,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = () => {
            const next = argv[index + 1];
            if (next === undefined) throw new Error(`${arg} needs a value`);
            index += 1;
            return next;
        };
        if (arg === "--help" || arg === "-h") {
            usage();
            process.exit(0);
        } else if (arg === "--serve-static") {
            options.serveStatic = true;
        } else if (arg.startsWith("--base=")) {
            options.base = arg.slice("--base=".length);
        } else if (arg === "--base") {
            options.base = value();
        } else if (arg.startsWith("--out=")) {
            options.out = arg.slice("--out=".length);
        } else if (arg === "--out") {
            options.out = value();
        } else if (arg.startsWith("--round=")) {
            options.round = arg.slice("--round=".length);
        } else if (arg === "--round") {
            options.round = value();
        } else if (arg.startsWith("--matrix=")) {
            options.matrix = arg.slice("--matrix=".length);
        } else if (arg === "--matrix") {
            options.matrix = value();
        } else if (arg.startsWith("--static-dir=")) {
            options.staticDir = path.resolve(arg.slice("--static-dir=".length));
        } else if (arg === "--static-dir") {
            options.staticDir = path.resolve(value());
        } else if (arg.startsWith("--timeout=")) {
            options.timeoutMs = Number(arg.slice("--timeout=".length));
        } else if (arg === "--timeout") {
            options.timeoutMs = Number(value());
        } else {
            process.stderr.write(`ui-shots: unknown argument ${arg}\n`);
            usage();
            process.exit(2);
        }
    }
    if (!["full", "quick"].includes(options.matrix)) {
        process.stderr.write(`ui-shots: --matrix must be full or quick (got ${options.matrix})\n`);
        process.exit(2);
    }
    if (!options.serveStatic && !options.base) {
        process.stderr.write("ui-shots: pass --serve-static or --base <url>\n");
        usage();
        process.exit(2);
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        process.stderr.write("ui-shots: --timeout must be a positive number of milliseconds\n");
        process.exit(2);
    }
    options.out = path.resolve(options.out ?? path.join("/tmp/pi2d-port/shots", options.round));
    return options;
}

const OPTIONS = parseArgs(process.argv.slice(2));

const VIEWPORT_MATRIX = OPTIONS.matrix === "quick" ? VIEWPORTS.filter((item) => item.id === "desktop") : VIEWPORTS;

/* ------------------------------------------------------------------ */
/* playwright (resolved, not a dependency)                             */
/* ------------------------------------------------------------------ */

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

    for (const spec of [ENV.PI2_SHOTS_PLAYWRIGHT_MODULE, ENV.PI2_E2E_PLAYWRIGHT_MODULE].filter(Boolean)) {
        const fromEnv = attempt(spec);
        if (fromEnv) return { pw: fromEnv, spec };
    }
    const fromRequire = attempt("playwright");
    if (fromRequire) return { pw: fromRequire, spec: "playwright" };

    // mise installs npm-global tools under <mise>/installs/npm-playwright/*/v11/*/node_modules
    const roots = [
        "/home/yuez/.local/share/mise/installs/npm-playwright",
        path.join(ENV.HOME || "/root", ".local/share/mise/installs/npm-playwright"),
    ];
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
            for (const hash of hashes) {
                const candidate = path.join(v11, hash, "node_modules", "playwright");
                if (!fs.existsSync(candidate)) continue;
                const mod = attempt(candidate);
                if (mod) return { pw: mod, spec: candidate };
            }
        }
    }
    throw new Error(`cannot load playwright (tried: ${tried.join(", ")})`);
}

function chromePath() {
    const candidates = [
        ENV.PI2_SHOTS_CHROME,
        ENV.PI2_E2E_CHROME,
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ].filter(Boolean);
    return candidates.find((candidate) => fs.existsSync(candidate));
}

/* ------------------------------------------------------------------ */
/* fixture servers                                                     */
/* ------------------------------------------------------------------ */

const children = [];

function startMockServer({ pairOnly = false } = {}) {
    const args = [
        path.join(HERE, "ui-mock-server.mjs"),
        "--port",
        "0",
        "--static",
        OPTIONS.staticDir,
        ...(pairOnly ? ["--pair-only"] : []),
    ];
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
    });
    return new Promise((resolve, reject) => {
        let stdout = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`ui-mock-server did not print READY within 10s${stderr ? `: ${stderr}` : ""}`));
        }, 10_000);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
            const match = /READY (\d+)/.exec(stdout);
            if (!match) return;
            clearTimeout(timer);
            resolve({ port: Number(match[1]), child });
        });
        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`ui-mock-server exited early (code ${code})${stderr ? `: ${stderr}` : ""}`));
        });
    });
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function storageState(origin, { paired, theme }) {
    if (!paired) {
        return {
            cookies: [],
            origins: [{ origin, localStorage: [{ name: "pi2-theme", value: theme }] }],
        };
    }
    const local = [
        { name: "pi2-connection", value: "paired" },
        { name: "pi2-endpoint", value: origin },
        { name: "pi2-device-token", value: "mock-device-token-0000000000000000000000" },
        { name: "pi2-device-scopes", value: JSON.stringify(["read", "steer", "apply"]) },
        { name: "pi2-device", value: "visual harness" },
        { name: "pi2-connected-at", value: String(Date.now()) },
        { name: "pi2-theme", value: theme },
    ];
    return { cookies: [], origins: [{ origin, localStorage: local }] };
}

function assert(name, ok, expected, observed) {
    return { name, ok: Boolean(ok), expected, observed };
}

/** Wait until no same-origin request has been in flight for `quietMs`. */
async function waitForQuiet(page, timeoutMs, quietMs = 350) {
    const started = Date.now();
    let last = Date.now();
    let pending = 0;
    page.on("request", () => {
        pending += 1;
        last = Date.now();
    });
    const done = () => {
        pending = Math.max(0, pending - 1);
        last = Date.now();
    };
    page.on("requestfinished", done);
    page.on("requestfailed", done);
    while (Date.now() - started < timeoutMs) {
        if (pending === 0 && Date.now() - last > quietMs) return true;
        await sleep(100);
    }
    return false;
}

async function collect(page) {
    return page.evaluate(() => {
        const root = document.getElementById("root");
        const text = (root?.innerText ?? "").replace(/\s+/g, " ").trim();
        const count = (selector) => document.querySelectorAll(selector).length;
        const de = document.documentElement;
        const shell = document.querySelector(".shell");
        return {
            path: location.pathname,
            search: location.search,
            title: document.title,
            theme: de.dataset.theme ?? "",
            paired: shell?.getAttribute("data-paired") ?? null,
            wsState: shell?.getAttribute("data-ws-state") ?? null,
            textLen: text.length,
            textHead: text.slice(0, 220),
            scrollWidth: de.scrollWidth,
            clientWidth: de.clientWidth,
            bodyScrollWidth: document.body.scrollWidth,
            tabbar: count(".tabbar"),
            primary: count(".btn--primary"),
            pagePill: count(".page-pill"),
            navItem: count(".nav-item"),
            dots: count(".dot"),
            modals: count(".modal-backdrop"),
            hasRoot: root !== null,
        };
    });
}

/** Elements that overflow the viewport to the right (only run when it does). */
async function overflowOffenders(page) {
    return page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const offenders = [];
        for (const element of document.querySelectorAll("body *")) {
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            if (rect.right > width + 1 || rect.left < -1) {
                const id = element.id ? `#${element.id}` : "";
                const cls = typeof element.className === "string" ? element.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
                offenders.push(`${element.tagName.toLowerCase()}${id}${cls ? `.${cls}` : ""} [${Math.round(rect.left)}→${Math.round(rect.right)}]`);
                if (offenders.length >= 6) break;
            }
        }
        return offenders;
    });
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

const failures = [];
const notes = [];

function record(shotId, checks) {
    for (const check of checks) {
        if (check.ok) continue;
        failures.push({
            shot: shotId,
            check: check.name,
            expected: check.expected,
            observed: check.observed,
        });
    }
}

async function shootPage(browser, { base, origin, page: spec, viewport, theme, index, total }) {
    const file = `${spec.id}-${viewport.width}x${viewport.height}-${theme}.png`;
    const shotPath = path.join(OPTIONS.out, file);
    const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: theme,
        locale: "en-US",
        storageState: storageState(origin, { paired: true, theme }),
        baseURL: base,
    });
    const consoleErrors = [];
    const pageErrors = [];
    const apiErrors = [];
    try {
        await context.addInitScript((lang) => {
            try {
                localStorage.setItem("pi2-lang", lang);
            } catch {
                /* private mode */
            }
        }, "en");
        const page = await context.newPage();
        page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("response", (response) => {
            const url = response.url();
            if (!/\/api\/v1\//.test(url)) return;
            if (response.status() >= 400) apiErrors.push(`${response.status()} ${new URL(url).pathname}`);
        });

        let navError = null;
        try {
            await page.goto(`${base}${spec.route}`, { waitUntil: "load", timeout: OPTIONS.timeoutMs });
        } catch (error) {
            navError = error instanceof Error ? error.message : String(error);
        }
        await waitForQuiet(page, OPTIONS.timeoutMs);
        await page
            .evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true))
            .catch(() => undefined);
        await sleep(450);

        // The fixtures keep pending attention off the session this matrix opens
        // (the console's attention modal is blocking and Escape-proof), so any
        // overlay here is a finding: assert it away instead of clicking through.

        const metrics = await collect(page);
        const checks = [];

        checks.push(
            assert("page-loaded", !navError && metrics.hasRoot && metrics.textLen > 60, ">60 chars of app text", {
                navError,
                textLen: metrics.textLen,
            }),
        );
        checks.push(
            assert("route", metrics.path === spec.route.split("?")[0], spec.route.split("?")[0], `${metrics.path}${metrics.search}`),
        );
        checks.push(assert("paired", metrics.paired === "true", "data-paired=true", metrics.paired));
        checks.push(assert("theme", metrics.theme === theme, theme, metrics.theme || "(none)"));
        const errorSummary = (list) => (list.length ? { count: list.length, samples: list.slice(0, 4) } : 0);
        checks.push(assert("console-errors", consoleErrors.length === 0, 0, errorSummary(consoleErrors)));
        checks.push(assert("page-errors", pageErrors.length === 0, 0, errorSummary(pageErrors)));
        checks.push(assert("api-errors", apiErrors.length === 0, 0, errorSummary(apiErrors)));

        const overflow = metrics.scrollWidth > metrics.clientWidth + 1;
        const offenders = overflow ? await overflowOffenders(page) : [];
        checks.push(
            assert("no-horizontal-overflow", !overflow, `${metrics.clientWidth}px`, {
                scrollWidth: metrics.scrollWidth,
                offenders,
            }),
        );
        checks.push(assert("no-tabbar", metrics.tabbar === 0, 0, metrics.tabbar));
        // A stray overlay hides the page under a modal: the screenshots must show
        // the page, not a dialog nobody asked for.
        checks.push(assert("no-unexpected-modal", metrics.modals === 0, 0, metrics.modals));
        if (!spec.nav) {
            checks.push(assert("connect-no-page-pill", metrics.pagePill === 0, 0, metrics.pagePill));
            checks.push(assert("connect-no-nav-item", metrics.navItem === 0, 0, metrics.navItem));
        }
        if (spec.primary) {
            const [min, max] = spec.primary;
            checks.push(
                assert("primary-count", metrics.primary >= min && metrics.primary <= max, `${min}..${max}`, metrics.primary),
            );
        }
        if (metrics.dots < 3 && (spec.id === "chat" || spec.id === "status")) {
            notes.push(`${file}: only ${metrics.dots} status dot(s) (PLAN §3.3 asks for ≥3)`);
        }

        await page.screenshot({ path: shotPath, fullPage: false, timeout: OPTIONS.timeoutMs });
        record(file, checks);

        process.stdout.write(
            `${checks.every((check) => check.ok) ? "ok  " : "FAIL"} [${index + 1}/${total}] ${file}` +
                `  ${metrics.title || "(no title)"}  primary=${metrics.primary} dots=${metrics.dots} ws=${metrics.wsState}\n`,
        );
        return {
            file,
            page: spec.id,
            viewport: { width: viewport.width, height: viewport.height },
            theme,
            bytes: fs.existsSync(shotPath) ? fs.statSync(shotPath).size : 0,
            metrics,
            checks,
        };
    } finally {
        await context.close();
    }
}

/**
 * Unpaired branch (`--pair-only`): the guard must bounce `/workspaces` to
 * `/connect`, and the connect page must have no navigation chrome at all.
 */
async function checkUnpaired(browser, { pairBase, pairOrigin }) {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
        locale: "en-US",
        storageState: storageState(pairOrigin, { paired: false, theme: "dark" }),
        baseURL: pairBase,
    });
    try {
        await context.addInitScript(() => {
            try {
                localStorage.setItem("pi2-lang", "en");
            } catch {
                /* private mode */
            }
        });
        const page = await context.newPage();
        const consoleErrors = [];
        page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });
        await page.goto(`${pairBase}/workspaces`, { waitUntil: "load", timeout: OPTIONS.timeoutMs });
        await sleep(700);
        const metrics = await collect(page);
        const checks = [
            assert("unpaired-redirects-to-connect", metrics.path === "/connect", "/connect", metrics.path),
            assert("unpaired-no-page-pill", metrics.pagePill === 0, 0, metrics.pagePill),
            assert("unpaired-no-nav-item", metrics.navItem === 0, 0, metrics.navItem),
            assert("unpaired-no-tabbar", metrics.tabbar === 0, 0, metrics.tabbar),
            assert("unpaired-connect-primary", metrics.primary === 1, 1, metrics.primary),
            assert("unpaired-not-paired", metrics.paired === "false", "data-paired=false", metrics.paired),
            assert("unpaired-renders", metrics.textLen > 60, ">60 chars", metrics.textLen),
            // A refused `/api/v1/*` is expected here, but a console error is not.
            assert("unpaired-console-errors", consoleErrors.length === 0, 0, consoleErrors.slice(0, 4)),        ];
        record("(unpaired)", checks);
        process.stdout.write(
            `${checks.every((check) => check.ok) ? "ok  " : "FAIL"} [unpaired] /workspaces → ${metrics.path} primary=${
                metrics.primary
            }\n`,
        );
        return { name: "unpaired-redirect", base: pairBase, metrics, checks };
    } finally {
        await context.close();
    }
}

function buildFingerprint() {
    const indexPath = path.join(OPTIONS.staticDir, "index.html");
    if (!fs.existsSync(indexPath)) return null;
    const stat = fs.statSync(indexPath);
    const html = fs.readFileSync(indexPath, "utf8");
    const assets = [...html.matchAll(/\/(assets\/[^"']+)/g)].map((match) => match[1]);
    return { indexMtime: new Date(stat.mtimeMs).toISOString(), assets };
}

async function main() {
    const startedAt = Date.now();
    if (OPTIONS.serveStatic && !fs.existsSync(path.join(OPTIONS.staticDir, "index.html"))) {
        process.stderr.write(
            `ui-shots: ${OPTIONS.staticDir}/index.html is missing — run \`pnpm --dir web build\` first\n`,
        );
        process.exit(2);
    }
    fs.mkdirSync(OPTIONS.out, { recursive: true });
    // Which bundle was shot? A rebuild during the run (another workstream, or a
    // `vite build` in parallel) changes the asset hash and can 503 a shot.
    const buildBefore = buildFingerprint();

    let base = OPTIONS.base ? OPTIONS.base.replace(/\/+$/, "") : null;
    let pairBase = null;
    if (OPTIONS.serveStatic) {
        const server = await startMockServer();
        base = base ?? `http://127.0.0.1:${server.port}`;
        try {
            const pairServer = await startMockServer({ pairOnly: true });
            pairBase = `http://127.0.0.1:${pairServer.port}`;
        } catch (error) {
            process.stderr.write(`ui-shots: unpaired check skipped (${error.message})\n`);
        }
    }

    const origin = new URL(base).origin;
    let playwright;
    try {
        playwright = loadPlaywright();
    } catch (error) {
        process.stderr.write(`ui-shots: ${error.message}\n`);
        process.exit(2);
    }
    const executablePath = chromePath();
    const browser = await playwright.pw.chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
        args: ["--no-sandbox"],
    });

    const shots = [];
    const checks = [];
    const matrix = [];
    for (const viewport of VIEWPORT_MATRIX) {
        for (const theme of THEMES) {
            for (const spec of PAGES) matrix.push({ spec, viewport, theme });
        }
    }

    try {
        for (let index = 0; index < matrix.length; index += 1) {
            const { spec, viewport, theme } = matrix[index];
            shots.push(await shootPage(browser, { base, origin, page: spec, viewport, theme, index, total: matrix.length }));
        }
        if (pairBase) {
            const pairOrigin = new URL(pairBase).origin;
            checks.push(await checkUnpaired(browser, { pairBase, pairOrigin, origin: pairOrigin }));
        } else {
            notes.push("unpaired redirect check skipped (needs --serve-static)");
        }
    } finally {
        await browser.close();
        for (const child of children) {
            if (child.exitCode === null) child.kill("SIGTERM");
        }
    }

    const passed = shots.filter((shot) => shot.checks.every((check) => check.ok)).length;
    const buildAfter = buildFingerprint();
    if (buildBefore && buildAfter && buildBefore.indexMtime !== buildAfter.indexMtime) {
        notes.push(
            `web/dist changed during the run (${buildBefore.assets.join(",")} → ${buildAfter.assets.join(",")}); a parallel rebuild can 503 a shot`,
        );
    }
    const report = {
        round: OPTIONS.round,
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        base,
        pairBase,
        out: OPTIONS.out,
        matrix: OPTIONS.matrix,
        viewports: VIEWPORT_MATRIX,
        themes: THEMES,
        pages: PAGES.map((page) => ({ id: page.id, route: page.route, primary: page.primary })),
        playwright: playwright.spec,
        browser: executablePath ?? "(playwright bundled chromium)",
        summary: {
            shots: shots.length,
            passed,
            failed: shots.length - passed,
            failures: failures.length,
            consoleErrors: shots.reduce((total, shot) => {
                const observed = shot.checks.find((check) => check.name === "console-errors")?.observed;
                return total + (observed && typeof observed === "object" ? observed.count : 0);
            }, 0),
            horizontalOverflow: shots.filter(
                (shot) => !shot.checks.find((check) => check.name === "no-horizontal-overflow")?.ok,
            ).length,
        },
        failures,
        notes,
        staticDir: OPTIONS.staticDir,
        build: buildAfter ?? buildBefore,
        shots,
        checks,
    };
    fs.writeFileSync(path.join(OPTIONS.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

    const lines = [];
    lines.push("");
    lines.push(`ui-shots: ${report.summary.passed}/${report.summary.shots} shots clean → ${OPTIONS.out}`);
    if (failures.length) {
        lines.push("");
        lines.push("FAILURES");
        for (const failure of failures) {
            lines.push(
                `  ${failure.shot} · ${failure.check}\n    expected: ${JSON.stringify(failure.expected)}\n    observed: ${JSON.stringify(failure.observed)}`,
            );
        }
    }
    if (notes.length) {
        lines.push("");
        lines.push("NOTES");
        for (const note of notes) lines.push(`  ${note}`);
    }
    lines.push(`report: ${path.join(OPTIONS.out, "report.json")}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
    for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
    }
    process.stderr.write(`ui-shots: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(2);
});
