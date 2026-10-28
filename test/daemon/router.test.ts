import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../../src/daemon/auth.js";
import { DaemonError } from "../../src/daemon/errors.js";
import { CommandRouter } from "../../src/daemon/router.js";
import { ERROR_CODES } from "../../src/protocol/errors.js";
import { FakeInstanceManager, FakeWorkspaceStore, makeWorkspaceInfo } from "./fakes.js";

describe("CommandRouter", () => {
    let dir: string;
    let auth: AuthStore;
    let instances: FakeInstanceManager;
    let workspaces: FakeWorkspaceStore;
    let router: CommandRouter;
    let now: number;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pi2-router-"));
        auth = new AuthStore({ path: join(dir, "devices.json") });
        instances = new FakeInstanceManager();
        workspaces = new FakeWorkspaceStore([makeWorkspaceInfo("ws-1")]);
        instances.addWorkspace("ws-1");
        instances.sessionOwners.set("s1", "ws-1");
        now = 1_700_000_000_000;
        router = new CommandRouter({ auth, instances, workspaces, now: () => now, daemonId: "d-test" });
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("dedupes clientRequestId for five minutes", async () => {
        const conn = instances.get("ws-1")!;
        const request = { method: "prompt.send", sessionId: "s1", clientRequestId: "c-1" };

        const first = await router.dispatch(request);
        expect(first.status).toBe(202);
        expect(first.body.accepted).toBe(true);
        expect(first.body.disposition).toBe("started");

        const replay = await router.dispatch(request);
        expect(replay).toEqual(first);
        expect(conn.commands).toHaveLength(1);

        now += 5 * 60 * 1000 - 1;
        await router.dispatch(request);
        expect(conn.commands).toHaveLength(1);

        now += 1;
        await router.dispatch(request);
        expect(conn.commands).toHaveLength(2);
    });

    it("does not collide clientRequestIds across methods", async () => {
        const conn = instances.get("ws-1")!;
        await router.dispatch({ method: "prompt.send", sessionId: "s1", clientRequestId: "same" });
        await router.dispatch({ method: "session.rename", sessionId: "s1", clientRequestId: "same" });
        expect(conn.commands.map((call) => call.method)).toEqual(["prompt.send", "session.rename"]);
    });

    it("maps known and unknown errors to status and errorBody", async () => {
        const conn = instances.get("ws-1")!;
        conn.commandHandler = async () => {
            throw new DaemonError(ERROR_CODES.LEASE_CONFLICT, "session is owned by instance i-2");
        };
        const lease = await router.dispatch({ method: "prompt.send", sessionId: "s1" });
        expect(lease.status).toBe(409);
        expect(lease.body).toMatchObject({ code: ERROR_CODES.LEASE_CONFLICT, retryable: false });

        conn.commandHandler = async () => {
            throw new Error("boom");
        };
        const internal = await router.dispatch({ method: "prompt.send", sessionId: "s1" });
        expect(internal.status).toBe(500);
        expect(internal.body.code).toBe(ERROR_CODES.INTERNAL);

        const unavailable = new DaemonError(ERROR_CODES.INSTANCE_UNAVAILABLE, "no instance");
        expect(unavailable.status).toBe(503);
        expect(unavailable.retryable).toBe(true);

        const missing = await router.dispatch({ method: "prompt.send", sessionId: "nope" });
        expect(missing.status).toBe(404);
        expect(missing.body.code).toBe(ERROR_CODES.SESSION_NOT_FOUND);

        const noTarget = await router.dispatch({ method: "prompt.send" });
        expect(noTarget.status).toBe(400);
        expect(noTarget.body.code).toBe(ERROR_CODES.BAD_REQUEST);
    });

    it("routes workspace methods to the workspace store", async () => {
        const added = await router.dispatch({ method: "workspace.add", params: { cwd: "/repo/new", alias: "n" } });
        expect(added.status).toBe(202);
        expect(workspaces.addCalls).toEqual([{ cwd: "/repo/new", alias: "n" }]);

        await router.dispatch({ method: "workspace.update", params: { workspaceId: "ws-1", patch: { alias: "x" } } });
        expect(workspaces.updateCalls).toEqual([{ workspaceId: "ws-1", patch: { alias: "x" } }]);

        await router.dispatch({ method: "workspace.remove", params: { workspaceId: "ws-1" } });
        expect(workspaces.removeCalls).toEqual(["ws-1"]);

        await router.dispatch({ method: "workspace.refresh", params: { workspaceId: "ws-1" } });
        expect(workspaces.refreshCalls).toEqual(["ws-1"]);
    });

    it("accepts name as the alias when alias is absent", async () => {
        const added = await router.dispatch({
            method: "workspace.add",
            params: { cwd: "/repo/named", name: "  Named  " },
        });

        expect(added.status).toBe(202);
        expect(workspaces.addCalls).toEqual([{ cwd: "/repo/named", alias: "  Named  " }]);
        // The response carries the id both where the protocol documents it and at
        // the top level (the web client's shortcut).
        expect(added.body).toMatchObject({ accepted: true, workspaceId: "ws-2", workspace: { workspaceId: "ws-2" } });
    });

    it("prefers alias over name and drops a whitespace-only name", async () => {
        await router.dispatch({ method: "workspace.add", params: { cwd: "/repo/both", alias: "A", name: "N" } });
        await router.dispatch({ method: "workspace.add", params: { cwd: "/repo/blank", name: "   " } });

        expect(workspaces.addCalls).toEqual([{ cwd: "/repo/both", alias: "A" }, { cwd: "/repo/blank" }]);
    });

    it("routes instance and system methods to the instance manager", async () => {
        const ensured = await router.dispatch({ method: "instance.ensure", params: { workspaceId: "ws-1" } });
        expect(ensured.status).toBe(202);
        expect(ensured.body.instance).toMatchObject({ workspaceId: "ws-1" });
        expect(instances.ensureCalls).toEqual(["ws-1"]);

        await router.dispatch({ method: "instance.shutdown", params: { workspaceId: "ws-1", mode: "drain" } });
        expect(instances.shutdownCalls).toEqual([{ workspaceId: "ws-1", mode: "drain" }]);

        const doctor = await router.dispatch({ method: "system.doctor" });
        expect(doctor.status).toBe(202);
        expect(doctor.body.instances).toBeTypeOf("object");
    });

    it("routes pairing and device methods to auth", async () => {
        const created = await router.dispatch({ method: "pair.create", params: { ttlSec: 120 } });
        expect(created.status).toBe(202);
        const code = created.body.code as string;
        expect(code).toMatch(/^[A-Z0-9]{8}$/);

        const redeemed = await router.dispatch({
            method: "pair.redeem",
            params: { code, deviceName: "Pixel", kind: "phone" },
        });
        expect(redeemed.status).toBe(202);
        const token = redeemed.body.token as string;
        expect(auth.verifyToken(token)?.name).toBe("Pixel");

        const deviceId = (redeemed.body.device as { id: string }).id;
        const revoked = await router.dispatch({ method: "device.revoke", params: { deviceId } });
        expect(revoked.status).toBe(202);
        expect(auth.verifyToken(token)).toBeNull();
    });

    it("resolves a command without sessionId from params.workspaceId", async () => {
        const conn = instances.get("ws-1")!;
        const result = await router.dispatch({
            method: "session.create",
            params: { workspaceId: "ws-1", cwd: "/repo/ws-1" },
        });
        expect(result.status).toBe(202);
        expect(conn.commands[0]!.params).toEqual({ workspaceId: "ws-1", cwd: "/repo/ws-1" });
    });

    it("does not cache failed commands", async () => {
        const conn = instances.get("ws-1")!;
        let attempts = 0;
        conn.commandHandler = async () => {
            attempts += 1;
            if (attempts === 1) throw new DaemonError(ERROR_CODES.INSTANCE_STARTING, "booting");
            return { seq: 1, disposition: "started" };
        };
        const request = { method: "prompt.send", sessionId: "s1", clientRequestId: "c-retry" };
        const failed = await router.dispatch(request);
        expect(failed.status).toBe(409);
        const retried = await router.dispatch(request);
        expect(retried.status).toBe(202);
        expect(attempts).toBe(2);
    });
});
