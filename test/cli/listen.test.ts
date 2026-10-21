import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type AddressInfo, type Server as NetServer } from "node:net";
import { AuthStore } from "../../src/daemon/auth.js";
import type { ServerDeps } from "../../src/daemon/server.js";
import { isAddressInUse, listenWithRetry, withPort } from "../../src/cli/listen.js";
import { FakeBus, FakeInstanceManager, FakeWorkspaceStore } from "../daemon/fakes.js";
import { removeDir, silentLogger, tempDir, testConfig } from "./helpers.js";

async function occupyPort(): Promise<{ port: number; close(): Promise<void> }> {
    const server: NetServer = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    return {
        port: address.port,
        close: (): Promise<void> => new Promise((resolve) => server.close(() => resolve())),
    };
}

describe("listenWithRetry", () => {
    let dir: string;
    let deps: ServerDeps;
    const cleanups: (() => Promise<void>)[] = [];

    beforeEach(() => {
        dir = tempDir("pi2-listen-");
        deps = {
            auth: new AuthStore({ path: `${dir}/devices.json` }),
            instances: new FakeInstanceManager(),
            workspaces: new FakeWorkspaceStore([]),
            bus: new FakeBus(),
            logger: silentLogger,
            daemonId: "d-listen",
        };
    });

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) await cleanup();
        removeDir(dir);
    });

    it("binds port 0 without retrying", async () => {
        const config = testConfig({ port: 0 });
        const server = await listenWithRetry(config, deps, { retries: 9 });
        cleanups.push(() => server.close());
        expect(server.port).toBeGreaterThan(0);
        expect(server.url).toContain(`:${server.port}`);
    });

    it("walks to the next port when the default is taken", async () => {
        const busy = await occupyPort();
        cleanups.push(() => busy.close());
        const config = testConfig({
            port: busy.port,
            corsOrigins: [`http://127.0.0.1:${busy.port}`, `http://localhost:${busy.port}`],
        });
        const retries: { from: number; to: number }[] = [];
        const server = await listenWithRetry(config, deps, {
            retries: 9,
            onRetry: (info) => retries.push({ from: info.from, to: info.to }),
        });
        cleanups.push(() => server.close());

        expect(server.port).toBeGreaterThan(busy.port);
        expect(retries[0]).toEqual({ from: busy.port, to: busy.port + 1 });
        // The derived CORS origins follow the effective port.
        expect(server.config.corsOrigins).toEqual([
            `http://127.0.0.1:${server.port}`,
            `http://localhost:${server.port}`,
        ]);
    });

    it("fails fast on an explicit port", async () => {
        const busy = await occupyPort();
        cleanups.push(() => busy.close());
        const config = testConfig({ port: busy.port });
        await expect(listenWithRetry(config, deps, { retries: 0 })).rejects.toSatisfy(isAddressInUse);
    });

    it("stops retrying when the budget is exhausted", async () => {
        const busy = await occupyPort();
        cleanups.push(() => busy.close());
        const busyNext = createServer();
        await new Promise<void>((resolve, reject) => {
            busyNext.once("error", reject);
            busyNext.listen(busy.port + 1, "127.0.0.1", () => resolve());
        });
        cleanups.push(() => new Promise<void>((resolve) => busyNext.close(() => resolve())));

        const config = testConfig({ port: busy.port });
        let attempts = 0;
        await expect(
            listenWithRetry(config, deps, {
                retries: 1,
                onRetry: () => {
                    attempts += 1;
                },
            }),
        ).rejects.toSatisfy(isAddressInUse);
        expect(attempts).toBe(1);
    });
});

describe("withPort", () => {
    it("rewrites derived origins and keeps custom ones", () => {
        const config = testConfig({
            port: 7676,
            corsOrigins: ["http://127.0.0.1:7676", "http://localhost:7676", "https://pi2.example"],
        });
        expect(withPort(config, 7676)).toBe(config);
        expect(withPort(config, 7678).corsOrigins).toEqual([
            "http://127.0.0.1:7678",
            "http://localhost:7678",
            "https://pi2.example",
        ]);
        expect(withPort(config, 7678).port).toBe(7678);
    });
});

describe("isAddressInUse", () => {
    it("recognises EADDRINUSE only", () => {
        expect(isAddressInUse(Object.assign(new Error("busy"), { code: "EADDRINUSE" }))).toBe(true);
        expect(isAddressInUse(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
        expect(isAddressInUse(new Error("plain"))).toBe(false);
    });
});
