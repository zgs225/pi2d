import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceInfo } from "@/lib/protocol";
import { PiWsClient, type WebSocketLike, type WsFrame } from "@/lib/ws";

/** Same fake socket as `ws.test.ts`: no real transport anywhere in unit tests. */
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
}

/** Short window so the coalescing assertions stay fast without fake timers. */
const COALESCE_MS = 20;

function connect(queryClient?: QueryClient) {
    const sockets: FakeSocket[] = [];
    const client = new PiWsClient({
        url: "ws://127.0.0.1:7676/api/v1/ws",
        token: "pkt_test",
        heartbeatMs: 0,
        instanceStateCoalesceMs: COALESCE_MS,
        ...(queryClient ? { queryClient } : {}),
        socketFactory: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
    });
    client.connect();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ v: 1, type: "hello_ack", payload: {} });
    return { client, socket };
}

/** Two queries the workspace page actually runs, observed the way the page does. */
function observe(queryClient: QueryClient) {
    const workspaces = vi.fn(async (): Promise<WorkspaceInfo[]> => []);
    const health = vi.fn(async () => ({ ok: true, items: [] }));
    const observers = [
        new QueryObserver(queryClient, { queryKey: ["workspaces"], queryFn: workspaces }),
        new QueryObserver(queryClient, { queryKey: ["health"], queryFn: health }),
    ];
    const unsubscribes = observers.map((observer) => observer.subscribe(() => {}));
    return {
        workspaces,
        health,
        stop: () => {
            for (const unsubscribe of unsubscribes) unsubscribe();
        },
    };
}

function newQueryClient() {
    return new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
    });
}

afterEach(() => {
    vi.useRealTimers();
});

describe("instance_state frames", () => {
    it("refetches the workspaces list (and health) instead of being dropped", async () => {
        const queryClient = newQueryClient();
        const observed = observe(queryClient);
        await vi.waitFor(() => expect(observed.workspaces).toHaveBeenCalledTimes(1));
        expect(observed.health).toHaveBeenCalledTimes(1);

        const { client, socket } = connect(queryClient);
        socket.receive({
            v: 1,
            type: "instance_state",
            workspaceId: "ws-1",
            payload: { status: "ready", sessions: [] },
        });

        // Invalidation, not a local patch: the row (and the health strip) refetch.
        await vi.waitFor(() => expect(observed.workspaces).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(observed.health).toHaveBeenCalledTimes(2));

        client.close();
        observed.stop();
    });

    it("coalesces a startup burst into a single refetch round", async () => {
        const queryClient = newQueryClient();
        const observed = observe(queryClient);
        await vi.waitFor(() => expect(observed.workspaces).toHaveBeenCalledTimes(1));

        const { client, socket } = connect(queryClient);
        for (const status of ["starting", "ready", "degraded"]) {
            socket.receive({ v: 1, type: "instance_state", workspaceId: "ws-1", payload: { status } });
        }

        await vi.waitFor(() => expect(observed.workspaces).toHaveBeenCalledTimes(2));
        // A burst must not fan out into one refetch per frame.
        await new Promise((resolve) => setTimeout(resolve, COALESCE_MS * 3));
        expect(observed.workspaces).toHaveBeenCalledTimes(2);
        expect(observed.health).toHaveBeenCalledTimes(2);

        client.close();
        observed.stop();
    });

    it("stays tolerant without a query client and keeps ignoring unknown frames", () => {
        const { client, socket } = connect();
        expect(client.getState()).toBe("open");

        for (const type of ["instance_state", "mystery_frame", "presence", "pong"]) {
            expect(() => socket.receive({ v: 1, type, payload: { status: "ready" } })).not.toThrow();
        }
        expect(client.getState()).toBe("open");
        // Still usable afterwards: a second connection state change is still reported.
        socket.receive({ v: 1, type: "error", payload: { code: "E_INTERNAL", message: "boom" } });
        expect(client.getState()).toBe("open");

        client.close();
    });
});
