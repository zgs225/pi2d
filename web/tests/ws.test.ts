import { afterEach, describe, expect, it, vi } from "vitest";

import { PiWsClient, type WebSocketLike, type WsFrame } from "@/lib/ws";

class FakeSocket implements WebSocketLike {
    readyState = 0;
    sent: WsFrame[] = [];
    closed = false;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;

    send(data: string): void {
        this.sent.push(JSON.parse(data) as WsFrame);
    }

    close(): void {
        this.closed = true;
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: "closed" });
    }

    open(): void {
        this.readyState = 1;
        this.onopen?.({});
    }

    receive(frame: Record<string, unknown>): void {
        this.onmessage?.({ data: JSON.stringify(frame) });
    }

    serverClose(code = 1006): void {
        this.readyState = 3;
        this.onclose?.({ code });
    }

    frames(type: string): WsFrame[] {
        return this.sent.filter((frame) => frame.type === type);
    }
}

function createClient(token = "pkt_test") {
    const sockets: FakeSocket[] = [];
    const states: string[] = [];
    const snapshots: unknown[] = [];
    const events: unknown[] = [];
    const client = new PiWsClient({
        url: "ws://127.0.0.1:7676/api/v1/ws",
        token,
        heartbeatMs: 0,
        socketFactory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        handlers: {
            onState: (state) => states.push(state),
            onSnapshot: (snapshot) => snapshots.push(snapshot),
            onEvent: (event) => events.push(event),
        },
    });
    return { client, sockets, states, snapshots, events };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("PiWsClient", () => {
    it("sends the auth frame first, then flushes subscriptions on hello_ack", () => {
        vi.useFakeTimers();
        const { client, sockets, states } = createClient();
        client.connect();
        expect(sockets).toHaveLength(1);
        expect(states).toEqual(["connecting"]);

        const socket = sockets[0]!;
        socket.open();
        expect(states).toEqual(["connecting", "authenticating"]);
        expect(socket.sent[0]).toEqual({ v: 1, type: "auth", token: "pkt_test" });

        // Queued before authentication.
        client.subscribe("s1");
        expect(socket.frames("subscribe")).toHaveLength(0);

        socket.receive({ v: 1, type: "hello_ack" });
        expect(client.getState()).toBe("open");
        expect(socket.frames("subscribe")).toEqual([
            { v: 1, type: "subscribe", payload: { sessionIds: ["s1"] } },
        ]);
    });

    it("reconnects with exponential backoff and resumes with sinceSeq", () => {
        vi.useFakeTimers();
        const { client, sockets, states, snapshots } = createClient();
        client.connect();
        sockets[0]!.open();
        sockets[0]!.receive({ type: "hello_ack" });
        client.subscribe(["s1"]);
        sockets[0]!.receive({ type: "snapshot", sessionId: "s1", epoch: "e1", seq: 10, payload: { ok: true } });
        expect(client.getLastSeq("s1")).toBe(10);
        expect(snapshots).toHaveLength(1);

        sockets[0]!.serverClose(1006);
        expect(client.getState()).toBe("reconnecting");

        vi.advanceTimersByTime(199);
        expect(sockets).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(sockets).toHaveLength(2);

        sockets[1]!.open();
        expect(sockets[1]!.sent[0]?.type).toBe("auth");
        sockets[1]!.receive({ type: "hello_ack" });
        expect(client.getState()).toBe("open");
        expect(sockets[1]!.frames("subscribe")).toEqual([
            { v: 1, type: "subscribe", payload: { sessionIds: ["s1"], sinceSeq: { s1: 10 } } },
        ]);

        // A successful hello_ack resets the backoff, so the next retry is 200ms again.
        sockets[1]!.serverClose(1006);
        vi.advanceTimersByTime(199);
        expect(sockets).toHaveLength(2);
        vi.advanceTimersByTime(1);
        expect(sockets).toHaveLength(3);
        expect(states).toContain("authenticating");
    });

    it("tracks event seq and ignores duplicates", () => {
        vi.useFakeTimers();
        const { client, sockets, events } = createClient();
        client.connect();
        sockets[0]!.open();
        sockets[0]!.receive({ type: "hello_ack" });
        client.subscribe("s1");
        sockets[0]!.receive({ type: "snapshot", sessionId: "s1", seq: 4, payload: {} });
        sockets[0]!.receive({ type: "event", sessionId: "s1", seq: 5, payload: { kind: "a" } });
        sockets[0]!.receive({ type: "event", sessionId: "s1", seq: 5, payload: { kind: "duplicate" } });
        sockets[0]!.receive({ type: "event", sessionId: "s1", seq: 6, payload: { kind: "b" } });
        expect(client.getLastSeq("s1")).toBe(6);
        expect(events).toHaveLength(2);
    });

    it("clears the resume cursor on resync_required", () => {
        vi.useFakeTimers();
        const { client, sockets } = createClient();
        client.connect();
        sockets[0]!.open();
        sockets[0]!.receive({ type: "hello_ack" });
        client.subscribe("s1");
        sockets[0]!.receive({ type: "snapshot", sessionId: "s1", epoch: "e1", seq: 10, payload: {} });
        sockets[0]!.receive({ type: "resync_required", sessionId: "s1" });
        expect(client.getLastSeq("s1")).toBeUndefined();
        expect(client.getEpoch("s1")).toBeUndefined();
    });

    it("stops reconnecting after close()", () => {
        vi.useFakeTimers();
        const { client, sockets } = createClient();
        client.connect();
        sockets[0]!.open();
        sockets[0]!.receive({ type: "hello_ack" });
        client.close();
        expect(client.getState()).toBe("closed");
        expect(sockets[0]!.closed).toBe(true);
        vi.advanceTimersByTime(10_000);
        expect(sockets).toHaveLength(1);
    });

    it("caps backoff at maxBackoffMs", () => {
        vi.useFakeTimers();
        const sockets: FakeSocket[] = [];
        const client = new PiWsClient({
            url: "ws://x",
            token: "t",
            heartbeatMs: 0,
            initialBackoffMs: 200,
            maxBackoffMs: 500,
            socketFactory: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
        });
        client.connect();
        // Fail four times without authenticating.
        for (let i = 0; i < 4; i += 1) {
            sockets[i]!.serverClose(1006);
            vi.advanceTimersByTime(500);
        }
        expect(sockets.length).toBe(5);
    });
});
