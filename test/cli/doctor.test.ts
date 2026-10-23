import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    checkAccess,
    checkCliToken,
    checkCurl,
    checkLinger,
    checkNvim,
    checkNode,
    checkProtocol,
    collectContext,
    defaultProbes,
    formatReport,
    parseCurlVersion,
    parseNvimVersion,
    parseVersion,
    reportToJson,
    runDoctor,
    versionAtLeast,
    type DoctorContext,
} from "../../src/cli/doctor.js";
import { clearRuntimeEnv, removeDir, tempDir } from "./helpers.js";

function context(overrides: Partial<DoctorContext> = {}): DoctorContext {
    const base: DoctorContext = {
        platform: "linux",
        nodeVersion: "v22.11.0",
        nvim: { found: true, path: "/usr/bin/nvim", version: "v0.10.2" },
        pi: { found: true, path: "/usr/local/bin/pi", version: "1.8.0" },
        curl: {
            found: true,
            path: "/usr/bin/curl",
            version: "curl 8.7.1 (x86_64-pc-linux-gnu) libcurl/8.7.1 OpenSSL/3.3.1",
        },
        plugin: { dir: "/home/u/.local/share/nvim/lazy/pi2.nvim", bridgeFound: true },
        runtime: { path: "/run/user/1000/pi2", exists: true, mode: 0o700 },
        cliToken: { path: "/run/user/1000/pi2/cli.token", exists: true, mode: 0o600 },
        socket: { path: "/run/user/1000/pi2/d.sock", exists: true },
        daemon: { reachable: true, port: 7676, protocolVersion: 1 },
        port: { configured: 7676, bound: true },
        access: { mode: "local", host: "127.0.0.1", port: 7676, publicUrl: null },
        serviceManager: { name: "systemd", available: true },
        linger: { checked: true, enabled: true },
        webDist: { path: "/repo/web/dist", exists: true },
    };
    return { ...base, ...overrides };
}

async function checks(overrides: Partial<DoctorContext> = {}) {
    return runDoctor(defaultProbes(context(overrides)));
}

function statusOf(report: Awaited<ReturnType<typeof checks>>, name: string): string | undefined {
    return report.checks.find((check) => check.name === name)?.status;
}

describe("doctor checks (all passing)", () => {
    it("reports ok and every check", async () => {
        const report = await checks();
        expect(report.ok).toBe(true);
        expect(report.checks.map((check) => check.name)).toEqual([
            "node",
            "nvim",
            "pi",
            "curl",
            "plugin",
            "runtime-dir",
            "cli-token",
            "socket",
            "daemon",
            "port",
            "access",
            "service-manager",
            "linger",
            "web-dist",
            "protocol",
        ]);
        expect(report.checks.every((check) => check.status === "ok")).toBe(true);
        expect(report.checks.find((check) => check.name === "node")?.detail).toContain("v22.11.0");
    });

    it("omits the linger check on macOS", async () => {
        const report = await checks({
            platform: "darwin",
            serviceManager: { name: "launchd", available: true },
            linger: { checked: false },
        });
        expect(statusOf(report, "linger")).toBeUndefined();
        expect(report.ok).toBe(true);
    });
});

describe("doctor access check", () => {
    it("is ok for local mode", () => {
        const check = checkAccess({ mode: "local", host: "127.0.0.1", port: 7676, publicUrl: null });
        expect(check).toEqual({ name: "access", status: "ok", detail: "local (loopback only)" });
    });

    it("warns for lan/tailscale with a TLS-terminated public URL", () => {
        const lan = checkAccess({ mode: "lan", host: "0.0.0.0", port: 7676, publicUrl: "https://host.ts.net" });
        expect(lan.status).toBe("warn");
        expect(lan.detail).toBe("lan (bind 0.0.0.0/7676, public https://host.ts.net)");
        expect(lan.detail).not.toContain("no TLS");

        const tailscale = checkAccess({ mode: "tailscale", host: "127.0.0.1", port: 7676, publicUrl: "https://host.ts.net" });
        expect(tailscale.status).toBe("warn");
        expect(tailscale.detail).toBe("tailscale (bind 127.0.0.1/7676, public https://host.ts.net)");
    });

    it("adds the no-TLS hint when the public URL is missing or plain http", () => {
        const loopback = checkAccess({ mode: "lan", host: "127.0.0.1", port: 7676, publicUrl: null });
        expect(loopback.status).toBe("warn");
        expect(loopback.detail).toContain("lan (bind 127.0.0.1/7676)");
        expect(loopback.detail).toContain("no TLS, prefer `tailscale serve`");

        const plain = checkAccess({ mode: "tailscale", host: "127.0.0.1", port: 7676, publicUrl: "http://host.ts.net" });
        expect(plain.status).toBe("warn");
        expect(plain.detail).toContain("no TLS, prefer `tailscale serve`");
    });

    it("fails when a non-loopback bind has no public URL", () => {
        const check = checkAccess({ mode: "lan", host: "0.0.0.0", port: 7676, publicUrl: null });
        expect(check).toEqual({ name: "access", status: "fail", detail: "lan (bind 0.0.0.0/7676)" });

        const tailscale = checkAccess({ mode: "tailscale", host: "100.64.0.1", port: 7676, publicUrl: null });
        expect(tailscale.status).toBe("fail");
    });

    it("is wired into the default probe list after port", async () => {
        const report = await checks({ access: { mode: "tailscale", host: "127.0.0.1", port: 7676, publicUrl: null } });
        const names = report.checks.map((check) => check.name);
        expect(names.indexOf("access")).toBe(names.indexOf("port") + 1);
        expect(statusOf(report, "access")).toBe("warn");
        // A warn keeps the overall report ok.
        expect(report.ok).toBe(true);

        const failed = await checks({ access: { mode: "lan", host: "0.0.0.0", port: 7676, publicUrl: null } });
        expect(statusOf(failed, "access")).toBe("fail");
        expect(failed.ok).toBe(false);
    });
});

describe("doctor curl check", () => {
    it("is ok and reports the parsed version with its path", () => {
        const check = checkCurl({ found: true, path: "/usr/bin/curl", version: "curl 8.7.1 (x86_64-pc-linux-gnu) libcurl/8.7.1" });
        expect(check).toEqual({ name: "curl", status: "ok", detail: "8.7.1 (/usr/bin/curl)" });
    });

    it("warns with an actionable hint when curl is missing", async () => {
        const check = checkCurl({ found: false, error: "curl not found on PATH" });
        expect(check).toEqual({
            name: "curl",
            status: "warn",
            detail: "not found on PATH (:PiWeb cannot sign the browser in automatically; pair instead)",
        });
        expect(check.detail).toContain("pair instead");

        const report = await checks({ curl: { found: false } });
        expect(statusOf(report, "curl")).toBe("warn");
        // A warn keeps the overall report ok.
        expect(report.ok).toBe(true);
    });

    it("warns when the version cannot be parsed", () => {
        expect(checkCurl({ found: true, path: "/usr/bin/curl", version: "garbage" })).toEqual({
            name: "curl",
            status: "warn",
            detail: "could not parse version of /usr/bin/curl",
        });
        expect(checkCurl({ found: true, path: "/usr/bin/curl" }).status).toBe("warn");
        expect(parseCurlVersion("curl 8.7.1 (x86_64-pc-linux-gnu) libcurl/8.7.1")).toBe("8.7.1");
        expect(parseCurlVersion("garbage")).toBeUndefined();
        expect(parseCurlVersion(undefined)).toBeUndefined();
    });

    it("is wired into the report right after pi, in the table and in --json", async () => {
        const report = await checks();
        const names = report.checks.map((check) => check.name);
        expect(names.indexOf("curl")).toBe(names.indexOf("pi") + 1);
        expect(names.indexOf("plugin")).toBe(names.indexOf("curl") + 1);
        expect(report.checks.find((check) => check.name === "curl")).toEqual({
            name: "curl",
            status: "ok",
            detail: "8.7.1 (/usr/bin/curl)",
        });
        expect(formatReport(report)).toMatch(/ok\s+curl\s+8\.7\.1 \(\/usr\/bin\/curl\)/);

        const parsed = JSON.parse(reportToJson(report)) as { ok: boolean; checks: { name: string; status: string; detail: string }[] };
        expect(parsed.ok).toBe(true);
        expect(parsed.checks.map((check) => check.name).indexOf("curl")).toBe(names.indexOf("pi") + 1);
        expect(parsed.checks.find((check) => check.name === "curl")?.detail).toBe("8.7.1 (/usr/bin/curl)");
    });
});

describe("doctor failure cases", () => {
    it("fails on node < 22", async () => {
        const report = await checks({ nodeVersion: "v20.11.0" });
        expect(report.ok).toBe(false);
        expect(statusOf(report, "node")).toBe("fail");
        expect(report.checks.find((check) => check.name === "node")?.detail).toContain("< 22.0.0");
    });

    it("fails when nvim is missing", async () => {
        const report = await checks({ nvim: { found: false, error: "nvim not found on PATH" } });
        expect(statusOf(report, "nvim")).toBe("fail");
        expect(report.ok).toBe(false);
    });

    it("fails on nvim < 0.9 (no --remote-ui)", async () => {
        const report = await checks({ nvim: { found: true, path: "/usr/bin/nvim", version: "v0.8.3" } });
        expect(statusOf(report, "nvim")).toBe("fail");
        expect(report.checks.find((check) => check.name === "nvim")?.detail).toContain("--remote-ui");
    });

    it("warns (does not fail) when pi is missing", async () => {
        const report = await checks({ pi: { found: false } });
        expect(statusOf(report, "pi")).toBe("warn");
        expect(report.ok).toBe(true);
    });

    it("fails when the plugin is not installed", async () => {
        const report = await checks({ plugin: { dir: "/home/u/nvim/pi2.nvim", bridgeFound: false } });
        expect(statusOf(report, "plugin")).toBe("fail");
        expect(report.ok).toBe(false);
    });

    it("fails when the runtime dir is missing and warns on loose modes", async () => {
        expect(statusOf(await checks({ runtime: { path: "/run/pi2", exists: false, mode: undefined } }), "runtime-dir")).toBe(
            "fail",
        );
        const loose = await checks({ runtime: { path: "/run/pi2", exists: true, mode: 0o755 } });
        expect(statusOf(loose, "runtime-dir")).toBe("warn");
        expect(loose.ok).toBe(true);
    });

    it("fails when the CLI token is readable by others", async () => {
        const report = await checks({ cliToken: { path: "/run/pi2/cli.token", exists: true, mode: 0o644 } });
        expect(statusOf(report, "cli-token")).toBe("fail");
        expect(report.ok).toBe(false);
        expect(checkCliToken({ path: "/run/pi2/cli.token", exists: false, mode: undefined }).status).toBe("warn");
        expect(checkCliToken({ path: "/run/pi2/cli.token", exists: true, mode: 0o600 }).status).toBe("ok");
    });

    it("fails when the socket is missing and no daemon answers", async () => {
        const report = await checks({
            socket: { path: "/run/pi2/d.sock", exists: false },
            daemon: { reachable: false, error: "connection refused" },
            port: { configured: 7676, bound: false },
        });
        expect(statusOf(report, "socket")).toBe("fail");
        expect(statusOf(report, "daemon")).toBe("fail");
        expect(statusOf(report, "protocol")).toBe("fail");
        expect(report.ok).toBe(false);
        // A free port is fine on its own.
        expect(statusOf(report, "port")).toBe("ok");
    });

    it("fails on a protocol version mismatch", async () => {
        const report = await checks({ daemon: { reachable: true, port: 7676, protocolVersion: 2 } });
        expect(statusOf(report, "protocol")).toBe("fail");
        expect(checkProtocol({ reachable: true, port: 1, protocolVersion: 1 }).status).toBe("ok");
    });

    it("warns when web/dist, the service manager or linger are unavailable", async () => {
        const report = await checks({
            webDist: { path: "/repo/web/dist", exists: false },
            serviceManager: { name: "systemd", available: false },
            linger: { checked: true, enabled: false },
        });
        expect(statusOf(report, "web-dist")).toBe("warn");
        expect(statusOf(report, "service-manager")).toBe("warn");
        expect(statusOf(report, "linger")).toBe("warn");
        expect(report.ok).toBe(true);
    });

    it("turns a throwing probe into a failing check", async () => {
        const report = await runDoctor([
            { name: "boom", run: () => Promise.reject(new Error("kaboom")) },
            { name: "fine", run: () => ({ name: "fine", status: "ok", detail: "ok" }) },
        ]);
        expect(report.ok).toBe(false);
        expect(report.checks[0]).toEqual({ name: "boom", status: "fail", detail: "kaboom" });
    });
});

describe("doctor output", () => {
    it("renders a table with an overall line", async () => {
        const text = formatReport(await checks());
        expect(text).toContain("check");
        expect(text).toContain("detail");
        expect(text).toContain("runtime-dir");
        expect(text.trimEnd().endsWith("overall: ok")).toBe(true);

        const failed = formatReport(await checks({ nodeVersion: "v18.0.0" }));
        expect(failed).toContain("FAIL");
        expect(failed.trimEnd().endsWith("overall: FAILED")).toBe(true);
    });

    it("emits a stable JSON shape", async () => {
        const parsed = JSON.parse(reportToJson(await checks())) as {
            ok: boolean;
            checks: { name: string; status: string; detail: string }[];
        };
        expect(parsed.ok).toBe(true);
        expect(Array.isArray(parsed.checks)).toBe(true);
        expect(Object.keys(parsed.checks[0]!)).toEqual(["name", "status", "detail"]);
        expect(parsed.checks.find((check) => check.name === "daemon")?.detail).toContain("http://127.0.0.1:7676");
    });
});

describe("version helpers", () => {
    it("parses and compares versions", () => {
        expect(parseVersion("v22.1.0")).toEqual([22, 1, 0]);
        expect(parseVersion("22.10.3")).toEqual([22, 10, 3]);
        expect(parseVersion("nope")).toBeUndefined();
        expect(versionAtLeast([22, 0, 0], [22, 0, 0])).toBe(true);
        expect(versionAtLeast([22, 0, 0], [22, 1, 0])).toBe(false);
        expect(versionAtLeast([23, 0, 0], [22, 9, 9])).toBe(true);
        expect(parseNvimVersion("NVIM v0.10.2\nBuild type: Release")).toBe("0.10.2");
        expect(parseNvimVersion("NVIM v0.9.5")).toBe("0.9.5");
        expect(parseNvimVersion("garbage")).toBeUndefined();
        expect(checkNode("v22.0.0").status).toBe("ok");
        expect(checkNode("garbage").status).toBe("fail");
        expect(checkNvim({ found: true, path: "/n", version: "v0.10.0" }).status).toBe("ok");
        expect(checkLinger({ checked: false }).status).toBe("ok");
    });
});

describe("collectContext", () => {
    let dir: string;

    beforeEach(() => {
        dir = tempDir("pi2-doctor-");
        process.env.PI2_RUNTIME_DIR = join(dir, "run");
        process.env.PI2_DATA_DIR = join(dir, "data");
        mkdirSync(join(dir, "run"), { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, "run", "cli.token"), "t".repeat(64), { mode: 0o600 });
        writeFileSync(join(dir, "run", "d.sock"), "");
        process.env.PI2_STATIC_DIR = join(dir, "web");
    });

    afterEach(() => {
        clearRuntimeEnv();
        removeDir(dir);
    });

    it("gathers real state through injectable probes", async () => {
        const home = join(dir, "home");
        mkdirSync(join(home, ".local", "share", "nvim", "lazy", "pi2.nvim", "lua", "pi", "web"), {
            recursive: true,
        });
        writeFileSync(join(home, ".local", "share", "nvim", "lazy", "pi2.nvim", "lua", "pi", "web", "bridge.lua"), "");

        const ctx = await collectContext({
            platform: "linux",
            home,
            uid: 1000,
            env: { PATH: "/usr/bin", PI2_RUNTIME_DIR: join(dir, "run"), PI2_STATIC_DIR: join(dir, "web") },
            which: (command) => `/usr/bin/${command}`,
            run: async (command, args) => {
                if (command === "nvim") return { ok: true, stdout: "NVIM v0.10.2\nBuild type: Release\n", stderr: "" };
                if (command === "pi") return { ok: true, stdout: "1.8.0\n", stderr: "" };
                if (command === "curl") {
                    return { ok: true, stdout: "curl 8.7.1 (x86_64-pc-linux-gnu) libcurl/8.7.1\nRelease-Date: 2024-03-27\n", stderr: "" };
                }
                if (command === "loginctl" && args[1] === "1000") return { ok: true, stdout: "Linger=yes\n", stderr: "" };
                return { ok: false, stdout: "", stderr: "unexpected" };
            },
            daemonInfo: async () => ({ port: 7712, protocolVersion: 1 }),
        });

        expect(ctx.nvim).toEqual({ found: true, path: "/usr/bin/nvim", version: "v0.10.2" });
        expect(ctx.pi.version).toBe("1.8.0");
        expect(ctx.curl).toEqual({ found: true, path: "/usr/bin/curl", version: "curl 8.7.1 (x86_64-pc-linux-gnu) libcurl/8.7.1" });
        expect(ctx.plugin.bridgeFound).toBe(true);
        expect(ctx.runtime.exists).toBe(true);
        expect(ctx.cliToken.mode).toBe(0o600);
        expect(ctx.socket.exists).toBe(true);
        expect(ctx.daemon).toEqual({ reachable: true, port: 7712, protocolVersion: 1 });
        expect(ctx.port).toEqual({ configured: 7712, bound: true });
        expect(ctx.access).toEqual({ mode: "local", host: "127.0.0.1", port: 7712, publicUrl: null });
        expect(ctx.serviceManager).toEqual({ name: "systemd", available: true });
        expect(ctx.linger).toMatchObject({ checked: true, enabled: true });
        expect(ctx.webDist.path).toBe(join(dir, "web"));

        const report = await runDoctor(defaultProbes(ctx));
        // web/dist does not exist here, everything else passes.
        expect(report.ok).toBe(true);
        expect(report.checks.find((check) => check.name === "web-dist")?.status).toBe("warn");
    });

    it("records a missing daemon as unreachable", async () => {
        const ctx = await collectContext({
            platform: "darwin",
            home: join(dir, "home"),
            env: { PATH: "/usr/bin", PI2_RUNTIME_DIR: join(dir, "run") },
            which: (command) => (command === "launchctl" ? "/bin/launchctl" : `/usr/bin/${command}`),
            run: async () => ({ ok: false, stdout: "", stderr: "not found" }),
            daemonInfo: async () => ({ error: "connection refused" }),
        });
        expect(ctx.daemon.reachable).toBe(false);
        expect(ctx.linger.checked).toBe(false);
        expect(ctx.serviceManager.name).toBe("launchd");
        const report = await runDoctor(defaultProbes(ctx));
        expect(report.ok).toBe(false);
        expect(report.checks.some((check) => check.name === "linger")).toBe(false);
    });
});
