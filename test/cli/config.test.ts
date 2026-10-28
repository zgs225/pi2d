import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { main } from "../../src/cli/pi2.js";
import {
    CONFIG_KEYS,
    CONFIG_USAGE,
    configToJson,
    formatConfigTable,
    resolveConfig,
    type ConfigJsonOutput,
} from "../../src/cli/config.js";

describe("pi2 config", () => {
    describe("resolveConfig", () => {
        it("returns defaults and layout sources when env is empty", () => {
            const resolution = resolveConfig({
                env: {},
                platform: "linux",
                home: "/home/user",
                uid: 1000,
                version: "1.2.3",
                runtime: "node 22.0.0",
                installShape: "node",
                staticDir: "/repo/web/dist",
            });

            expect(resolution.config).toEqual({
                port: 7676,
                host: "0.0.0.0",
                publicUrl: null,
                staticDir: "/repo/web/dist",
                runtimeDir: "/tmp/pi2-1000/pi2",
                dataDir: "/home/user/.local/share/pi2",
                stateDir: "/home/user/.local/state/pi2",
                codingAgentDir: "/home/user/.pi/agent",
                workspaceRoots: ["/home/user"],
                logLevel: "info",
                version: "1.2.3",
                platform: "linux",
                runtime: "node 22.0.0",
                installShape: "node",
            });

            expect(resolution.sources).toEqual({
                port: "default",
                host: "default",
                publicUrl: "default",
                staticDir: "install layout",
                runtimeDir: "default",
                dataDir: "default",
                stateDir: "default",
                codingAgentDir: "default",
                workspaceRoots: "default",
                logLevel: "default",
                version: "install layout",
                platform: "system",
                runtime: "runtime",
                installShape: "install layout",
            });
        });

        it("resolves darwin paths when platform is darwin", () => {
            const resolution = resolveConfig({
                env: {},
                platform: "darwin",
                home: "/Users/testuser",
                uid: 501,
            });

            expect(resolution.config.platform).toBe("darwin");
            expect(resolution.config.runtimeDir).toBe("/Users/testuser/Library/Caches/pi2/run");
            expect(resolution.config.dataDir).toBe("/Users/testuser/Library/Application Support/pi2");
            expect(resolution.config.stateDir).toBe("/Users/testuser/Library/Logs/pi2");
            expect(resolution.sources.runtimeDir).toBe("default");
            expect(resolution.sources.dataDir).toBe("default");
            expect(resolution.sources.stateDir).toBe("default");
        });

        it("attributes values to environment variables when set", () => {
            const resolution = resolveConfig({
                env: {
                    PI2_PORT: "0",
                    PI2_HOST: "127.0.0.1",
                    PI2_PUBLIC_URL: "https://pi2.local/",
                    PI2_STATIC_DIR: "/opt/pi2/ui",
                    PI2_RUNTIME_DIR: "/custom/run",
                    PI2_DATA_DIR: "/custom/data",
                    PI2_STATE_DIR: "/custom/state",
                    PI2_WORKSPACE_ROOTS: "/projects,/extra/work",
                    PI2_LOG_LEVEL: "DEBUG",
                },
                platform: "linux",
                home: "/home/user",
                uid: 1000,
            });

            expect(resolution.config.port).toBe(0);
            expect(resolution.sources.port).toBe("PI2_PORT");

            expect(resolution.config.host).toBe("127.0.0.1");
            expect(resolution.sources.host).toBe("PI2_HOST");

            expect(resolution.config.publicUrl).toBe("https://pi2.local");
            expect(resolution.sources.publicUrl).toBe("PI2_PUBLIC_URL");

            expect(resolution.config.staticDir).toBe("/opt/pi2/ui");
            expect(resolution.sources.staticDir).toBe("PI2_STATIC_DIR");

            expect(resolution.config.runtimeDir).toBe("/custom/run");
            expect(resolution.sources.runtimeDir).toBe("PI2_RUNTIME_DIR");

            expect(resolution.config.dataDir).toBe("/custom/data");
            expect(resolution.sources.dataDir).toBe("PI2_DATA_DIR");

            expect(resolution.config.stateDir).toBe("/custom/state");
            expect(resolution.sources.stateDir).toBe("PI2_STATE_DIR");

            expect(resolution.config.workspaceRoots).toEqual(["/projects", "/extra/work"]);
            expect(resolution.sources.workspaceRoots).toBe("PI2_WORKSPACE_ROOTS");

            expect(resolution.config.logLevel).toBe("debug");
            expect(resolution.sources.logLevel).toBe("PI2_LOG_LEVEL");
        });

        it("does not throw when directories do not exist", () => {
            expect(() => {
                resolveConfig({
                    env: {
                        PI2_RUNTIME_DIR: "/nonexistent/path/for/runtime",
                        PI2_DATA_DIR: "/nonexistent/path/for/data",
                        PI2_STATE_DIR: "/nonexistent/path/for/state",
                        PI2_WORKSPACE_ROOTS: "/nonexistent/workspace/dir",
                    },
                    home: "/nonexistent/home",
                });
            }).not.toThrow();
        });

        it("throws when PI2_PORT is not a valid integer", () => {
            expect(() => {
                resolveConfig({ env: { PI2_PORT: "not-a-number" } });
            }).toThrow('PI2_PORT must be an integer, got "not-a-number"');
        });

        it("throws when PI2_PORT is out of range", () => {
            expect(() => {
                resolveConfig({ env: { PI2_PORT: "70000" } });
            }).toThrow('PI2_PORT must be between 0 and 65535, got "70000"');
        });
    });

    describe("formatConfigTable", () => {
        it("formats a three-column table with key, value, and source", () => {
            const resolution = resolveConfig({
                env: {
                    PI2_PORT: "0",
                    PI2_HOST: "127.0.0.1",
                },
                platform: "linux",
                home: "/home/user",
                uid: 1000,
                version: "1.0.0",
                runtime: "node 22.0.0",
                installShape: "node",
                staticDir: "/repo/web/dist",
            });

            const table = formatConfigTable(resolution);
            const lines = table.split("\n");

            // Header line has key, value, source
            expect(lines[0]).toMatch(/^key\s+value\s+source$/);
            // Separator line has dashes
            expect(lines[1]).toMatch(/^--+\s+--+\s+--+$/);

            // Check that all keys are present in order
            for (const key of CONFIG_KEYS) {
                expect(table).toContain(key);
            }

            // Port 0 and host 127.0.0.1 show up with source PI2_PORT / PI2_HOST
            expect(table).toMatch(/port\s+0\s+PI2_PORT/);
            expect(table).toMatch(/host\s+127\.0\.0\.1\s+PI2_HOST/);
            // Unset publicUrl shows up as - with source default
            expect(table).toMatch(/publicUrl\s+-\s+default/);
            // staticDir shows source install layout
            expect(table).toMatch(/staticDir\s+\/repo\/web\/dist\s+install layout/);
        });
    });

    describe("configToJson", () => {
        it("returns a JSON string with resolved keys and sources map", () => {
            const resolution = resolveConfig({
                env: {
                    PI2_PORT: "0",
                    PI2_HOST: "127.0.0.1",
                },
                platform: "linux",
                home: "/home/user",
                uid: 1000,
                version: "1.0.0",
                runtime: "node 22.0.0",
                installShape: "node",
                staticDir: "/repo/web/dist",
            });

            const jsonStr = configToJson(resolution);
            const parsed = JSON.parse(jsonStr) as ConfigJsonOutput;

            expect(parsed.port).toBe(0);
            expect(parsed.host).toBe("127.0.0.1");
            expect(parsed.publicUrl).toBeNull();
            expect(parsed.staticDir).toBe("/repo/web/dist");
            expect(parsed.logLevel).toBe("info");
            expect(parsed.version).toBe("1.0.0");
            expect(parsed.platform).toBe("linux");
            expect(parsed.runtime).toBe("node 22.0.0");
            expect(parsed.installShape).toBe("node");

            expect(parsed.sources).toEqual({
                port: "PI2_PORT",
                host: "PI2_HOST",
                publicUrl: "default",
                staticDir: "install layout",
                runtimeDir: "default",
                dataDir: "default",
                stateDir: "default",
                codingAgentDir: "default",
                workspaceRoots: "default",
                logLevel: "default",
                version: "install layout",
                platform: "system",
                runtime: "runtime",
                installShape: "install layout",
            });
        });
    });

    describe("CLI integration (main)", () => {
        it("prints formatted table with injectable env", async () => {
            const out: string[] = [];
            const err: string[] = [];
            const code = await main(["config"], {
                env: {
                    PI2_PORT: "0",
                    PI2_HOST: "127.0.0.1",
                    PI2_RUNTIME_DIR: "/tmp/c1",
                    PI2_DATA_DIR: "/tmp/c2",
                    PI2_STATE_DIR: "/tmp/c3",
                },
                out: (line) => out.push(line),
                err: (line) => err.push(line),
            });

            expect(code).toBe(0);
            expect(err).toHaveLength(0);
            const text = out.join("\n");
            expect(text).toMatch(/^key\s+value\s+source/);
            expect(text).toMatch(/port\s+0\s+PI2_PORT/);
            expect(text).toMatch(/host\s+127\.0\.0\.1\s+PI2_HOST/);
            expect(text).toMatch(/runtimeDir\s+\/tmp\/c1\s+PI2_RUNTIME_DIR/);
            expect(text).toMatch(/dataDir\s+\/tmp\/c2\s+PI2_DATA_DIR/);
            expect(text).toMatch(/stateDir\s+\/tmp\/c3\s+PI2_STATE_DIR/);
        });

        it("prints JSON when --json is provided and matches table values", async () => {
            const out: string[] = [];
            const err: string[] = [];
            const code = await main(["config", "--json"], {
                env: {
                    PI2_PORT: "0",
                    PI2_HOST: "127.0.0.1",
                },
                out: (line) => out.push(line),
                err: (line) => err.push(line),
            });

            expect(code).toBe(0);
            expect(err).toHaveLength(0);
            const parsed = JSON.parse(out.join("\n")) as ConfigJsonOutput;
            expect(parsed.port).toBe(0);
            expect(parsed.host).toBe("127.0.0.1");
            expect(parsed.sources.port).toBe("PI2_PORT");
            expect(parsed.sources.host).toBe("PI2_HOST");
            expect(parsed.sources.runtimeDir).toBe("default");
        });

        it("prints usage on --help and exits 0", async () => {
            const out: string[] = [];
            const err: string[] = [];
            const code = await main(["config", "--help"], {
                out: (line) => out.push(line),
                err: (line) => err.push(line),
            });

            expect(code).toBe(0);
            expect(err).toHaveLength(0);
            expect(out.join("\n")).toBe(CONFIG_USAGE);
        });

        it("prints usage on -h and exits 0", async () => {
            const out: string[] = [];
            const err: string[] = [];
            const code = await main(["config", "-h"], {
                out: (line) => out.push(line),
                err: (line) => err.push(line),
            });

            expect(code).toBe(0);
            expect(err).toHaveLength(0);
            expect(out.join("\n")).toBe(CONFIG_USAGE);
        });

        it("exits 2 on unknown flags with usage error", async () => {
            const out: string[] = [];
            const err: string[] = [];
            const code = await main(["config", "--unknown"], {
                out: (line) => out.push(line),
                err: (line) => err.push(line),
            });

            expect(code).toBe(2);
            expect(out).toHaveLength(0);
            expect(err.some((line) => line.includes("unknown option --unknown"))).toBe(true);
            expect(err.some((line) => line.includes("pi2 config"))).toBe(true);
        });

        it("exits 2 on unexpected positional arguments", async () => {
            const out: string[] = [];
            const err: string[] = [];
            const code = await main(["config", "extra-arg"], {
                out: (line) => out.push(line),
                err: (line) => err.push(line),
            });

            expect(code).toBe(2);
            expect(out).toHaveLength(0);
            expect(err.some((line) => line.includes('unexpected argument "extra-arg"'))).toBe(true);
        });

        it("exits 1 on invalid PI2_PORT error", async () => {
            const out: string[] = [];
            const err: string[] = [];
            const code = await main(["config"], {
                env: { PI2_PORT: "bad-port" },
                out: (line) => out.push(line),
                err: (line) => err.push(line),
            });

            expect(code).toBe(1);
            expect(err.some((line) => line.includes("PI2_PORT must be an integer"))).toBe(true);
        });
    });
});
