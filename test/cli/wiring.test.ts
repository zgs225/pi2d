import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "../../src/protocol/types.js";
import { writeCliToken } from "../../src/cli/token.js";
import { wireDaemon, type WiredDaemon } from "../../src/cli/wiring.js";
import { clearRuntimeEnv, removeDir, setRuntimeEnv, silentLogger, tempDir } from "./helpers.js";

describe("wireDaemon", () => {
    let dir: string;
    let wired: WiredDaemon | undefined;

    beforeEach(() => {
        dir = tempDir();
        setRuntimeEnv(dir);
        mkdirSync(join(dir, "web"), { recursive: true });
        writeFileSync(join(dir, "web", "index.html"), "<!doctype html><title>pi2</title><div id=app></div>");
        mkdirSync(join(dir, "sessions"), { recursive: true });
    });

    afterEach(async () => {
        if (wired !== undefined) await wired.close();
        wired = undefined;
        clearRuntimeEnv();
        removeDir(dir);
    });

    it("boots on port 0 with temp dirs and serves info, health and the static UI", async () => {
        wired = await wireDaemon({ logger: silentLogger, discoveryRoot: join(dir, "sessions") });
        const token = writeCliToken(wired.cliTokenPath);
        const server = await wired.start();

        expect(server.port).toBeGreaterThan(0);
        expect(wired.config.port).toBe(server.port);
        expect(wired.config.host).toBe("0.0.0.0");
        expect(wired.deps.daemonId).toMatch(/^d-/);
        expect(wired.deps.instances).toBe(wired.instanceManager);
        expect(wired.deps.workspaces).toBe(wired.workspaceStore);
        expect(wired.deps.auth).toBe(wired.auth);

        const info = await fetch(`${server.url}/api/v1/info`);
        expect(info.status).toBe(200);
        const infoBody = (await info.json()) as { v: number; daemonId: string; capabilities: string[] };
        expect(infoBody.v).toBe(PROTOCOL_VERSION);
        expect(infoBody.daemonId).toBe(wired.deps.daemonId);
        expect(infoBody.capabilities).toContain("ws");

        const health = await fetch(`${server.url}/api/v1/health`);
        expect(health.status).toBe(200);
        const healthBody = (await health.json()) as { ok: boolean; items: { name: string; ok: boolean }[] };
        expect(healthBody.ok).toBe(true);
        expect(healthBody.items.find((item) => item.name === "static")?.ok).toBe(true);

        const page = await fetch(`${server.url}/`);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toContain("text/html");
        expect(await page.text()).toContain("<div id=app>");

        // The minted CLI token authenticates as the local admin device.
        const authorized = await fetch(`${server.url}/api/v1/workspaces`, {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(authorized.status).toBe(200);
        expect(Array.isArray(await authorized.json())).toBe(true);

        const anonymous = await fetch(`${server.url}/api/v1/workspaces`);
        expect(anonymous.status).toBe(401);
    });

    it("starts the plugin unix socket in the configured runtime dir", async () => {
        wired = await wireDaemon({ logger: silentLogger, discoveryRoot: join(dir, "sessions") });
        const { existsSync } = await import("node:fs");
        expect(existsSync(join(dir, "run", "d.sock"))).toBe(true);
        expect(existsSync(join(dir, "run", "d.sock.token"))).toBe(true);

        await wired.close();
        wired = undefined;
        expect(existsSync(join(dir, "run", "d.sock"))).toBe(false);
    });

    it("resolves workspace cwd through the store and rejects unknown workspaces", async () => {
        wired = await wireDaemon({ logger: silentLogger, discoveryRoot: join(dir, "sessions") });
        await expect(wired.instanceManager.ensure("ws-missing", { timeoutMs: 100 })).rejects.toMatchObject({
            code: "E_NOT_FOUND",
        });
    });

    it("is idempotent on start()", async () => {
        wired = await wireDaemon({ logger: silentLogger, discoveryRoot: join(dir, "sessions") });
        const first = await wired.start();
        const second = await wired.start();
        expect(second).toBe(first);
    });

    it("close() is idempotent", async () => {
        wired = await wireDaemon({ logger: silentLogger, discoveryRoot: join(dir, "sessions") });
        await wired.start();
        await wired.close();
        await wired.close();
        wired = undefined;
    });
});
