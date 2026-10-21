import { vi } from "vitest";

export interface MockRequest {
    url: URL;
    method: string;
    body: unknown;
}

export interface MockReply {
    status?: number;
    body?: unknown;
}

export interface MockRoute {
    method?: "GET" | "POST" | "DELETE" | "PUT";
    path: string | RegExp;
    handler: (request: MockRequest) => MockReply | Promise<MockReply>;
}

function matches(route: MockRoute, method: string, pathname: string): boolean {
    if (route.method && route.method !== method) return false;
    return typeof route.path === "string" ? route.path === pathname : route.path.test(pathname);
}

/**
 * MSW-style fetch fake: a small route table instead of per-URL stubs.
 * Unhandled requests fail loudly so a page cannot silently hit the network.
 */
export function mockApi(routes: MockRoute[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const raw =
            typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const url = new URL(raw, "http://localhost");
        const method = (init?.method ?? "GET").toUpperCase();
        let body: unknown;
        if (typeof init?.body === "string") {
            try {
                body = JSON.parse(init.body);
            } catch {
                body = init.body;
            }
        }

        const route = routes.find((candidate) => matches(candidate, method, url.pathname));
        if (!route) throw new Error(`Unhandled request: ${method} ${url.pathname}`);
        const reply = await route.handler({ url, method, body });
        const status = reply.status ?? 200;
        return new Response(status === 204 ? null : JSON.stringify(reply.body ?? {}), {
            status,
            headers: { "content-type": "application/json" },
        });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

export interface CommandCall {
    method: string;
    params?: Record<string, unknown>;
}

/** Parse the recorded POST /api/v1/cmd bodies. */
export function commandCalls(fetchMock: ReturnType<typeof mockApi>): CommandCall[] {
    return fetchMock.mock.calls
        .filter(([input, init]) => {
            const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const url = new URL(raw, "http://localhost");
            return url.pathname === "/api/v1/cmd" && (init?.method ?? "GET").toUpperCase() === "POST";
        })
        .map(([, init]) => {
            const parsed = JSON.parse(String(init?.body ?? "{}")) as CommandCall;
            return parsed;
        });
}
