import type { Socket } from "node:net";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { daemonSocketPath } from "../../src/core/paths.js";
import { PluginSocketConnection } from "../../src/instances/connection.js";
import { PluginServer } from "../../src/instances/plugin-server.js";
import { makeSessionState } from "../daemon/fakes.js";
import { FakeBus, PluginClient, delay, makeTempEnv, waitFor, type TempEnv } from "./helpers.js";

function asRecord(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

describe("PluginSocketConnection", () => {
    let env: TempEnv;
    let bus: FakeBus;
    let server: PluginServer;
    let client: PluginClient;
    let connection: PluginSocketConnection;

    beforeEach(async () => {
        env = makeTempEnv();
        bus = new FakeBus();
        server = new PluginServer({ bus, daemonId: "d-test" });
        await server.start();
        client = await PluginClient.connect({ socketPath: daemonSocketPath() });
        await client.next("hello_ack");
        const established = server.connection("ws-test");
        if (!established) throw new Error("connection was not established");
        connection = established;
    });

    afterEach(async () => {
        client.close();
        await server.close();
        env.cleanup();
    });

    it("sends records as JSONL to the plugin", async () => {
        connection.send({ type: "instance_state", payload: { status: "ready", sessions: [] } });
        const record = await client.next("instance_state");

        expect(record.v).toBe(1);
        expect(asRecord(record.payload).status).toBe("ready");
        expect(client.rawLines).toHaveLength(2); // hello_ack + record
    });

    it("correlates acks by id even when they arrive out of order", async () => {
        client.onRecord((record) => {
            if (record.type !== "cmd") return;
            const id = String(record.id);
            const seq = id === "req-alpha" ? 2 : 1;
            setTimeout(
                () => client.send({ v: 1, type: "ack", id, seq, payload: { disposition: "started" } }),
                id === "req-alpha" ? 80 : 5,
            );
        });

        const alpha = connection.command({ id: "req-alpha", sessionId: "s1", method: "alpha" });
        const beta = connection.command({ id: "req-beta", sessionId: "s1", method: "beta" });

        expect(await beta).toEqual({ seq: 1, disposition: "started" });
        expect(await alpha).toEqual({ seq: 2, disposition: "started" });

        const cmd = await client.next("cmd", (record) => String(record.id) === "req-alpha");
        expect(asRecord(cmd.payload).method).toBe("alpha");
        expect(cmd.sessionId).toBe("s1");
    });

    it("rejects with the plugin error code and message", async () => {
        client.onRecord((record) => {
            if (record.type !== "cmd") return;
            client.send({
                v: 1,
                type: "error",
                id: record.id,
                payload: { code: "E_LEASE", message: "session is owned by instance i-2", retryable: false },
            });
        });

        await expect(connection.command({ id: "req-err", method: "prompt.send" })).rejects.toMatchObject({
            code: "E_LEASE",
            message: "session is owned by instance i-2",
            retryable: false,
        });
    });

    it("times out commands and ignores a late ack", async () => {
        const started = Date.now();
        await expect(connection.command({ id: "req-slow", method: "slow" }, 60)).rejects.toMatchObject({
            code: "E_TIMEOUT",
        });
        expect(Date.now() - started).toBeGreaterThanOrEqual(50);
        expect(connection.pendingCommands).toBe(0);

        // A late ack must not resolve anything or throw.
        client.send({ v: 1, type: "ack", id: "req-slow", seq: 3, payload: { disposition: "started" } });
        await delay(20);
        expect(connection.pendingCommands).toBe(0);
    });

    it("sends subscription records", async () => {
        connection.subscribe("s1");
        connection.unsubscribe("s1");

        const subscribe = await client.next("sub.subscribe");
        const unsubscribe = await client.next("sub.unsubscribe");
        expect(subscribe.sessionId).toBe("s1");
        expect(unsubscribe.sessionId).toBe("s1");
    });

    it("caches snapshots and invalidates them on epoch change", async () => {
        const state = makeSessionState("s1", "ws-test");
        client.send({
            v: 1,
            type: "snapshot",
            sessionId: "s1",
            epoch: "e1",
            seq: 10,
            payload: { state },
        });
        await waitFor(() => connection.snapshot("s1") !== undefined);

        expect(connection.snapshot("s1")?.sessionId).toBe("s1");
        expect(connection.lastSeq("s1")).toBe(10);

        const renamed = { ...state, name: "Renamed" };
        client.send({
            v: 1,
            type: "snapshot",
            sessionId: "s1",
            epoch: "e1",
            seq: 12,
            payload: { state: renamed },
        });
        await waitFor(() => connection.snapshot("s1")?.name === "Renamed");
        expect(connection.lastSeq("s1")).toBe(12);

        const recreated = { ...state, name: "After restart" };
        client.send({
            v: 1,
            type: "snapshot",
            sessionId: "s1",
            epoch: "e2",
            seq: 1,
            payload: { state: recreated },
        });
        await waitFor(() => connection.snapshot("s1")?.name === "After restart");
        expect(connection.snapshotEntry("s1")?.epoch).toBe("e2");
        // seq is only valid inside an epoch
        expect(connection.lastSeq("s1")).toBe(1);
    });

    it("does not invent snapshots the plugin never sent", () => {
        expect(connection.snapshot("missing")).toBeUndefined();
        expect(connection.lastSeq("missing")).toBe(0);
    });

    it("relays events onto the bus with the plugin envelope", async () => {
        client.send({
            v: 1,
            type: "event",
            sessionId: "s1",
            epoch: "e1",
            seq: 7,
            ts: 1733234400123,
            mono: 918273,
            payload: { event: { type: "agent_start", ts: 1733234400123 } },
        });

        const published = await waitFor(() => bus.published.find((record) => record.type === "event"));
        expect(published.v).toBe(1);
        expect(published.workspaceId).toBe("ws-test");
        expect(published.sessionId).toBe("s1");
        expect(published.epoch).toBe("e1");
        expect(published.seq).toBe(7);
        expect(published.ts).toBe(1733234400123);
        expect(asRecord(published.payload).event).toMatchObject({ type: "agent_start" });
        expect(connection.lastSeq("s1")).toBe(7);
        expect(connection.hasSession("s1")).toBe(true);
    });

    it("tracks sessions reported by instance_state", async () => {
        client.send({
            v: 1,
            type: "instance_state",
            payload: {
                status: "ready",
                sessions: [{ sessionId: "s1", status: "busy" }, { sessionId: "s2" }],
            },
        });
        await waitFor(() => connection.sessionIds().length === 2);
        expect(connection.sessionIds().sort()).toEqual(["s1", "s2"]);

        client.send({ v: 1, type: "instance_state", payload: { sessions: ["s3"] } });
        await waitFor(() => connection.hasSession("s3"));
    });

    it("fails in-flight commands when the socket closes", async () => {
        const pending = connection.command({ id: "req-pending", method: "never" }, 5_000);
        connection.close("test shutdown");

        await expect(pending).rejects.toMatchObject({ code: "E_INSTANCE_UNAVAILABLE" });
        await connection.closedPromise;
        expect(connection.isClosed).toBe(true);
        expect(connection.closeReason).toBe("test shutdown");
        await client.waitForClosed();
        await waitFor(() => server.connectionCount === 0);
    });

    it("treats a plugin bye as a close", async () => {
        client.send({ v: 1, type: "bye" });
        await connection.closedPromise;
        expect(connection.isClosed).toBe(true);
        expect(connection.closeReason).toBe("plugin said bye");
    });

    it("rejects commands once closed", async () => {
        connection.close("done");
        await connection.closedPromise;
        await expect(connection.command({ id: "req-late", method: "x" })).rejects.toMatchObject({
            code: "E_INSTANCE_UNAVAILABLE",
        });
    });

});

describe("PluginSocketConnection write-queue cap", () => {
    it("drops events and emits one dropped marker when the queue is full", () => {
        const state = { queued: 0, destroyed: false };
        const writes: string[] = [];
        const socket = {
            get writableLength() {
                return state.queued;
            },
            get destroyed() {
                return state.destroyed;
            },
            write(line: string) {
                writes.push(line);
                state.queued += Buffer.byteLength(line, "utf8");
            },
            end() {
                state.destroyed = true;
            },
            destroy() {
                state.destroyed = true;
            },
        } as unknown as Socket;
        const bus = new FakeBus();
        const connection = new PluginSocketConnection({
            socket,
            hello: {
                instanceId: "i-1",
                workspaceId: "ws-1",
                cwd: "/repo",
                pid: 42,
                hasUI: false,
                listenAddr: null,
                pluginVersion: "1.0.0",
            },
            bus,
            maxWriteQueueBytes: 100,
        });

        connection.send({
            type: "event",
            sessionId: "s1",
            seq: 1,
            payload: { event: { type: "text_delta", delta: "x".repeat(200) } },
        });
        connection.send({
            type: "event",
            sessionId: "s1",
            seq: 2,
            payload: { event: { type: "text_delta", delta: "y".repeat(200) } },
        });

        expect(writes).toHaveLength(0);
        expect(connection.droppedCount).toBe(2);
        expect(bus.published.filter((record) => record.type === "dropped")).toHaveLength(1);
    });

    it("closes the connection rather than dropping a control record", () => {
        const writes: string[] = [];
        const state = { destroyed: false };
        const socket = {
            writableLength: 1_000,
            get destroyed() {
                return state.destroyed;
            },
            write(line: string) {
                writes.push(line);
            },
            end() {
                state.destroyed = true;
            },
            destroy() {
                state.destroyed = true;
            },
        } as unknown as Socket;
        const connection = new PluginSocketConnection({
            socket,
            hello: {
                instanceId: "i-1",
                workspaceId: "ws-1",
                cwd: "/repo",
                pid: 42,
                hasUI: false,
                listenAddr: null,
                pluginVersion: "1.0.0",
            },
            bus: new FakeBus(),
            maxWriteQueueBytes: 100,
        });

        connection.send({ type: "cmd", id: "req-1", payload: { method: "prompt.send" } });

        expect(writes).toHaveLength(0);
        expect(connection.closeReason).toBe("write queue overflow");
        expect(state.destroyed).toBe(true);
    });
});
