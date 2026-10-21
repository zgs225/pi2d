import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { makeSessionState, makeWorkspaceInfo } from "./fakes.js";
import { createHarness, type Harness } from "./harness.js";

type Record0 = Record<string, unknown> & { type?: string };

class WsClient {
    readonly messages: Record0[] = [];
    private waiters: {
        predicate: (message: Record0) => boolean;
        resolve: (message: Record0) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
    }[] = [];

    constructor(readonly ws: WebSocket) {
        ws.on("message", (data) => {
            const message = JSON.parse(data.toString()) as Record0;
            const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
            if (index >= 0) {
                const [waiter] = this.waiters.splice(index, 1);
                clearTimeout(waiter!.timer);
                waiter!.resolve(message);
                return;
            }
            this.messages.push(message);
        });
    }

    send(message: Record<string, unknown>): void {
        this.ws.send(JSON.stringify(message));
    }

    next(predicate: (message: Record0) => boolean = () => true, timeoutMs = 2000): Promise<Record0> {
        const index = this.messages.findIndex(predicate);
        if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.findIndex((waiter) => waiter.timer === timer);
                if (idx >= 0) this.waiters.splice(idx, 1);
                reject(new Error(`timeout waiting for WS message; buffered=${JSON.stringify(this.messages)}`));
            }, timeoutMs);
            this.waiters.push({ predicate, resolve, reject, timer });
        });
    }

    async expectSilence(ms = 200): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
        expect(this.messages).toEqual([]);
    }

    async close(): Promise<void> {
        if (this.ws.readyState === WebSocket.CLOSED) return;
        this.ws.close();
        await once(this.ws, "close");
    }
}

function openWs(url: string, headers?: Record<string, string>): Promise<WsClient> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, headers ? { headers } : undefined);
        const client = new WsClient(ws);
        ws.once("open", () => resolve(client));
        ws.once("error", reject);
        ws.once("unexpected-response", (_request, response) => {
            reject(Object.assign(new Error("unexpected upgrade response"), { statusCode: response.statusCode }));
        });
    });
}

async function authedClient(url: string, token: string): Promise<WsClient> {
    const client = await openWs(url);
    client.send({ type: "auth", token });
    const hello = await client.next((message) => message.type === "hello_ack");
    expect(hello.type).toBe("hello_ack");
    return client;
}

describe("WebSocket surface", () => {
    let h: Harness;
    let token: string;

    afterEach(async () => {
        if (h) await h.cleanup();
    });

    async function setup(configOptions: Parameters<typeof createHarness>[0] = {}): Promise<void> {
        h = await createHarness({
            workspaces: [makeWorkspaceInfo("ws-1")],
            seedInstances: ["ws-1"],
            ...configOptions,
        });
        token = h.createToken();
        h.instances.sessionOwners.set("s1", "ws-1");
        h.instances.sessionOwners.set("s2", "ws-1");
    }

    it("requires auth as the first message", async () => {
        await setup();
        const client = await openWs(h.wsUrl);
        client.send({ type: "subscribe", payload: { sessionIds: ["s1"] } });

        const error = await client.next((message) => message.type === "error");
        expect(error.type).toBe("error");
        expect((error.payload as { code: string }).code).toBe("E_UNAUTHORIZED");
        await once(client.ws, "close");
        expect(client.ws.readyState).toBe(WebSocket.CLOSED);
    });

    it("accepts a first-message auth and returns hello_ack", async () => {
        await setup();
        const client = await authedClient(h.wsUrl, token);
        const hello = client.messages.find((message) => message.type === "hello_ack");
        expect(hello).toBeUndefined();
        await client.close();
    });

    it("accepts a bearer token in the upgrade header", async () => {
        await setup();
        const client = await openWs(h.wsUrl, { Authorization: `Bearer ${token}` });
        const hello = await client.next((message) => message.type === "hello_ack");
        expect(hello.daemonId).toBe("d-test");
        expect((hello.limits as { maxFrameBytes: number }).maxFrameBytes).toBe(8 * 1024 * 1024);
        expect((hello.device as { name: string }).name).toBe("test laptop");
        await client.close();
    });

    it("rejects an unknown origin during upgrade", async () => {
        await setup();
        await expect(openWs(h.wsUrl, { Origin: "http://evil.test" })).rejects.toMatchObject({ statusCode: 403 });
    });

    it("rejects an invalid token", async () => {
        await setup();
        const client = await openWs(h.wsUrl);
        client.send({ type: "auth", token: "nope" });
        const error = await client.next((message) => message.type === "error");
        expect((error.payload as { code: string }).code).toBe("E_UNAUTHORIZED");
        await once(client.ws, "close");
    });

    it("subscribes, ensures the instance and sends a snapshot", async () => {
        await setup();
        const conn = h.instances.get("ws-1")!;
        conn.snapshots.set("s1", makeSessionState("s1", "ws-1"));
        conn.seqs.set("s1", 7);

        const client = await authedClient(h.wsUrl, token);
        client.send({ type: "subscribe", payload: { sessionIds: ["s1"] } });

        const snapshot = await client.next((message) => message.type === "snapshot");
        expect(snapshot.sessionId).toBe("s1");
        expect(snapshot.epoch).toBe("i-ws-1");
        expect(snapshot.seq).toBe(7);
        expect((snapshot.payload as { state: { sessionId: string } }).state.sessionId).toBe("s1");

        expect(h.instances.ensureCalls).toContain("ws-1");
        expect(conn.subscribed.has("s1")).toBe(true);
        await client.close();
    });

    it("sends resync_required when epoch or seq do not match", async () => {
        await setup();
        const conn = h.instances.get("ws-1")!;
        conn.snapshots.set("s1", makeSessionState("s1", "ws-1"));
        conn.seqs.set("s1", 7);

        const client = await authedClient(h.wsUrl, token);
        client.send({ type: "subscribe", payload: { sessionIds: ["s1"], since: { sessionId: "s1", epoch: "old-epoch", seq: 7 } } });
        const epochMismatch = await client.next((message) => message.type === "resync_required");
        expect(epochMismatch.sessionId).toBe("s1");

        client.send({ type: "subscribe", payload: { sessionIds: ["s1"], since: { sessionId: "s1", epoch: "i-ws-1", seq: 99 } } });
        const seqMismatch = await client.next((message) => message.type === "resync_required");
        expect(seqMismatch.sessionId).toBe("s1");

        client.send({ type: "subscribe", payload: { sessionIds: ["s1"], since: { sessionId: "s1", epoch: "i-ws-1", seq: 7 } } });
        const snapshot = await client.next((message) => message.type === "snapshot");
        expect(snapshot.seq).toBe(7);
        await client.close();
    });

    it("fans records out only to subscribers", async () => {
        await setup();
        const conn = h.instances.get("ws-1")!;
        conn.snapshots.set("s1", makeSessionState("s1", "ws-1"));
        conn.snapshots.set("s2", makeSessionState("s2", "ws-1"));

        const first = await authedClient(h.wsUrl, token);
        first.send({ type: "subscribe", payload: { sessionIds: ["s1"] } });
        await first.next((message) => message.type === "snapshot");

        const second = await authedClient(h.wsUrl, token);
        second.send({ type: "subscribe", payload: { sessionIds: ["s2"] } });
        await second.next((message) => message.type === "snapshot");

        h.bus.publish({
            v: 1,
            type: "event",
            workspaceId: "ws-1",
            sessionId: "s1",
            epoch: "i-ws-1",
            seq: 8,
            ts: 1,
            payload: { event: { type: "agent_start", ts: 1 } },
        });

        const event = await first.next((message) => message.type === "event");
        expect(event.sessionId).toBe("s1");
        await second.expectSilence();

        await first.close();
        await second.close();
    });

    it("delivers workspace-scoped records", async () => {
        await setup();
        const client = await authedClient(h.wsUrl, token);
        client.send({ type: "subscribe", payload: { workspaceId: "ws-1" } });
        await new Promise((resolve) => setTimeout(resolve, 50));

        h.bus.publish({ v: 1, type: "event", workspaceId: "ws-1", sessionId: "s9", epoch: "i-ws-1", seq: 1, payload: {} });
        const event = await client.next((message) => message.type === "event");
        expect(event.sessionId).toBe("s9");
        await client.close();
    });

    it("stops delivering after unsubscribe", async () => {
        await setup();
        const conn = h.instances.get("ws-1")!;
        conn.snapshots.set("s1", makeSessionState("s1", "ws-1"));
        const client = await authedClient(h.wsUrl, token);
        client.send({ type: "subscribe", payload: { sessionIds: ["s1"] } });
        await client.next((message) => message.type === "snapshot");

        client.send({ type: "unsubscribe", payload: { sessionIds: ["s1"] } });
        await new Promise((resolve) => setTimeout(resolve, 50));
        h.bus.publish({ v: 1, type: "event", workspaceId: "ws-1", sessionId: "s1", epoch: "i-ws-1", seq: 8, payload: {} });
        await client.expectSilence();
        await client.close();
    });

    it("drops records over the buffer cap and emits one dropped marker", async () => {
        await setup({
            wsOverrides: {
                maxBufferedBytes: 5,
                closeBufferedBytes: 1_000_000,
                measureBufferedAmount: () => 10,
            },
        });
        const client = await authedClient(h.wsUrl, token);
        client.send({ type: "subscribe", payload: { sessionIds: ["s1"] } });
        await new Promise((resolve) => setTimeout(resolve, 50));

        h.bus.publish({ v: 1, type: "event", workspaceId: "ws-1", sessionId: "s1", epoch: "i-ws-1", seq: 1, payload: {} });
        const dropped = await client.next((message) => message.type === "dropped");
        expect(dropped.type).toBe("dropped");

        h.bus.publish({ v: 1, type: "event", workspaceId: "ws-1", sessionId: "s1", epoch: "i-ws-1", seq: 2, payload: {} });
        await client.expectSilence();
        await client.close();
    });

    it("closes a socket that exceeds the hard buffer limit", async () => {
        await setup({
            wsOverrides: {
                maxBufferedBytes: 5,
                closeBufferedBytes: 100,
                measureBufferedAmount: () => 200,
            },
        });
        const client = await authedClient(h.wsUrl, token);
        client.send({ type: "subscribe", payload: { sessionIds: ["s1"] } });
        await new Promise((resolve) => setTimeout(resolve, 50));

        h.bus.publish({ v: 1, type: "event", workspaceId: "ws-1", sessionId: "s1", epoch: "i-ws-1", seq: 1, payload: {} });
        const [code] = (await once(client.ws, "close")) as [number];
        expect(code).toBe(1013);
    });

    it("answers ping with pong", async () => {
        await setup();
        const client = await authedClient(h.wsUrl, token);
        client.send({ type: "ping" });
        const pong = await client.next((message) => message.type === "pong");
        expect(pong.type).toBe("pong");
        await client.close();
    });

    it("sends heartbeat pings", async () => {
        await setup({ heartbeatMs: 25 });
        const client = await authedClient(h.wsUrl, token);
        await once(client.ws, "ping");
        await client.close();
    });
});
