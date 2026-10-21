import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commandCalls, mockApi, type MockRoute } from "./helpers/api-mock";
import { renderPage } from "./helpers/render-page";

import { setLanguage } from "@/lib/i18n";
import { StatusPage } from "@/pages/status";
import { useConnectionStore } from "@/stores/connection";

/** `/info` as the daemon answers it (src/daemon/http.ts §/api/v1/info). */
const infoBody = {
    v: 1,
    daemonId: "daemon-1",
    machineId: "machine-1",
    platform: "linux",
    hostname: "pi2-box",
    os: "Linux 6.1.0",
    version: "0.2.0",
    uptimeMs: 2 * 3_600_000 + 5 * 60_000,
    pid: 4242,
    port: 4321,
    capabilities: ["read", "steer"],
    limits: { maxInstances: 5 },
};

const workspacesBody = [
    {
        workspaceId: "ws-1",
        cwd: "/home/me/work",
        name: "Work",
        trusted: true,
        exists: true,
        sessionCount: 2,
        liveCount: 1,
        lastActiveAt: Date.now(),
        // A live instance is what makes `/sessions` answer without spawning one.
        instance: { workspaceId: "ws-1", status: "ready", pid: 4242, since: Date.now() },
    },
];

const healthBody = {
    ok: false,
    checkedAt: Date.now(),
    items: [
        { name: "plugin", ok: true, detail: "connected" },
        { name: "linsor", ok: false, detail: "degraded" },
    ],
};

const resourcesBody = {
    instances: [
        {
            workspaceId: "ws-1",
            instanceId: "instance-1",
            nvimPid: 4242,
            rssBytes: 512 * 1024 * 1024,
            sessions: 2,
            hasUI: true,
        },
    ],
    totalRssBytes: 512 * 1024 * 1024,
    physicalMemoryBytes: 2048 * 1024 * 1024,
    warn: true,
    reason: "rss > soft limit",
};

const modelsBody = {
    providers: [
        {
            provider: "anthropic",
            models: [{ id: "claude-sonnet-4", contextWindow: 200_000, reasoning: true }],
        },
    ],
};

const pairBody = {
    accepted: true,
    code: "ABCD1234",
    url: "http://127.0.0.1:4321/pair/ABCD1234",
    expiresAt: Date.now() + 9 * 60_000,
    nonce: "nonce-1",
};

const tasksBody = {
    sessions: [
        {
            sessionId: "sess-1",
            workspaceId: "ws-1",
            tasks: [
                {
                    id: "task-1",
                    command: "pnpm build",
                    status: "running",
                    startTime: Date.now() - 5_000,
                    durationMs: 4_200,
                    exitCode: null,
                },
            ],
        },
    ],
};

/** `GET /api/v1/devices` answers a BARE ARRAY (`auth.listDevices()`). */
const devicesBody = [
    {
        id: "dev-1",
        name: "Pixel",
        kind: "phone",
        scopes: ["read", "steer"],
        createdAt: Date.now() - 90_000,
        lastSeenAt: Date.now() - 60_000,
        revokedAt: null,
    },
];

function routes() {
    return [
        { path: "/status", component: StatusPage },
        { path: "/connect", component: () => <div>Connect destination</div> },
        { path: "/workspaces", component: () => <div>Workspaces destination</div> },
    ];
}

const SESSIONS_PATH = /^\/api\/v1\/workspaces\/[^/]+\/sessions$/;

function apiRoutes(overrides: MockRoute[] = []) {
    const base: MockRoute[] = [
        { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
        { path: "/api/v1/health", handler: () => ({ body: healthBody }) },
        { path: "/api/v1/resources", handler: () => ({ body: resourcesBody }) },
        { path: "/api/v1/workspaces", handler: () => ({ body: workspacesBody }) },
        { path: SESSIONS_PATH, handler: () => ({ body: tasksBody }) },
        { path: "/api/v1/models", handler: () => ({ body: modelsBody }) },
        { path: "/api/v1/devices", handler: () => ({ body: devicesBody }) },
        { method: "DELETE" as const, path: "/api/v1/devices/dev-1", handler: () => ({ status: 204 }) },
        { method: "POST" as const, path: "/api/v1/pair", handler: () => ({ body: pairBody }) },
        { method: "POST" as const, path: "/api/v1/cmd", handler: () => ({ body: { accepted: true } }) },
    ];
    const overridePaths = overrides.map((route) => route.path);
    return [...overrides, ...base.filter((route) => !overridePaths.includes(route.path))];
}

type FetchMock = ReturnType<typeof mockApi>;

/** Recorded `method path` requests (the mock keeps every call). */
function requests(fetchMock: FetchMock, method: string, path: string): { body: unknown }[] {
    return fetchMock.mock.calls
        .filter(([input, init]) => {
            const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const url = new URL(raw, "http://localhost");
            return url.pathname === path && (init?.method ?? "GET").toUpperCase() === method;
        })
        .map(([, init]) => {
            const body = init?.body;
            return { body: typeof body === "string" ? (JSON.parse(body) as unknown) : undefined };
        });
}

function card(title: string): HTMLElement {
    const heading = screen.getByText(title);
    const root = heading.closest(".status-card");
    if (!(root instanceof HTMLElement)) throw new Error(`card "${title}" not found`);
    return root;
}

beforeEach(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("StatusPage", () => {
    it("renders server, health, resources, models, tasks and devices", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });

        expect(await screen.findByText("Server info")).toBeInTheDocument();
        expect(await screen.findByText("plugin")).toBeInTheDocument();
        expect(screen.getByText("linsor")).toBeInTheDocument();
        expect(screen.getByText("25%")).toBeInTheDocument();
        expect(
            screen.getByText("Memory is close to the soft limit; new instances may start slowly."),
        ).toBeInTheDocument();
        expect(await screen.findByText("claude-sonnet-4")).toBeInTheDocument();
        expect(screen.getByText("200k")).toBeInTheDocument();
        expect(screen.getByText("reasoning")).toBeInTheDocument();
        // Devices come from a bare array, tasks from every workspace's sessions.
        expect(await screen.findByText("Pixel")).toBeInTheDocument();
        expect(await screen.findByText("pnpm build")).toBeInTheDocument();
        expect(screen.getByText("Paired devices")).toBeInTheDocument();
    });

    it("renders the daemon identity fields from /info and the /resources counts", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });
        await screen.findByText("Server info");

        await waitFor(() => expect(screen.getByText("daemon-1")).toBeInTheDocument());
        const info = card("Server info");
        // hostname and bind address both resolve to the daemon's hostname.
        expect(within(info).getAllByText("pi2-box").length).toBeGreaterThan(0);
        expect(within(info).getByText("Linux 6.1.0")).toBeInTheDocument();
        expect(within(info).getByText("linux")).toBeInTheDocument();
        expect(within(info).getByText("0.2.0")).toBeInTheDocument();
        expect(within(info).getByText("machine-1")).toBeInTheDocument();
        expect(within(info).getByText("2h 5m")).toBeInTheDocument();
        expect(within(info).getByText("4321")).toBeInTheDocument();
        // /resources: one instance, 512 MiB total RSS.
        expect(within(info).getByText("512 MiB")).toBeInTheDocument();
        expect(within(info).getByText("Instances")).toBeInTheDocument();
        // No placeholder for fields the daemon really sends.
        expect(within(info).queryByText("—")).not.toBeInTheDocument();
    });

    it("reports the WebSocket state from the shared connection store", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });

        expect(await screen.findByTestId("ws-status")).toHaveTextContent("Disconnected");
        act(() => useConnectionStore.getState().setWsState("open"));
        await waitFor(() => expect(screen.getByTestId("ws-status")).toHaveTextContent("Connected"));
    });

    it("mints a pairing code for the connection card", async () => {
        const fetchMock = mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });

        expect(await screen.findByTestId("pairing-code")).toHaveTextContent("ABCD1234");
        expect(screen.getByTestId("pairing-url")).toHaveTextContent(pairBody.url);
        expect(screen.getByText(/Pairing code expires in \d+ minutes/)).toBeInTheDocument();

        const calls = requests(fetchMock, "POST", "/api/v1/pair");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.body).toEqual({ ttlSec: 600 });
    });

    it("offers a retry when minting a pairing code fails", async () => {
        let attempts = 0;
        mockApi(
            apiRoutes([
                {
                    method: "POST",
                    path: "/api/v1/pair",
                    handler: () => {
                        attempts += 1;
                        return attempts === 1
                            ? { status: 500, body: { error: { code: "E_INTERNAL", message: "boom" } } }
                            : { body: pairBody };
                    },
                },
            ]),
        );
        await renderPage(routes(), "/status", { paired: true });

        const connection = card("Connection");
        expect(await within(connection).findByText("Internal server error")).toBeInTheDocument();
        expect(within(connection).queryByTestId("pairing-code")).not.toBeInTheDocument();

        fireEvent.click(within(connection).getByRole("button", { name: "Retry" }));
        expect(await within(connection).findByTestId("pairing-code")).toHaveTextContent("ABCD1234");
        expect(attempts).toBe(2);
    });

    it("revokes a device with DELETE after the confirmation dialog", async () => {
        const fetchMock = mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });
        await screen.findByText("Pixel");

        // Duplicate "Revoke" names would break strict locators: each row names its device.
        fireEvent.click(screen.getByRole("button", { name: "Revoke Pixel" }));
        const dialog = await screen.findByRole("dialog");
        expect(
            within(dialog).getByText('Revoke access for "Pixel"? The phone\'s next request will fail.'),
        ).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

        await waitFor(() => expect(screen.queryByText("Pixel")).not.toBeInTheDocument());

        expect(requests(fetchMock, "DELETE", "/api/v1/devices/dev-1")).toHaveLength(1);
        expect(commandCalls(fetchMock)).toHaveLength(0);
    });

    it("still lists devices when the daemon answers the legacy {devices} envelope", async () => {
        mockApi(apiRoutes([{ path: "/api/v1/devices", handler: () => ({ body: { devices: devicesBody } }) }]));
        await renderPage(routes(), "/status", { paired: true });

        expect(await screen.findByText("Pixel")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Revoke Pixel" })).toBeInTheDocument();
    });

    it("shows an error with retry when the device list fails", async () => {
        let attempts = 0;
        mockApi(
            apiRoutes([
                {
                    path: "/api/v1/devices",
                    handler: () => {
                        attempts += 1;
                        return attempts === 1
                            ? { status: 500, body: { error: { code: "E_INTERNAL", message: "boom" } } }
                            : { body: devicesBody };
                    },
                },
            ]),
        );
        await renderPage(routes(), "/status", { paired: true });

        const devices = card("Paired devices");
        expect(await within(devices).findByText("Internal server error")).toBeInTheDocument();

        fireEvent.click(within(devices).getByRole("button", { name: "Retry" }));
        expect(await within(devices).findByText("Pixel")).toBeInTheDocument();
        expect(attempts).toBe(2);
    });

    it("keeps the tasks empty state when no workspace reports a task", async () => {
        mockApi(
            apiRoutes([
                { path: SESSIONS_PATH, handler: () => ({ body: { sessions: [{ sessionId: "sess-1", tasks: [] }] } }) },
            ]),
        );
        await renderPage(routes(), "/status", { paired: true });

        const tasks = card("Background tasks");
        expect(await within(tasks).findByText("No background tasks")).toBeInTheDocument();
    });

    it("does not ask for sessions of workspaces without a live instance", async () => {
        // `/sessions` relays through instances.ensure(), which would spawn a Neovim
        // for every idle workspace — the status page must never trigger that.
        const fetchMock = mockApi(
            apiRoutes([
                {
                    path: "/api/v1/workspaces",
                    handler: () => ({ body: workspacesBody.map((workspace) => ({ ...workspace, instance: null })) }),
                },
            ]),
        );
        await renderPage(routes(), "/status", { paired: true });

        const tasks = card("Background tasks");
        expect(await within(tasks).findByText("No background tasks")).toBeInTheDocument();
        expect(requests(fetchMock, "GET", "/api/v1/workspaces/ws-1/sessions")).toHaveLength(0);
    });
});
