import { readFileSync, statSync } from "node:fs";
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { daemonSocketPath, daemonTokenPath } from "../../src/core/paths.js";
import { parseHello, PluginServer, type PluginServerOptions } from "../../src/instances/plugin-server.js";
import type { PluginHello } from "../../src/instances/connection.js";
import {
    FakeBus,
    PluginClient,
    delay,
    makeHello,
    makeTempEnv,
    waitFor,
    type TempEnv,
} from "./helpers.js";

function asRecord(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

describe("PluginServer", () => {
    let env: TempEnv;
    let bus: FakeBus;
    let servers: PluginServer[];

    beforeEach(() => {
        env = makeTempEnv();
        bus = new FakeBus();
        servers = [];
    });

    afterEach(async () => {
        for (const server of servers.splice(0)) await server.close();
        env.cleanup();
    });

    async function start(options: Partial<PluginServerOptions> = {}): Promise<PluginServer> {
        const server = new PluginServer({ bus, daemonId: "d-test", ...options });
        await server.start();
        servers.push(server);
        return server;
    }

    async function connect(overrides: Record<string, unknown> = {}): Promise<PluginClient> {
        return PluginClient.connect({ socketPath: daemonSocketPath(), hello: makeHello(overrides) });
    }

    it("writes a 32-byte hex token with mode 0600 before accepting connections", async () => {
        const server = await start();
        const token = readFileSync(daemonTokenPath(), "utf8").trim();

        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(token).toBe(server.token);
        expect(statSync(daemonTokenPath()).mode & 0o777).toBe(0o600);
        expect(statSync(server.path).mode & 0o777).toBe(0o600);
    });

    it("accepts a valid hello and replies with hello_ack limits and policy", async () => {
        const server = await start({ daemonId: "d-test", policy: { attention: "all" } });
        const client = await connect();
        const ack = await client.next("hello_ack");

        expect(ack.v).toBe(1);
        expect(ack.type).toBe("hello_ack");
        expect(ack.daemonId).toBe("d-test");
        expect(asRecord(ack.limits).maxFrameBytes).toBe(8 * 1024 * 1024);
        expect(asRecord(ack.policy).attention).toBe("all");
        expect(ack.rejected).toBeUndefined();
        expect(server.connectionCount).toBe(1);
        expect(server.connection("ws-test")?.instanceId).toBe("i-test-1");
        expect(client.isClosed).toBe(false);

        await waitFor(() =>
            bus.published.find(
                (record) =>
                    record.type === "instance_state" && asRecord(record.payload).status === "ready",
            ),
        );
        client.close();
    });

    it("rejects a bad token with E_UNAUTHORIZED and closes the socket", async () => {
        await start();
        const client = await connect({ token: "0".repeat(64) });
        const error = await client.next("error");

        expect(asRecord(error.payload).code).toBe("E_UNAUTHORIZED");
        expect(asRecord(error.payload).retryable).toBe(false);
        await client.waitForClosed();
    });

    it("rejects an unsupported protocol version with E_PROTOCOL_VERSION", async () => {
        await start();
        const client = await connect({ v: 2 });
        const error = await client.next("error");

        expect(asRecord(error.payload).code).toBe("E_PROTOCOL_VERSION");
        await client.waitForClosed();
    });

    it("rejects a hello with missing fields as E_BAD_REQUEST", async () => {
        await start();
        const hello = makeHello();
        delete hello.cwd;
        const client = await PluginClient.connect({ socketPath: daemonSocketPath(), hello });
        const error = await client.next("error");

        expect(asRecord(error.payload).code).toBe("E_BAD_REQUEST");
        await client.waitForClosed();
    });

    it("rejects a first record that is not hello", async () => {
        await start();
        const client = await PluginClient.connect({ socketPath: daemonSocketPath(), hello: false });
        client.send({ v: 1, type: "event", sessionId: "s1", seq: 1 });
        const error = await client.next("error");

        expect(asRecord(error.payload).code).toBe("E_BAD_REQUEST");
        await client.waitForClosed();
    });

    it("rejects malformed JSON", async () => {
        await start();
        const client = await PluginClient.connect({ socketPath: daemonSocketPath(), hello: false });
        client.sendRaw("{not json}\n");
        const error = await client.next("error");

        expect(asRecord(error.payload).code).toBe("E_BAD_REQUEST");
        await client.waitForClosed();
    });

    it("rejects a second instance for an already-managed workspace with E_LEASE", async () => {
        const server = await start();
        const rejected: { hello: PluginHello; code: string; message: string }[] = [];
        server.setHandlers({
            onRejected: (hello, rejection) => rejected.push({ hello, code: rejection.code, message: rejection.message }),
        });

        const first = await connect({ instanceId: "i-first", workspaceId: "ws-1" });
        await first.next("hello_ack");

        const second = await connect({ instanceId: "i-second", workspaceId: "ws-1" });
        const ack = await second.next("hello_ack");

        expect(asRecord(ack.rejected).code).toBe("E_LEASE");
        expect(asRecord(ack.rejected).message).toBe("workspace already managed by i-first");
        await second.waitForClosed();
        expect(server.connectionCount).toBe(1);
        expect(server.connection("ws-1")?.instanceId).toBe("i-first");
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.hello.instanceId).toBe("i-second");
        expect(rejected[0]?.code).toBe("E_LEASE");
        expect(first.isClosed).toBe(false);
        first.close();
    });

    it("accepts a new instance once the previous one disconnected", async () => {
        const server = await start();
        const first = await connect({ instanceId: "i-first", workspaceId: "ws-1" });
        await first.next("hello_ack");
        first.close();
        await first.waitForClosed();
        await waitFor(() => server.connectionCount === 0);

        const second = await connect({ instanceId: "i-second", workspaceId: "ws-1" });
        const ack = await second.next("hello_ack");

        expect(ack.rejected).toBeUndefined();
        expect(server.connection("ws-1")?.instanceId).toBe("i-second");
        second.close();
    });

    it("supports several workspaces at once", async () => {
        const server = await start();
        const one = await connect({ instanceId: "i-1", workspaceId: "ws-1" });
        const two = await connect({ instanceId: "i-2", workspaceId: "ws-2" });
        await one.next("hello_ack");
        await two.next("hello_ack");

        expect(server.connectionCount).toBe(2);
        expect(server.connection("ws-1")?.instanceId).toBe("i-1");
        expect(server.connection("ws-2")?.instanceId).toBe("i-2");
        one.close();
        two.close();
    });

    it("frames on newline only, tolerates CRLF and split writes", async () => {
        const server = await start();
        const client = await PluginClient.connect({ socketPath: daemonSocketPath(), hello: false });
        const hello = `${JSON.stringify(makeHello())}\r\n`;
        client.sendRaw(hello.slice(0, 12));
        await delay(5);
        client.sendRaw(hello.slice(12, 40));
        await delay(5);
        client.sendRaw(hello.slice(40));

        await client.next("hello_ack");
        const connection = server.connection("ws-test");
        expect(connection).toBeDefined();

        const event = JSON.stringify({
            v: 1,
            type: "event",
            sessionId: "s1",
            epoch: "e1",
            seq: 4,
            ts: 123,
            payload: { event: { type: "agent_start", ts: 123 } },
        });
        client.sendRaw(event.slice(0, 25));
        await delay(5);
        client.sendRaw(`${event.slice(25)}\r\n`);

        await waitFor(() => bus.published.find((record) => record.type === "event"));
        const published = bus.published.find((record) => record.type === "event");
        expect(published?.sessionId).toBe("s1");
        expect(published?.seq).toBe(4);
        client.close();
    });

    it("rejects a frame larger than maxFrameBytes with E_PAYLOAD_TOO_LARGE", async () => {
        await start({ maxFrameBytes: 512 });
        const client = await PluginClient.connect({ socketPath: daemonSocketPath(), hello: false });
        client.sendRaw("x".repeat(1024));
        const error = await client.next("error");

        expect(asRecord(error.payload).code).toBe("E_PAYLOAD_TOO_LARGE");
        await client.waitForClosed();
    });

    it("closes sockets that stay quiet past the heartbeat limit", async () => {
        const server = await start({ heartbeatMs: 120, heartbeatCheckMs: 10 });
        const client = await connect({ instanceId: "i-hb", workspaceId: "ws-hb" });
        await client.next("hello_ack");

        await client.waitForClosed(3_000);
        await waitFor(() => server.connectionCount === 0);
    });

    it("keeps sockets alive while any record arrives", async () => {
        const server = await start({ heartbeatMs: 120, heartbeatCheckMs: 10 });
        const client = await connect({ instanceId: "i-hb", workspaceId: "ws-hb" });
        await client.next("hello_ack");

        const timer = setInterval(() => {
            client.send({ v: 1, type: "instance_state", payload: { status: "ready", sessions: [] } });
        }, 30);
        await delay(400);
        expect(client.isClosed).toBe(false);
        expect(server.connectionCount).toBe(1);

        clearInterval(timer);
        await client.waitForClosed(3_000);
    });

    it("publishes a degraded instance_state when a plugin disconnects", async () => {
        await start();
        const client = await connect({ instanceId: "i-1", workspaceId: "ws-1" });
        await client.next("hello_ack");
        client.close();

        await waitFor(() =>
            bus.published.find(
                (record) =>
                    record.type === "instance_state" &&
                    record.instanceId === "i-1" &&
                    asRecord(record.payload).status === "degraded",
            ),
        );
    });

    it("calls onClose with the disconnect reason", async () => {
        const server = await start();
        const closes: { instanceId: string; reason: string }[] = [];
        server.setHandlers({
            onClose: (connection, reason) => closes.push({ instanceId: connection.instanceId, reason }),
        });
        const client = await connect({ instanceId: "i-1", workspaceId: "ws-1" });
        await client.next("hello_ack");
        client.close();

        await waitFor(() => closes.length === 1);
        expect(closes[0]?.instanceId).toBe("i-1");
        expect(closes[0]?.reason).toBe("socket closed");
    });

    it("stops accepting connections after close()", async () => {
        const server = await start();
        const client = await connect();
        await client.next("hello_ack");
        await server.close();
        await client.waitForClosed();

        await expect(
            PluginClient.connect({ socketPath: daemonSocketPath(), hello: makeHello() }),
        ).rejects.toThrow();
    });
});

describe("parseHello", () => {
    const baseHello: Record<string, unknown> = {
        v: 1,
        type: "hello",
        token: "a".repeat(64),
        instanceId: "i-test-1",
        workspaceId: "ws-test",
        cwd: "/repo/ws-test",
        pid: 42,
        hasUI: false,
        listenAddr: "/tmp/i-test.sock",
        pluginVersion: "1.8.0",
    };

    it("normalizes optional fields", () => {
        const hello = parseHello({ ...baseHello, listenAddr: "" });
        expect(hello).toMatchObject({
            instanceId: "i-test-1",
            workspaceId: "ws-test",
            hasUI: false,
            listenAddr: null,
            pluginVersion: "1.8.0",
        });
    });

    it("rejects invalid pids and missing required fields", () => {
        expect(parseHello({ ...baseHello, pid: -1 })).toBeUndefined();
        expect(parseHello({ ...baseHello, hasUI: "yes" })).toBeUndefined();
        expect(parseHello({ ...baseHello, pluginVersion: "" })).toBeUndefined();
        expect(parseHello({ ...baseHello, instanceId: "" })).toBeUndefined();
    });
});
