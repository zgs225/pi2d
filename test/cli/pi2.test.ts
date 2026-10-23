import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DaemonClient } from "../../src/cli/pi2.js";
import { CliError, createClient, main, resolveEndpoint, runAttach, runDoctorCommand, runOpen, runPairing, runStatus } from "../../src/cli/pi2.js";
import { writeDaemonJson, type DaemonLock } from "../../src/cli/lock.js";
import { writeCliToken } from "../../src/cli/token.js";
import type { WorkspaceInfo } from "../../src/protocol/types.js";
import { PROTOCOL_VERSION } from "../../src/protocol/types.js";
import { removeDir, tempDir } from "./helpers.js";

const DAEMON: DaemonLock = {
    pid: 1234,
    bootId: "boot-1",
    port: 7712,
    daemonId: "d-test",
    startedAt: 1,
    protocolVersion: PROTOCOL_VERSION,
};

function workspace(cwd: string, overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
    return {
        workspaceId: "ws-1",
        cwd,
        name: basename(cwd),
        trusted: true,
        exists: true,
        sessionCount: 0,
        liveCount: 0,
        lastActiveAt: null,
        instance: null,
        ...overrides,
    };
}

function instance(overrides: Partial<NonNullable<WorkspaceInfo["instance"]>> = {}): NonNullable<WorkspaceInfo["instance"]> {
    return {
        workspaceId: "ws-1",
        instanceId: "i-1",
        status: "ready",
        nvimPid: 4321,
        pluginVersion: "1.8.0",
        hasUI: true,
        attachedClients: 0,
        listenAddr: "/run/user/1000/pi2/i/ab12.sock",
        startedAt: 1,
        ...overrides,
    };
}

interface FakeData {
    workspaces?: WorkspaceInfo[];
    info?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    health?: Record<string, unknown>;
    pair?: Record<string, unknown>;
    session?: Record<string, unknown>;
    postError?: Error;
}

function fakeClient(data: FakeData = {}): DaemonClient & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        baseUrl: `http://127.0.0.1:${DAEMON.port}`,
        token: "cli-token",
        daemon: DAEMON,
        async get<T>(path: string): Promise<T> {
            calls.push(path);
            if (path === "/api/v1/workspaces") return (data.workspaces ?? []) as unknown as T;
            if (path === "/api/v1/info") {
                return (data.info ?? {
                    v: PROTOCOL_VERSION,
                    daemonId: "d-test",
                    machineId: "m-test",
                    platform: "linux",
                    capabilities: ["ws", "sse"],
                    limits: { maxBodyBytes: 1, maxFrameBytes: 1, maxConnections: 1 },
                }) as unknown as T;
            }
            if (path === "/api/v1/resources") {
                return (data.resources ?? {
                    instances: [],
                    totalRssBytes: 0,
                    physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
                    warn: false,
                }) as unknown as T;
            }
            if (path === "/api/v1/health") {
                return (data.health ?? { ok: true, items: [{ name: "instances", ok: true, detail: "0 connected" }] }) as unknown as T;
            }
            throw new CliError(`unexpected GET ${path}`);
        },
        async post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
            calls.push(`${path} ${JSON.stringify(body)}`);
            if (data.postError !== undefined) throw data.postError;
            if (path === "/api/v1/pair") {
                return { status: 202, body: data.pair ?? { accepted: true, code: "ABCD2345", expiresAt: Date.now() + 60_000 } };
            }
            if (path === "/api/v1/console/session") {
                return { status: 200, body: data.session ?? { token: "browser-token", url: "http://127.0.0.1:7712/#t=browser-token" } };
            }
            throw new CliError(`unexpected POST ${path}`);
        },
    };
}

interface ExecCall {
    command: string;
    args: string[];
    cwd: string;
}

function recorder(): { calls: ExecCall[]; exec: (command: string, args: string[], options: { cwd: string }) => void } {
    const calls: ExecCall[] = [];
    return {
        calls,
        exec: (command, args, options) => {
            calls.push({ command, args, cwd: options.cwd });
        },
    };
}

describe("resolveEndpoint / createClient", () => {
    let dir: string;

    beforeEach(() => {
        dir = tempDir("pi2-cli-ep-");
    });

    afterEach(() => removeDir(dir));

    it("reads daemon.json and cli.token from the runtime dir", () => {
        writeDaemonJson(DAEMON, join(dir, "daemon.json"));
        const token = writeCliToken(join(dir, "cli.token"));

        const endpoint = resolveEndpoint(dir);
        expect(endpoint.baseUrl).toBe("http://127.0.0.1:7712");
        expect(endpoint.token).toBe(token);
        expect(endpoint.daemon.daemonId).toBe("d-test");

        const client = createClient({ endpoint });
        expect(client.baseUrl).toBe(endpoint.baseUrl);
    });

    it("explains a missing daemon or token", () => {
        expect(() => resolveEndpoint(dir)).toThrowError(/no running pi2 daemon/);
        writeDaemonJson(DAEMON, join(dir, "daemon.json"));
        expect(() => resolveEndpoint(dir)).toThrowError(/missing CLI token/);
    });

    it("turns a connection failure into a CliError", async () => {
        writeDaemonJson({ ...DAEMON, port: 1 }, join(dir, "daemon.json"));
        writeCliToken(join(dir, "cli.token"));
        const client = createClient({ endpoint: resolveEndpoint(dir), timeoutMs: 500 });
        await expect(client.get("/api/v1/info")).rejects.toThrowError(/cannot reach the pi2 daemon/);
    });
});

describe("pi2 attach", () => {
    let dir: string;
    let cwd: string;

    beforeEach(() => {
        dir = tempDir("pi2-cli-attach-");
        cwd = realpathSync(dir);
    });

    afterEach(() => removeDir(dir));

    it("attaches to a ready instance with --remote-ui when a TTY is present", async () => {
        const listenAddr = "/run/user/1000/pi2/i/ab12.sock";
        const recorded = recorder();
        const code = await runAttach({
            cwd,
            isTTY: true,
            exec: recorded.exec,
            client: () => fakeClient({ workspaces: [workspace(cwd, { instance: instance({ listenAddr }) })] }),
        });
        expect(code).toBe(0);
        expect(recorded.calls).toEqual([
            { command: "nvim", args: ["--server", listenAddr, "--remote-ui"], cwd },
        ]);
    });

    it("prints the command instead of exec when stdout is not a TTY", async () => {
        const listenAddr = "/run/user/1000/pi2/i/ab12.sock";
        const recorded = recorder();
        const lines: string[] = [];
        const code = await runAttach({
            cwd,
            isTTY: false,
            exec: recorded.exec,
            print: (line) => lines.push(line),
            client: () => fakeClient({ workspaces: [workspace(cwd, { instance: instance({ listenAddr }) })] }),
        });
        expect(code).toBe(0);
        expect(recorded.calls).toEqual([]);
        expect(lines).toEqual([`nvim --server ${listenAddr} --remote-ui`]);
    });

    it("starts a plain nvim when the workspace has no instance", async () => {
        const recorded = recorder();
        await runAttach({
            cwd,
            isTTY: true,
            exec: recorded.exec,
            client: () => fakeClient({ workspaces: [workspace(cwd)] }),
        });
        expect(recorded.calls).toEqual([{ command: "nvim", args: [], cwd }]);
    });

    it("does not attach to a headless instance without a listen address", async () => {
        const recorded = recorder();
        await runAttach({
            cwd,
            isTTY: true,
            exec: recorded.exec,
            client: () =>
                fakeClient({
                    workspaces: [workspace(cwd, { instance: instance({ listenAddr: null, hasUI: false }) })],
                }),
        });
        expect(recorded.calls).toEqual([{ command: "nvim", args: [], cwd }]);
    });

    it("does not attach to a stopping instance", async () => {
        const recorded = recorder();
        await runAttach({
            cwd,
            isTTY: true,
            exec: recorded.exec,
            client: () => fakeClient({ workspaces: [workspace(cwd, { instance: instance({ status: "stopping" }) })] }),
        });
        expect(recorded.calls[0]?.args).toEqual([]);
    });

    it("resolves the path argument against cwd (realpath comparison)", async () => {
        const sub = join(cwd, "packages", "app");
        mkdirSync(sub, { recursive: true });
        const recorded = recorder();
        const client = fakeClient({
            workspaces: [workspace(realpathSync(sub), { instance: instance({ listenAddr: "/tmp/nvim.sock" }) })],
        });
        await runAttach({ cwd, path: "packages/app", isTTY: true, exec: recorded.exec, client: () => client });
        expect(recorded.calls[0]).toEqual({
            command: "nvim",
            args: ["--server", "/tmp/nvim.sock", "--remote-ui"],
            cwd: realpathSync(sub),
        });
    });

    it("falls back to plain nvim when the daemon is not running", async () => {
        const recorded = recorder();
        const warnings: string[] = [];
        const code = await runAttach({
            cwd,
            isTTY: true,
            exec: recorded.exec,
            warn: (line) => warnings.push(line),
            client: () => {
                throw new CliError("no running pi2 daemon (daemon.json missing)");
            },
        });
        expect(code).toBe(0);
        expect(warnings[0]).toContain("no running pi2 daemon");
        expect(recorded.calls).toEqual([{ command: "nvim", args: [], cwd }]);
    });

    it("falls back to plain nvim when the HTTP call fails", async () => {
        const recorded = recorder();
        const warnings: string[] = [];
        await runAttach({
            cwd,
            isTTY: true,
            exec: recorded.exec,
            warn: (line) => warnings.push(line),
            client: () => {
                const client = fakeClient();
                client.get = async () => {
                    throw new CliError("cannot reach the pi2 daemon");
                };
                return client;
            },
        });
        expect(warnings[0]).toContain("cannot reach the pi2 daemon");
        expect(recorded.calls).toEqual([{ command: "nvim", args: [], cwd }]);
    });
});

describe("pi2 status", () => {
    it("renders a table with daemon, instances, resources and health", async () => {
        const lines: string[] = [];
        const client = fakeClient({
            workspaces: [
                workspace("/repo/pi2", {
                    name: "pi2",
                    liveCount: 2,
                    instance: instance({ status: "ready", hasUI: true }),
                }),
            ],
            resources: {
                instances: [{ workspaceId: "ws-1", instanceId: "i-1", nvimPid: 4321, rssBytes: 1024 * 1024, sessions: 2, hasUI: true }],
                totalRssBytes: 1024 * 1024,
                physicalMemoryBytes: 16 * 1024 * 1024 * 1024,
                warn: false,
            },
        });
        const code = await runStatus({ client, print: (line) => lines.push(line) });
        expect(code).toBe(0);
        const text = lines.join("\n");
        expect(text).toContain("daemon   http://127.0.0.1:7712");
        expect(text).toContain("pi2");
        expect(text).toContain("/repo/pi2");
        expect(text).toContain("ready");
        expect(text).toContain("resources  1 instance(s)");
        expect(text).toContain("health     ok");
    });

    it("emits JSON and exits 1 when health is not ok", async () => {
        const lines: string[] = [];
        const code = await runStatus({
            json: true,
            print: (line) => lines.push(line),
            client: fakeClient({ health: { ok: false, items: [{ name: "static", ok: false, detail: "missing" }] } }),
        });
        expect(code).toBe(1);
        const parsed = JSON.parse(lines.join("\n")) as {
            daemon: { url: string; v: number };
            instances: unknown[];
            resources: { totalRssBytes: number };
            health: { ok: boolean };
        };
        expect(parsed.daemon.url).toBe("http://127.0.0.1:7712");
        expect(parsed.daemon.v).toBe(PROTOCOL_VERSION);
        expect(parsed.instances).toEqual([]);
        expect(parsed.health.ok).toBe(false);
    });
});

describe("pi2 pairing", () => {
    it("posts with the local token and prints url, code and qr payload", async () => {
        const lines: string[] = [];
        const client = fakeClient({ pair: { accepted: true, code: "ABCD2345", expiresAt: Date.now() + 60_000 } });
        const code = await runPairing({ client, print: (line) => lines.push(line) });
        expect(code).toBe(0);
        const text = lines.join("\n");
        expect(text).toContain("url     http://127.0.0.1:7712/pair/ABCD2345");
        expect(text).toContain("code    ABCD2345");
        expect(text).toContain('"code":"ABCD2345"');
        expect(text).toContain('"v":1');
        expect(client.calls[0]).toBe("/api/v1/pair {}");
    });

    it("exits non-zero when the daemon rejects the request", async () => {
        await expect(
            runPairing({ client: fakeClient({ postError: new CliError("pair failed: E_UNAUTHORIZED") }) }),
        ).rejects.toThrowError(/E_UNAUTHORIZED/);
    });

    it("rebuilds the URL on --public-url when given", async () => {
        const lines: string[] = [];
        const client = fakeClient({ pair: { accepted: true, code: "ABCD2345" } });
        await runPairing({ client, print: (line) => lines.push(line), publicUrl: "https://myhost.tail1234.ts.net/" });
        const text = lines.join("\n");
        expect(text).toContain("url     https://myhost.tail1234.ts.net/pair/ABCD2345");
        expect(text).toContain('"url":"https://myhost.tail1234.ts.net/pair/ABCD2345"');
        expect(text).toContain("code    ABCD2345");
    });

    it("defaults --public-url to daemon.json's publicUrl", async () => {
        const lines: string[] = [];
        const client = fakeClient({ pair: { accepted: true, code: "ABCD2345" } });
        await main(["pairing"], {
            out: (line) => lines.push(line),
            client: () => ({ ...client, daemon: { ...DAEMON, publicUrl: "https://from-daemon.ts.net" } }),
        });
        expect(lines.join("\n")).toContain("url     https://from-daemon.ts.net/pair/ABCD2345");
    });

    it("keeps the loopback URL without flags", async () => {
        const lines: string[] = [];
        const client = fakeClient({ pair: { accepted: true, code: "ABCD2345" } });
        await main(["pairing"], { out: (line) => lines.push(line), client: () => client });
        expect(lines.join("\n")).toContain("url     http://127.0.0.1:7712/pair/ABCD2345");
    });
});

describe("pi2 open", () => {
    it("--print posts the console session and prints only the URL", async () => {
        const lines: string[] = [];
        const client = fakeClient({
            session: { token: "tok", url: "http://127.0.0.1:7712/#t=tok" },
        });
        const code = await runOpen({ client, print: (line) => lines.push(line), printOnly: true });
        expect(code).toBe(0);
        expect(lines).toEqual(["http://127.0.0.1:7712/#t=tok"]);
        expect(client.calls).toEqual(["/api/v1/console/session {}"]);
    });

    it("--print implies --no-browser (never launches an opener)", async () => {
        const lines: string[] = [];
        const opens: string[] = [];
        const code = await runOpen({
            client: fakeClient({ session: { url: "http://127.0.0.1:7712/#t=tok" } }),
            print: (line) => lines.push(line),
            printOnly: true,
            openUrl: (url) => opens.push(url),
        });
        expect(code).toBe(0);
        expect(opens).toEqual([]);
        expect(lines).toEqual(["http://127.0.0.1:7712/#t=tok"]);
    });

    it("launches the opener with the URL", async () => {
        const opens: string[] = [];
        const lines: string[] = [];
        const code = await runOpen({
            client: fakeClient({ session: { url: "http://127.0.0.1:7712/#t=tok" } }),
            print: (line) => lines.push(line),
            openUrl: (url) => opens.push(url),
        });
        expect(code).toBe(0);
        expect(opens).toEqual(["http://127.0.0.1:7712/#t=tok"]);
        expect(lines).toEqual([]);
    });

    it("prints the URL and still exits 0 when the opener fails", async () => {
        const lines: string[] = [];
        const code = await runOpen({
            client: fakeClient({ session: { url: "http://127.0.0.1:7712/#t=tok" } }),
            print: (line) => lines.push(line),
            openUrl: (_url, onError) => onError(),
        });
        expect(code).toBe(0);
        expect(lines).toEqual(["http://127.0.0.1:7712/#t=tok"]);
    });

    it("routes `pi2 open --print` through main", async () => {
        const out: string[] = [];
        const code = await main(["open", "--print"], {
            out: (line) => out.push(line),
            client: () => fakeClient({ session: { url: "http://127.0.0.1:7712/#t=tok" } }),
        });
        expect(code).toBe(0);
        expect(out).toEqual(["http://127.0.0.1:7712/#t=tok"]);
    });

    it("exits 1 with the daemon-resolution message when no daemon runs", async () => {
        const err: string[] = [];
        const code = await main(["open", "--print"], {
            err: (line) => err.push(line),
            client: () => {
                throw new CliError("no running pi2 daemon (…/daemon.json missing). Start it with `pi2 daemon`.");
            },
        });
        expect(code).toBe(1);
        expect(err[0]).toContain("no running pi2 daemon");
    });
});

describe("pi2 doctor (daemon probe wiring)", () => {
    it("reports the live daemon port and protocol version", async () => {
        const report = await runDoctorCommand({ client: () => fakeClient() });
        const daemon = report.checks.find((check) => check.name === "daemon");
        expect(daemon?.status).toBe("ok");
        expect(daemon?.detail).toContain("http://127.0.0.1:7712");
        expect(report.checks.find((check) => check.name === "protocol")?.status).toBe("ok");
        expect(report.checks.find((check) => check.name === "port")?.detail).toBe("7712 bound by the daemon");
    });

    it("reports an unreachable daemon without throwing", async () => {
        const report = await runDoctorCommand({
            client: () => {
                throw new CliError("no running pi2 daemon (daemon.json missing)");
            },
        });
        const daemon = report.checks.find((check) => check.name === "daemon");
        expect(daemon?.status).toBe("fail");
        expect(daemon?.detail).toContain("no running pi2 daemon");
        expect(report.ok).toBe(false);
    });
});

describe("pi2 main", () => {
    it("prints usage and version", async () => {
        const out: string[] = [];
        expect(await main([], { out: (line) => out.push(line) })).toBe(0);
        expect(out.join("\n")).toContain("pi2 attach [path]");

        out.length = 0;
        expect(await main(["--version"], { out: (line) => out.push(line) })).toBe(0);
        expect(out[0]).toMatch(/^pi2 \d+\.\d+\.\d+/);
    });

    it("rejects unknown commands and options with exit 2", async () => {
        const err: string[] = [];
        expect(await main(["nope"], { err: (line) => err.push(line) })).toBe(2);
        expect(err[0]).toBe('pi2: unknown command "nope"');

        err.length = 0;
        expect(await main(["attach", "--bogus"], { err: (line) => err.push(line) })).toBe(2);
        expect(err[0]).toContain("unknown option --bogus");
    });

    it("routes status --json through the injected client", async () => {
        const out: string[] = [];
        const client = fakeClient();
        expect(await main(["status", "--json"], { out: (line) => out.push(line), client: () => client })).toBe(0);
        expect(JSON.parse(out.join("\n"))).toMatchObject({ daemon: { url: "http://127.0.0.1:7712" } });
    });

    it("reports a missing daemon for status with exit 1", async () => {
        const err: string[] = [];
        const code = await main(["status"], {
            err: (line) => err.push(line),
            client: () => {
                throw new CliError("no running pi2 daemon");
            },
        });
        expect(code).toBe(1);
        expect(err[0]).toBe("pi2: no running pi2 daemon");
    });

    it("routes attach through runAttach with an injected exec", async () => {
        const recorded = recorder();
        const code = await main(["attach"], {
            cwd: process.cwd(),
            isTTY: true,
            exec: recorded.exec,
            client: () => fakeClient({ workspaces: [] }),
        });
        expect(code).toBe(0);
        expect(recorded.calls).toEqual([{ command: "nvim", args: [], cwd: process.cwd() }]);
    });

    it("dispatches `daemon` to the daemon entry point", async () => {
        const out: string[] = [];
        const err: string[] = [];
        const seen: string[][] = [];
        const code = await main(["daemon", "--help"], {
            out: (line) => out.push(line),
            err: (line) => err.push(line),
            daemonMain: async (argv, io) => {
                seen.push([...argv]);
                io.out("daemon usage");
                io.err("daemon warning");
                return 7;
            },
        });
        expect(code).toBe(7);
        expect(seen).toEqual([["--help"]]);
        expect(out).toEqual(["daemon usage"]);
        expect(err).toEqual(["daemon warning"]);
    });

    it("strips the optional `start` word before parsing daemon flags", async () => {
        const seen: string[][] = [];
        const code = await main(["daemon", "start", "--help"], {
            daemonMain: async (argv) => {
                seen.push([...argv]);
                return 0;
            },
        });
        expect(code).toBe(0);
        expect(seen).toEqual([["--help"]]);
    });

    it("exits 2 on an unknown daemon subcommand", async () => {
        const err: string[] = [];
        const code = await main(["daemon", "bogus"], { out: () => undefined, err: (line) => err.push(line) });
        expect(code).toBe(2);
        expect(err.join("\n")).toContain("unexpected argument bogus");
    });

    it("installs a service with --write through the injected writer", async () => {
        const out: string[] = [];
        const writes: { path: string; content: string }[] = [];
        const code = await main(["install-service", "--write"], {
            out: (line) => out.push(line),
            platform: "linux",
            servicePaths: {
                nodePath: "/usr/bin/node",
                scriptPath: "/repo/dist/cli/pi2.js",
                stateDir: "/state",
                homeDir: "/home/u",
                pathEnv: "/usr/bin",
            },
            writeFile: (path, content) => writes.push({ path, content }),
        });
        expect(code).toBe(0);
        expect(writes[0]?.path).toBe(join("/home/u/.config/systemd/user", "pi2.service"));
        expect(writes[0]?.content).toContain("ExecStart=/usr/bin/node /repo/dist/cli/pi2.js daemon --foreground");
        expect(out.join("\n")).toContain("systemctl --user enable --now pi2.service");
    });

    it("prints the service on the default dry-run", async () => {
        const out: string[] = [];
        const code = await main(["install-service"], {
            out: (line) => out.push(line),
            platform: "darwin",
            servicePaths: {
                nodePath: "/usr/bin/node",
                scriptPath: "/repo/dist/cli/pi2.js",
                stateDir: "/state",
                homeDir: "/home/u",
                pathEnv: "/usr/bin",
            },
        });
        expect(code).toBe(0);
        expect(out.join("\n")).toContain("<key>KeepAlive</key>");
        expect(out.join("\n")).toContain("would write /home/u/Library/LaunchAgents/com.pi2.daemon.plist");
    });

    it("renders doctor output and exits 1 when a check fails", async () => {
        const out: string[] = [];
        const code = await main(["doctor", "--json"], {
            out: (line) => out.push(line),
            doctor: async () => ({ ok: false, checks: [{ name: "node", status: "fail", detail: "v18.0.0" }] }),
        });
        expect(code).toBe(1);
        expect(JSON.parse(out.join("\n"))).toEqual({
            ok: false,
            checks: [{ name: "node", status: "fail", detail: "v18.0.0" }],
        });
    });
});
