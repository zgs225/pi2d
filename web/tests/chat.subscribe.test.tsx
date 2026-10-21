import { afterEach, describe, expect, it, vi } from "vitest";

import { PiWsClient, type WebSocketLike, type WsFrame } from "@/lib/ws";

class FakeSocket implements WebSocketLike {
    readyState = 0;
    sent: WsFrame[] = [];
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;

    send(data: string): void {
        this.sent.push(JSON.parse(data) as WsFrame);
    }

    close(): void {
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

function createClient() {
    const sockets: FakeSocket[] = [];
    const client = new PiWsClient({
        url: "ws://127.0.0.1:7676/api/v1/ws",
        token: "pkt_test",
        heartbeatMs: 0,
        socketFactory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
    });
    return { client, sockets };
}

/** Open + authenticate one socket, returning it. */
function handshake(socket: FakeSocket, client: PiWsClient): void {
    socket.open();
    socket.receive({ v: 1, type: "hello_ack" });
    expect(client.getState()).toBe("open");
}

afterEach(() => {
    vi.useRealTimers();
});

describe("WS resume", () => {
    it("resumes with a per-session `since` cursor instead of `sinceSeq`", () => {
        vi.useFakeTimers();
        const { client, sockets } = createClient();
        client.connect();
        handshake(sockets[0]!, client);

        client.subscribe("s1");
        // No cursor yet: a plain subscribe.
        expect(sockets[0]!.frames("subscribe")).toEqual([
            { v: 1, type: "subscribe", payload: { sessionIds: ["s1"] } },
        ]);

        sockets[0]!.receive({ type: "snapshot", sessionId: "s1", epoch: "e1", seq: 10, payload: {} });
        sockets[0]!.receive({ type: "event", sessionId: "s1", epoch: "e1", seq: 11, payload: {} });

        sockets[0]!.serverClose();
        vi.advanceTimersByTime(200);
        const resumed = sockets[1]!;
        handshake(resumed, client);

        expect(resumed.frames("subscribe")).toEqual([
            {
                v: 1,
                type: "subscribe",
                payload: { sessionIds: ["s1"], since: { sessionId: "s1", epoch: "e1", seq: 11 } },
            },
        ]);
        // No legacy key on the wire.
        expect(resumed.frames("subscribe")[0]?.payload).not.toHaveProperty("sinceSeq");
    });

    it("drops the cached cursor on `resync_required` so the next subscribe refetches", () => {
        vi.useFakeTimers();
        const { client, sockets } = createClient();
        client.connect();
        handshake(sockets[0]!, client);
        client.subscribe("s1");
        sockets[0]!.receive({ type: "snapshot", sessionId: "s1", epoch: "e1", seq: 10, payload: {} });
        expect(client.getLastSeq("s1")).toBe(10);
        expect(client.getEpoch("s1")).toBe("e1");

        sockets[0]!.receive({ type: "resync_required", sessionId: "s1", epoch: "e1", seq: 10, payload: {} });
        expect(client.getLastSeq("s1")).toBeUndefined();
        expect(client.getEpoch("s1")).toBeUndefined();

        sockets[0]!.serverClose();
        vi.advanceTimersByTime(200);
        handshake(sockets[1]!, client);
        expect(sockets[1]!.frames("subscribe")).toEqual([
            { v: 1, type: "subscribe", payload: { sessionIds: ["s1"] } },
        ]);
    });

    it("keeps the exponential backoff while resuming several sessions", () => {
        vi.useFakeTimers();
        const { client, sockets } = createClient();
        client.connect();
        handshake(sockets[0]!, client);

        client.subscribe(["s1", "s2"]);
        sockets[0]!.receive({ type: "snapshot", sessionId: "s1", epoch: "e1", seq: 4, payload: {} });
        sockets[0]!.serverClose();

        // First retry waits the initial 200ms; the client keeps trying.
        vi.advanceTimersByTime(199);
        expect(sockets).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(sockets).toHaveLength(2);

        handshake(sockets[1]!, client);
        // One resumable frame per cursor, one batch for the rest.
        expect(sockets[1]!.frames("subscribe")).toEqual([
            {
                v: 1,
                type: "subscribe",
                payload: { sessionIds: ["s1"], since: { sessionId: "s1", epoch: "e1", seq: 4 } },
            },
            { v: 1, type: "subscribe", payload: { sessionIds: ["s2"] } },
        ]);
    });
});
