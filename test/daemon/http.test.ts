import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeSessionState, makeWorkspaceInfo } from "./fakes.js";
import { createHarness, TEST_LIMITS, type Harness } from "./harness.js";
import { DaemonError } from "../../src/daemon/errors.js";
import { ERROR_CODES } from "../../src/protocol/errors.js";

describe("HTTP API", () => {
    let h: Harness;
    let token: string;
    let conn: NonNullable<ReturnType<Harness["instances"]["get"]>>;

    beforeEach(async () => {
        h = await createHarness({
            workspaces: [makeWorkspaceInfo("ws-1")],
            seedInstances: ["ws-1"],
            config: { corsOrigins: ["http://allowed.test"] },
        });
        token = h.createToken();
        h.instances.sessionOwners.set("s1", "ws-1");
        conn = h.instances.get("ws-1")!;
        conn.snapshots.set("s1", makeSessionState("s1", "ws-1"));
        conn.seqs.set("s1", 7);
    });

    afterEach(async () => {
        await h.cleanup();
    });

    function authed(init: RequestInit = {}): RequestInit {
        return {
            ...init,
            headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        };
    }

    it("serves info and health without auth on loopback", async () => {
        const info = await fetch(`${h.url}/api/v1/info`);
        expect(info.status).toBe(200);
        const body = (await info.json()) as Record<string, unknown>;
        expect(body.v).toBe(1);
        expect(body.daemonId).toBe("d-test");
        expect(body.machineId).toBe("m-test");
        expect(body.limits).toEqual(TEST_LIMITS);

        const health = await fetch(`${h.url}/api/v1/health`);
        expect(health.status).toBe(200);
        const healthBody = (await health.json()) as { ok: boolean; items: { name: string; ok: boolean }[] };
        expect(healthBody.ok).toBe(true);
        expect(healthBody.items.length).toBeGreaterThan(0);
        expect(healthBody.items.every((item) => item.ok)).toBe(true);
    });

    it("requires a bearer token for all other API reads", async () => {
        const anonymous = await fetch(`${h.url}/api/v1/workspaces`);
        expect(anonymous.status).toBe(401);
        expect(((await anonymous.json()) as { code: string }).code).toBe(ERROR_CODES.UNAUTHORIZED);

        const bad = await fetch(`${h.url}/api/v1/workspaces`, {
            headers: { Authorization: "Bearer nope" },
        });
        expect(bad.status).toBe(401);

        const good = await fetch(`${h.url}/api/v1/workspaces`, authed());
        expect(good.status).toBe(200);
        const workspaces = (await good.json()) as { workspaceId: string }[];
        expect(workspaces.map((workspace) => workspace.workspaceId)).toEqual(["ws-1"]);
    });

    it("enforces the origin allow-list on open and authenticated endpoints", async () => {
        const denied = await fetch(`${h.url}/api/v1/info`, {
            headers: { Origin: "http://evil.test" },
        });
        expect(denied.status).toBe(403);
        expect(((await denied.json()) as { code: string }).code).toBe(ERROR_CODES.FORBIDDEN);

        const allowed = await fetch(`${h.url}/api/v1/info`, {
            headers: { Origin: "http://allowed.test" },
        });
        expect(allowed.status).toBe(200);
        expect(allowed.headers.get("access-control-allow-origin")).toBe("http://allowed.test");

        const allowedWithToken = await fetch(
            `${h.url}/api/v1/workspaces`,
            authed({ headers: { Origin: "http://allowed.test" } }),
        );
        expect(allowedWithToken.status).toBe(200);
        expect(allowedWithToken.headers.get("access-control-allow-origin")).toBe("http://allowed.test");
    });

    it("answers CORS preflight", async () => {
        const res = await fetch(`${h.url}/api/v1/cmd`, {
            method: "OPTIONS",
            headers: {
                Origin: "http://allowed.test",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization,content-type",
            },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get("access-control-allow-origin")).toBe("http://allowed.test");
        expect(res.headers.get("access-control-allow-methods")).toContain("POST");
        expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");

        const denied = await fetch(`${h.url}/api/v1/cmd`, {
            method: "OPTIONS",
            headers: { Origin: "http://evil.test" },
        });
        expect(denied.status).toBe(403);
    });

    it("routes commands to the owning instance and dedupes clientRequestId", async () => {
        const payload = {
            method: "prompt.send",
            sessionId: "s1",
            params: { text: "hi" },
            clientRequestId: "c-1",
        };
        const first = await fetch(`${h.url}/api/v1/cmd`, authed({ method: "POST", body: JSON.stringify(payload) }));
        expect(first.status).toBe(202);
        const firstBody = (await first.json()) as Record<string, unknown>;
        expect(firstBody.accepted).toBe(true);
        expect(firstBody.disposition).toBe("started");

        const second = await fetch(`${h.url}/api/v1/cmd`, authed({ method: "POST", body: JSON.stringify(payload) }));
        expect(second.status).toBe(202);
        expect(await second.json()).toEqual(firstBody);

        expect(h.instances.ensureCalls).toEqual(["ws-1"]);
        expect(conn.commands).toHaveLength(1);
        expect(conn.commands[0]!.method).toBe("prompt.send");
        expect(conn.commands[0]!.clientRequestId).toBe("c-1");
    });

    it("rejects malformed JSON and unknown sessions", async () => {
        const malformed = await fetch(`${h.url}/api/v1/cmd`, authed({ method: "POST", body: "{not json" }));
        expect(malformed.status).toBe(400);
        expect(((await malformed.json()) as { code: string }).code).toBe(ERROR_CODES.BAD_REQUEST);

        const missing = await fetch(
            `${h.url}/api/v1/cmd`,
            authed({ method: "POST", body: JSON.stringify({ method: "prompt.send", sessionId: "missing" }) }),
        );
        expect(missing.status).toBe(404);
        expect(((await missing.json()) as { code: string }).code).toBe(ERROR_CODES.SESSION_NOT_FOUND);
    });

    it("maps router errors to HTTP statuses", async () => {
        conn.commandHandler = async () => {
            throw new DaemonError(ERROR_CODES.LEASE_CONFLICT, "session is owned by instance i-2");
        };
        const res = await fetch(
            `${h.url}/api/v1/cmd`,
            authed({ method: "POST", body: JSON.stringify({ method: "prompt.send", sessionId: "s1" }) }),
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { code: string; retryable: boolean };
        expect(body.code).toBe(ERROR_CODES.LEASE_CONFLICT);
        expect(body.retryable).toBe(false);
    });

    it("enforces the body limit", async () => {
        const small = await createHarness({ config: { limits: { ...TEST_LIMITS, maxBodyBytes: 16 } } });
        try {
            const localToken = small.createToken();
            const res = await fetch(`${small.url}/api/v1/cmd`, {
                method: "POST",
                headers: { Authorization: `Bearer ${localToken}` },
                body: JSON.stringify({ method: "prompt.send", params: { text: "far too much text" } }),
            });
            expect(res.status).toBe(413);
            expect(((await res.json()) as { code: string }).code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
        } finally {
            await small.cleanup();
        }
    });

    it("relays workspace/session queries through instance.command", async () => {
        conn.commandHandler = async (call) => {
            if (call.method === "workspace.query" && call.params?.kind === "sessions") {
                return { seq: 1, disposition: "started", sessions: [{ sessionId: "s1" }] } as never;
            }
            if (call.method === "session.entries") {
                return { seq: 1, disposition: "started", entries: [{ id: "e1" }] } as never;
            }
            return { seq: 1, disposition: "started" };
        };

        const sessions = await fetch(`${h.url}/api/v1/workspaces/ws-1/sessions`, authed());
        expect(sessions.status).toBe(200);
        const sessionsBody = (await sessions.json()) as { sessions: { sessionId: string }[] };
        expect(sessionsBody.sessions).toEqual([{ sessionId: "s1" }]);

        const entries = await fetch(`${h.url}/api/v1/sessions/s1/entries?before=e9&limit=25`, authed());
        expect(entries.status).toBe(200);
        const entryCall = conn.commands.find((call) => call.method === "session.entries");
        expect(entryCall?.params).toEqual({ before: "e9", limit: 25 });
        expect((await entries.json()) as { entries: unknown[] }).toHaveProperty("entries");

        const attention = await fetch(`${h.url}/api/v1/attention?workspaceId=ws-1`, authed());
        expect(attention.status).toBe(200);
        const models = await fetch(`${h.url}/api/v1/models?workspaceId=ws-1`, authed());
        expect(models.status).toBe(200);
        expect(conn.commands.some((call) => call.method === "workspace.query" && call.params?.kind === "models")).toBe(
            true,
        );
    });

    it("returns resources and diagnostics", async () => {
        h.instances.resourcesValue = {
            instances: [
                {
                    workspaceId: "ws-1",
                    instanceId: "i-ws-1",
                    nvimPid: 42,
                    rssBytes: 1000,
                    sessions: 1,
                    hasUI: true,
                },
            ],
            totalRssBytes: 1000,
            physicalMemoryBytes: 2000,
            warn: false,
        };
        const resources = await fetch(`${h.url}/api/v1/resources`, authed());
        expect(resources.status).toBe(200);
        expect(((await resources.json()) as { totalRssBytes: number }).totalRssBytes).toBe(1000);

        const diagnostics = await fetch(`${h.url}/api/v1/diagnostics`, authed());
        expect(diagnostics.status).toBe(200);
        const body = (await diagnostics.json()) as { instances: unknown[]; connections: number };
        expect(body.instances).toHaveLength(1);
        expect(body.connections).toBe(0);
    });

    it("lists and revokes devices", async () => {
        const list = await fetch(`${h.url}/api/v1/devices`, authed());
        expect(list.status).toBe(200);
        const devices = (await list.json()) as { id: string; tokenHash?: string }[];
        expect(devices).toHaveLength(1);
        expect(devices[0]!.tokenHash).toBeUndefined();

        const revoked = await fetch(`${h.url}/api/v1/devices/${devices[0]!.id}`, authed({ method: "DELETE" }));
        expect(revoked.status).toBe(204);
        expect(h.auth.verifyToken(token)).toBeNull();
    });

    it("redeems a pairing code over HTTP", async () => {
        const pair = h.auth.pairCreate();
        const res = await fetch(`${h.url}/api/v1/pair`, {
            method: "POST",
            body: JSON.stringify({ code: pair.code, deviceName: "Pixel", kind: "phone" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { token: string; device: { name: string } };
        expect(body.device.name).toBe("Pixel");
        expect(h.auth.verifyToken(body.token)?.name).toBe("Pixel");

        const replay = await fetch(`${h.url}/api/v1/pair`, {
            method: "POST",
            body: JSON.stringify({ code: pair.code, deviceName: "Pixel", kind: "phone" }),
        });
        expect(replay.status).toBe(401);
    });

    it("creates a pairing code for an authenticated client", async () => {
        const res = await fetch(`${h.url}/api/v1/pair`, authed({ method: "POST", body: "{}" }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as { code: string; url: string; expiresAt: number };
        expect(body.code).toMatch(/^[A-Z0-9]{8}$/);
        expect(body.url).toContain(body.code);
        expect(body.expiresAt).toBeGreaterThan(Date.now());
    });
});
