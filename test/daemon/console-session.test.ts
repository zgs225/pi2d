import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../../src/daemon/auth.js";
import { createApp } from "../../src/daemon/http.js";
import type { Config } from "../../src/config.js";
import { FakeBus, FakeInstanceManager, FakeWorkspaceStore } from "./fakes.js";
import { createHarness, TEST_LIMITS, type Harness } from "./harness.js";

const CLI_TOKEN = "c".repeat(64);

interface SessionBody {
    token: string;
    device: {
        id: string;
        name: string;
        kind: string;
        scopes: string[];
        createdAt: number;
        lastSeenAt: number;
        revokedAt: number | null;
    };
    url: string;
}

/** Non-loopback requests only exist behind the socket; drive Hono directly. */
async function appWithRemoteAddress(config: Config, auth: AuthStore, remoteAddress: string): Promise<Response> {
    const app = createApp({
        config,
        auth,
        instances: new FakeInstanceManager(),
        workspaces: new FakeWorkspaceStore(),
        bus: new FakeBus(),
        daemonId: "d-test",
    });
    return app.request(
        "/api/v1/console/session",
        { method: "POST", headers: { authorization: `Bearer ${CLI_TOKEN}` } },
        { incoming: { socket: { remoteAddress } } } as never,
    );
}

describe("POST /api/v1/console/session", () => {
    let h: Harness;

    afterEach(async () => {
        await h.cleanup();
    });

    it("mints a loopback browser session for the local CLI token", async () => {
        h = await createHarness({ cliToken: CLI_TOKEN });

        const res = await fetch(`${h.url}/api/v1/console/session`, {
            method: "POST",
            headers: { authorization: `Bearer ${CLI_TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as SessionBody;

        expect(body.device.name).toBe("local browser");
        expect(body.device.kind).toBe("laptop");
        expect(body.device.scopes).toEqual(["read", "steer", "control", "admin"]);
        expect(body.token.length).toBeGreaterThanOrEqual(40);
        expect(body.url).toBe(`http://127.0.0.1:${h.server.port}/#t=${encodeURIComponent(body.token)}`);
        expect(body.url).not.toContain("?t=");
        expect(h.auth.verifyToken(body.token)?.id).toBe(body.device.id);
        // Exactly one device record, and no local-CLI record leaks into it.
        expect(h.auth.listDevices().map((device) => device.name)).toEqual(["local browser"]);
    });

    it("accepts an absent body ({} is optional)", async () => {
        h = await createHarness({ cliToken: CLI_TOKEN });
        const res = await fetch(`${h.url}/api/v1/console/session`, {
            method: "POST",
            headers: { authorization: `Bearer ${CLI_TOKEN}` },
        });
        expect(res.status).toBe(200);
    });

    it("reuses one device and one token across calls, so reopening keeps the tab alive", async () => {
        h = await createHarness({ cliToken: CLI_TOKEN });
        const call = async (): Promise<SessionBody> => {
            const res = await fetch(`${h.url}/api/v1/console/session`, {
                method: "POST",
                headers: { authorization: `Bearer ${CLI_TOKEN}` },
            });
            return (await res.json()) as SessionBody;
        };

        const first = await call();
        const second = await call();
        expect(second.device.id).toBe(first.device.id);
        expect(second.token).toBe(first.token);
        expect(second.url).toBe(first.url);
        expect(h.auth.verifyToken(second.token)?.id).toBe(first.device.id);
        expect(h.auth.listDevices()).toHaveLength(1);
        expect(second.url).toContain(`#t=${encodeURIComponent(second.token)}`);
    });

    it("mints a new token after the local browser is revoked", async () => {
        h = await createHarness({ cliToken: CLI_TOKEN });
        const call = async (): Promise<SessionBody> => {
            const res = await fetch(`${h.url}/api/v1/console/session`, {
                method: "POST",
                headers: { authorization: `Bearer ${CLI_TOKEN}` },
            });
            return (await res.json()) as SessionBody;
        };

        const first = await call();
        expect(h.auth.revokeDevice(first.device.id)).toBe(true);

        const second = await call();
        expect(second.device.id).toBe(first.device.id);
        expect(second.token).not.toBe(first.token);
        expect(h.auth.verifyToken(first.token)).toBeNull();
        expect(h.auth.verifyToken(second.token)?.id).toBe(first.device.id);
    });

    it("answers 401 without a token", async () => {
        h = await createHarness({ cliToken: CLI_TOKEN });
        const res = await fetch(`${h.url}/api/v1/console/session`, { method: "POST" });
        expect(res.status).toBe(401);
        expect(((await res.json()) as { code: string }).code).toBe("E_UNAUTHORIZED");
    });

    it("answers 401 for a paired device token (the CLI token is required)", async () => {
        h = await createHarness({ cliToken: CLI_TOKEN });
        const deviceToken = h.createToken("paired phone");
        const res = await fetch(`${h.url}/api/v1/console/session`, {
            method: "POST",
            headers: { authorization: `Bearer ${deviceToken}` },
        });
        expect(res.status).toBe(401);
    });

    it("answers 403 from a non-loopback client", async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi2-console-"));
        try {
            writeFileSync(join(dir, "cli.token"), `${CLI_TOKEN}\n`, { mode: 0o600 });
            const auth = new AuthStore({ path: join(dir, "devices.json"), localTokenPath: join(dir, "cli.token") });
            const config: Config = {
                host: "0.0.0.0",
                port: 7676,
                staticDir: join(dir, "web"),
                corsOrigins: [],
                limits: TEST_LIMITS,
                tokenPath: join(dir, "d.sock.token"),
                deviceStorePath: join(dir, "devices.json"),
                access: "lan",
                publicUrl: null,
            };

            for (const remoteAddress of ["192.168.2.50", "100.101.102.103"]) {
                const res = await appWithRemoteAddress(config, auth, remoteAddress);
                expect(res.status).toBe(403);
                const body = (await res.json()) as { code: string; message: string };
                expect(body.code).toBe("E_FORBIDDEN");
                expect(body.message).toBe("console login is loopback-only");
            }
            // No device was created by the rejected calls.
            expect(auth.listDevices()).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("GET /api/v1/info access fields", () => {
    it("reports access always and publicUrl as string|null", async () => {
        const h = await createHarness({ config: { access: "tailscale", publicUrl: "https://host.ts.net" } });
        try {
            const body = (await (await fetch(`${h.url}/api/v1/info`)).json()) as Record<string, unknown>;
            expect(body.access).toBe("tailscale");
            expect(body.publicUrl).toBe("https://host.ts.net");
            // Existing keys survive.
            expect(body.v).toBe(1);
            expect(body.port).toBe(h.server.port);
        } finally {
            await h.cleanup();
        }
    });

    it("keeps the local default", async () => {
        const h = await createHarness();
        try {
            const body = (await (await fetch(`${h.url}/api/v1/info`)).json()) as Record<string, unknown>;
            expect(body.access).toBe("local");
            expect(body.publicUrl).toBeNull();
        } finally {
            await h.cleanup();
        }
    });
});
