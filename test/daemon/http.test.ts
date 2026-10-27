import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as os from "node:os";
import { makeSessionState, makeWorkspaceInfo } from "./fakes.js";
import { createHarness, TEST_LIMITS, type Harness } from "./harness.js";
import { DaemonError } from "../../src/daemon/errors.js";
import { ERROR_CODES } from "../../src/protocol/errors.js";
import { WorkspaceError } from "../../src/workspaces/errors.js";

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
        expect(body.hostname).toBe(os.hostname());
        expect(body.os).toBe(`${os.platform()} ${os.release()}`);
        expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(body.uptimeMs).toBeTypeOf("number");
        expect(body.uptimeMs as number).toBeGreaterThanOrEqual(0);
        expect(body.pid).toBe(process.pid);
        expect(body.port).toBe(h.server.port);

        const health = await fetch(`${h.url}/api/v1/health`);
        expect(health.status).toBe(200);
        const healthBody = (await health.json()) as { ok: boolean; items: { name: string; ok: boolean }[] };
        expect(healthBody.ok).toBe(true);
        expect(healthBody.items.length).toBeGreaterThan(0);
        expect(healthBody.items.every((item) => item.ok)).toBe(true);
    });

    it("reflects degraded instances and missing workspaces in health items", async () => {
        h.instances.states.get("ws-1")!.status = "degraded";
        h.workspaces.workspaces.get("ws-1")!.exists = false;

        const res = await fetch(`${h.url}/api/v1/health`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            ok: boolean;
            items: { name: string; ok: boolean; detail: string }[];
        };
        expect(body.ok).toBe(false);
        expect(body.items.find((item) => item.name === "instances")).toMatchObject({ ok: false });
        expect(body.items.find((item) => item.name === "instances")?.detail).toContain("degraded");
        expect(body.items.find((item) => item.name === "workspaces")).toMatchObject({ ok: false });
        expect(body.items.find((item) => item.name === "workspaces")?.detail).toContain("missing");
        expect(body.items.find((item) => item.name === "auth")?.ok).toBe(true);
    });

    it("stays healthy when some discovered workspaces are ghosts", async () => {
        h.workspaces.workspaces.set("ws-2", makeWorkspaceInfo("ws-2", { exists: false }));

        const res = await fetch(`${h.url}/api/v1/health`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { name: string; ok: boolean; detail: string }[] };
        const workspaces = body.items.find((item) => item.name === "workspaces");
        expect(workspaces?.ok).toBe(true);
        expect(workspaces?.detail).toContain("1 missing");
    });

    it("marks auth unhealthy without a device token or local CLI token", async () => {
        const bare = await createHarness();
        try {
            const res = await fetch(`${bare.url}/api/v1/health`);
            expect(res.status).toBe(200);
            const body = (await res.json()) as { ok: boolean; items: { name: string; ok: boolean; detail: string }[] };
            const authItem = body.items.find((item) => item.name === "auth");
            expect(authItem?.ok).toBe(false);
            expect(authItem?.detail).toContain("0 devices");
        } finally {
            await bare.cleanup();
        }
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

    it("returns 403 E_FORBIDDEN when workspace.add is outside the allowed roots", async () => {
        h.workspaces.add = async () => {
            throw new WorkspaceError(
                ERROR_CODES.FORBIDDEN,
                "workspace path is outside the allowed roots: /etc",
            );
        };
        const res = await fetch(
            `${h.url}/api/v1/cmd`,
            authed({ method: "POST", body: JSON.stringify({ method: "workspace.add", params: { cwd: "/etc" } }) }),
        );
        expect(res.status).toBe(403);
        const body = (await res.json()) as { code: string; retryable: boolean; message: string };
        expect(body.code).toBe(ERROR_CODES.FORBIDDEN);
        expect(body.retryable).toBe(false);
        expect(body.message).toContain("outside the allowed roots");
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
            if (call.method === "workspace.query" && call.params?.kind === "entries") {
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
        const entryCall = conn.commands.find(
            (call) => call.method === "workspace.query" && call.params?.kind === "entries",
        );
        expect(entryCall?.params).toEqual({ before: "e9", limit: 25, kind: "entries" });
        // The routed sid rides on the envelope so the plugin can resolve the
        // session file itself (no `sessionFile` guarantee on the wire).
        expect(entryCall?.sessionId).toBe("s1");
        expect((await entries.json()) as { entries: unknown[] }).toHaveProperty("entries");

        const attention = await fetch(`${h.url}/api/v1/attention?workspaceId=ws-1`, authed());
        expect(attention.status).toBe(200);
        const models = await fetch(`${h.url}/api/v1/models?workspaceId=ws-1`, authed());
        expect(models.status).toBe(200);
        expect(conn.commands.some((call) => call.method === "workspace.query" && call.params?.kind === "models")).toBe(
            true,
        );
    });

    it("routes a disk-only session's entries through workspaceId but keeps the sid", async () => {
        // A row from disk discovery is not owned by the live instance, so the
        // workspace hint is what routes it -- and the sid must survive that.
        h.instances.sessionOwners.delete("s1");
        conn.commandHandler = async () =>
            ({ seq: 1, disposition: "started", entries: [] }) as never;

        const res = await fetch(
            `${h.url}/api/v1/sessions/disk-1/entries?limit=5&workspaceId=ws-1&sessionFile=${encodeURIComponent(
                "/tmp/disk-1.jsonl",
            )}`,
            authed(),
        );
        expect(res.status).toBe(200);
        const call = conn.commands.find(
            (entry) => entry.method === "workspace.query" && entry.params?.kind === "entries",
        );
        expect(call?.sessionId).toBe("disk-1");
        expect(call?.params).toEqual({ limit: 5, sessionFile: "/tmp/disk-1.jsonl", kind: "entries" });
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
        expect(Array.isArray(devices)).toBe(true);
        expect(devices).toHaveLength(1);
        expect(devices[0]!.tokenHash).toBeUndefined();

        const revoked = await fetch(`${h.url}/api/v1/devices/${devices[0]!.id}`, authed({ method: "DELETE" }));
        expect(revoked.status).toBe(204);
        expect(h.auth.verifyToken(token)).toBeNull();
    });

    /** `POST /api/v1/pair/redeem` — the public half of pairing (ADR 0001 §3). */
    async function redeem(code: string, kind = "phone"): Promise<Response> {
        return fetch(`${h.url}/api/v1/pair/redeem`, {
            method: "POST",
            body: JSON.stringify({ code, deviceName: "Pixel", kind }),
        });
    }

    it("redeems a pairing code over the public endpoint, once", async () => {
        const pair = h.auth.pairCreate();
        const res = await redeem(pair.code);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { token: string; device: { name: string; scopes?: unknown } };
        expect(body.device.name).toBe("Pixel");
        expect(body.device.scopes).toBeUndefined();
        expect(h.auth.verifyToken(body.token)?.name).toBe("Pixel");

        expect((await redeem(pair.code)).status).toBe(401);
    });

    it("rate limits repeated redeem attempts", async () => {
        // The default budget is 5/minute per client; the 6th attempt is refused
        // before it can touch the code store.
        for (let attempt = 0; attempt < 5; attempt += 1) {
            expect((await redeem("ZZZZZZZZ")).status).toBe(401);
        }
        const limited = await redeem("ZZZZZZZZ");
        expect(limited.status).toBe(429);
        expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
        const body = (await limited.json()) as { code: string };
        expect(body.code).toBe(ERROR_CODES.RATE_LIMITED);
    });

    it("mints a code, its QR matrix and every usable base for an authenticated client", async () => {
        const res = await fetch(`${h.url}/api/v1/pair`, authed({ method: "POST", body: "{}" }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            code: string;
            url: string;
            expiresAt: number;
            nonce: string;
            qr: { version: number; ecc: string; size: number; rows: string[] } | null;
            bases: { kind: string; name: string; url: string }[];
        };
        expect(body.code).toMatch(/^[A-Z0-9]{8}$/);
        expect(body.url).toContain(`/pair/${body.code}`);
        expect(body.expiresAt).toBeGreaterThan(Date.now());
        expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
        expect(body.qr).not.toBeNull();
        expect(body.qr!.size).toBe(body.qr!.version * 4 + 17);
        expect(body.qr!.rows).toHaveLength(body.qr!.size);
        expect(body.qr!.rows.every((row) => row.length === body.qr!.size && /^[01]+$/.test(row))).toBe(true);
        expect(body.bases.length).toBeGreaterThan(0);
        expect(body.bases.every((base) => typeof base.url === "string" && base.url.startsWith("http"))).toBe(true);
        // The chosen URL is always one of the offered bases.
        expect(body.bases.some((base) => body.url.startsWith(base.url))).toBe(true);
    });

    it("accepts a base it offered and rejects a foreign one", async () => {
        const first = (await (await fetch(`${h.url}/api/v1/pair`, authed({ method: "POST", body: "{}" }))).json()) as {
            bases: { url: string }[];
        };
        const chosen = first.bases.at(-1)!.url;

        const ok = await fetch(
            `${h.url}/api/v1/pair`,
            authed({ method: "POST", body: JSON.stringify({ base: chosen }) }),
        );
        expect(ok.status).toBe(200);
        const minted = (await ok.json()) as { url: string };
        expect(minted.url.startsWith(chosen)).toBe(true);

        const foreign = await fetch(
            `${h.url}/api/v1/pair`,
            authed({ method: "POST", body: JSON.stringify({ base: "http://evil.example:9999" }) }),
        );
        expect(foreign.status).toBe(400);
    });

    it("requires a token to mint a code", async () => {
        const res = await fetch(`${h.url}/api/v1/pair`, { method: "POST", body: "{}" });
        expect(res.status).toBe(401);
    });

    it("redirects a scanned /pair/<code> link to the zero-input connect page", async () => {
        const res = await fetch(`${h.url}/pair/abcd2345`, { redirect: "manual" });
        expect(res.status).toBe(302);
        const location = res.headers.get("location") ?? "";
        expect(location).toContain("/connect?");
        expect(location).toContain("code=ABCD2345");
        expect(location).toContain("auto=1");

        // A malformed code still lands on the console, just without a code.
        const malformed = await fetch(`${h.url}/pair/nope!`, { redirect: "manual" });
        expect(malformed.status).toBe(302);
        expect(malformed.headers.get("location")).not.toContain("code=");
        expect(malformed.headers.get("location")).toContain("auto=1");
    });
});
