import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commandCalls, mockApi, type MockRoute } from "./helpers/api-mock";
import { renderPage } from "./helpers/render-page";

import { drawQr } from "@/features/status/qr";
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
    system: {
        sampledAt: Date.now(),
        // Host uptime, deliberately different from the daemon's own age in `infoBody`.
        hostUptimeSec: 3 * 86_400,
        cpuPercent: 37,
        cpuCores: 8,
        loadAvg: [1.23, 0.98, 0.75],
        memUsedBytes: 4 * 1024 * 1024 * 1024,
        memTotalBytes: 16 * 1024 * 1024 * 1024,
        memPercent: 61,
        diskPath: "/var/lib/pi2",
        diskUsedBytes: 82 * 1024 * 1024 * 1024,
        diskTotalBytes: 100 * 1024 * 1024 * 1024,
        diskPercent: 82,
    },
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

/** A 21×21 byte-mode matrix (`rows` are `"0"`/`"1"`, no quiet zone). */
const qrRows = Array.from({ length: 21 }, (_, y) =>
    Array.from({ length: 21 }, (_, x) => ((x * 7 + y * 3 + (x ^ y)) % 5 < 2 ? "1" : "0")).join(""),
);

const pairBody = {
    accepted: true,
    code: "ABCD1234",
    url: "http://127.0.0.1:4321/pair/ABCD1234",
    expiresAt: Date.now() + 9 * 60_000,
    nonce: "nonce-1",
    qr: { version: 1, ecc: "M", mask: 3, size: 21, rows: qrRows },
    bases: [{ kind: "lan", name: "eth0", address: "192.168.2.10:4321", url: "http://192.168.2.10:4321" }],
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

/** Every primary button on the page — the status page must render none. */
function primaries(): Element[] {
    return [...document.querySelectorAll(".btn--primary")];
}

beforeEach(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("drawQr", () => {
    function fakeCanvas(width: number) {
        const fills: number[][] = [];
        const context = {
            fillStyle: "",
            fillRect: (...args: number[]) => fills.push(args),
            clearRect: () => undefined,
        };
        const canvas = {
            width: 0,
            height: 0,
            clientWidth: width,
            parentElement: null,
            getContext: () => context,
        };
        return { canvas, fills };
    }

    it("paints one square per dark module, capped at 200px and scaled by dpr", () => {
        const { canvas, fills } = fakeCanvas(480);
        drawQr(canvas as unknown as HTMLCanvasElement, qrRows);

        const dpr = window.devicePixelRatio || 1;
        expect(canvas.width).toBe(200 * dpr);
        expect(canvas.height).toBe(200 * dpr);
        // background + one fillRect per `1` module (no fake pattern).
        const dark = qrRows.reduce((total, row) => total + [...row].filter((cell) => cell === "1").length, 0);
        expect(fills).toHaveLength(dark + 1);
    });

    it("clears the canvas for an empty or ragged matrix", () => {
        const { canvas, fills } = fakeCanvas(200);
        drawQr(canvas as unknown as HTMLCanvasElement, []);
        expect(fills).toHaveLength(0);
        expect(canvas.width).toBe(0);

        drawQr(canvas as unknown as HTMLCanvasElement, ["101", "10"]);
        expect(fills).toHaveLength(0);
        expect(canvas.width).toBe(0);
    });
});

describe("StatusPage", () => {
    it("renders the four metric tiles, one count line and no primary button", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });

        await screen.findByText("Server info");

        const tiles = [...document.querySelectorAll<HTMLElement>(".tile")];
        expect(tiles).toHaveLength(4);
        expect(tiles.map((tile) => tile.dataset.res)).toEqual(["cpu", "mem", "disk", "uptime"]);
        for (const tile of tiles) {
            expect(tile.querySelector(".tile__label")).not.toBeNull();
            expect(tile.querySelector(".tile__value")).not.toBeNull();
        }
        // cpu / mem / disk carry the 3px meter, uptime does not.
        expect(document.querySelectorAll(".meter")).toHaveLength(3);
        await waitFor(() => {
            expect(document.querySelector('.status-tile[data-res="cpu"] .tile__value')).toHaveTextContent("37%");
            expect(document.querySelector('.status-tile[data-res="mem"] .tile__value')).toHaveTextContent("61%");
            expect(document.querySelector('.status-tile[data-res="disk"] .tile__value')).toHaveTextContent("82%");
        });
        expect(document.querySelector('.status-tile[data-res="mem"] .tile__meta')).toHaveTextContent("4 GiB / 16 GiB");
        expect(document.querySelector('.status-tile[data-res="disk"] .tile__meta')).toHaveTextContent("/var/lib/pi2");
        expect(document.querySelector('.status-tile[data-res="cpu"] .tile__meta')).toHaveTextContent("8");
        expect(document.querySelector('.status-tile[data-res="cpu"] .tile__meta')).toHaveTextContent("1.23");
        // The tile shows the host, not the daemon process (`/info.uptimeMs` is 2h 5m).
        expect(document.querySelector('.status-tile[data-res="uptime"] .tile__value')).toHaveTextContent("3d 0h 0m");

        const counts = document.querySelector(".status-counts");
        expect(counts).not.toBeNull();
        expect(counts).toHaveTextContent("Workspaces");
        expect(counts).toHaveTextContent("Live sessions");

        // The design's "status page = 0 primary" rule.
        expect(primaries()).toHaveLength(0);
    });

    it("does not derive memory percent from RSS on old daemons", async () => {
        mockApi(
            apiRoutes([
                {
                    path: "/api/v1/resources",
                    handler: () => ({
                        body: {
                            ...resourcesBody,
                            system: undefined,
                        },
                    }),
                },
            ]),
        );
        await renderPage(routes(), "/status", { paired: true });
        await screen.findByText("Server info");
        await waitFor(() =>
            expect(document.querySelector('.status-tile[data-res="mem"] .tile__value')).toHaveTextContent("—"),
        );
    });

    it("puts info + health and models + tasks into two columns, with devices and connection full width", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });
        await screen.findByText("Server info");

        const cols = document.querySelectorAll(".status-page > .status-cols > .status-col");
        expect(cols).toHaveLength(2);
        expect(within(cols[0] as HTMLElement).getByText("Server info")).toBeInTheDocument();
        expect(within(cols[0] as HTMLElement).getByText("Health checks")).toBeInTheDocument();
        expect(within(cols[1] as HTMLElement).getByText("Models & providers")).toBeInTheDocument();
        expect(within(cols[1] as HTMLElement).getByText("Background tasks")).toBeInTheDocument();

        // Devices and connection sit outside the two-column grid (full width).
        for (const title of ["Paired devices", "Connection"]) {
            const root = card(title);
            expect(root.parentElement?.className).toContain("status-page");
            expect(root.className).toContain("card--quiet");
        }
    });

    it("renders the head identity, the update hint and the daemon identity rows", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });
        await screen.findByText("Server info");

        const head = document.querySelector(".page-head.status-head");
        expect(head).not.toBeNull();
        await waitFor(() => {
            const dot = head?.querySelector(".dot--lg");
            expect(dot).toHaveClass("dot--attention");
        });
        await waitFor(() =>
            expect(within(head as HTMLElement).getByText(/pi2-box · pi2-box ·/)).toBeInTheDocument(),
        );
        expect(within(head as HTMLElement).getByText(/updated /)).toBeInTheDocument();

        await waitFor(() => expect(screen.getByText("daemon-1")).toBeInTheDocument());
        const info = card("Server info");
        // hostname and bind address both resolve to the daemon's hostname.
        expect(within(info).getAllByText("pi2-box").length).toBeGreaterThan(0);
        expect(within(info).getByText("Linux 6.1.0")).toBeInTheDocument();
        expect(within(info).getByText("0.2.0")).toBeInTheDocument();
        expect(within(info).getByText("machine-1")).toBeInTheDocument();
        expect(within(info).getByText("2h 5m")).toBeInTheDocument();
        expect(within(info).getByText("4321")).toBeInTheDocument();
        // /resources: one instance, 512 MiB total RSS.
        expect(within(info).getByText("512 MiB")).toBeInTheDocument();
        expect(within(info).getByText("Instances")).toBeInTheDocument();
        expect(within(info).queryByText("—")).not.toBeInTheDocument();
    });

    it("renders the page header dot with dot--ok for a healthy daemon", async () => {
        mockApi(
            apiRoutes([
                {
                    path: "/api/v1/health",
                    handler: () => ({
                        body: {
                            ok: true,
                            checkedAt: Date.now(),
                            items: [{ name: "plugin", ok: true, detail: "connected" }],
                        },
                    }),
                },
            ]),
        );
        await renderPage(routes(), "/status", { paired: true });
        await screen.findByText("Server info");

        const head = document.querySelector(".page-head.status-head");
        expect(head).not.toBeNull();
        await waitFor(() => {
            const dot = head?.querySelector(".dot--lg");
            expect(dot).toHaveClass("dot--ok");
        });
    });

    it("counts failed health checks and keeps the per-check list", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });

        const health = card("Health checks");
        expect(await within(health).findByText("1 check failed")).toBeInTheDocument();
        expect(within(health).getByText("plugin")).toBeInTheDocument();
        expect(within(health).getByText("linsor")).toBeInTheDocument();
    });

    it("reports the WebSocket state from the shared connection store", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });

        expect(await screen.findByTestId("ws-status")).toHaveTextContent("Disconnected");
        act(() => useConnectionStore.getState().setWsState("open"));
        await waitFor(() => expect(screen.getByTestId("ws-status")).toHaveTextContent("Connected"));
    });

    it("mints a pairing code and renders the daemon's QR matrix with the expiry hint", async () => {
        const fetchMock = mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });

        expect(await screen.findByTestId("pairing-code")).toHaveTextContent("ABCD1234");
        const canvas = screen.getByRole("img", { name: "Pairing QR code" });
        expect(canvas).toHaveClass("qr-canvas");
        // 真矩阵：模块数就是 daemon 下发的 `qr.size` / `rows.length`，不是种子图案。
        expect(canvas).toHaveAttribute("data-qr-size", String(qrRows.length));
        expect(screen.getByText("Expires in 9 min")).toBeInTheDocument();
        expect(screen.getByText(/Pairing code expires in \d+ minutes/)).toBeInTheDocument();

        // Addresses wrap instead of truncating: Local / Network rows use .addr__value.
        const addresses = [...document.querySelectorAll(".addr__value")];
        expect(addresses.length).toBeGreaterThanOrEqual(2);

        const calls = requests(fetchMock, "POST", "/api/v1/pair");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.body).toEqual({ ttlSec: 600 });
    });

    it("shows the pairing URL instead of a QR when the daemon omits the matrix", async () => {
        mockApi(
            apiRoutes([
                {
                    method: "POST",
                    path: "/api/v1/pair",
                    handler: () => {
                        const { qr: _qr, ...withoutQr } = pairBody;
                        return { body: withoutQr };
                    },
                },
            ]),
        );
        await renderPage(routes(), "/status", { paired: true });

        expect(await screen.findByTestId("pairing-code")).toHaveTextContent("ABCD1234");
        expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
        expect(screen.getByTestId("pair-url")).toHaveTextContent("http://127.0.0.1:4321/pair/ABCD1234");
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
        // A destructive action never introduces a primary button.
        expect(primaries()).toHaveLength(0);
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

    it("renders a running task as a quiet dot row with its state", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });

        const tasks = card("Background tasks");
        expect(await within(tasks).findByText("pnpm build")).toBeInTheDocument();
        expect(tasks.querySelector(".task-row .task-state.is-run")).toHaveTextContent("Running");
        expect(tasks.querySelector(".task-row .dot")).not.toBeNull();
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

    it("warns when /resources reports the soft limit and still shows the tiles", async () => {
        mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });

        expect(
            await screen.findByText("Memory is close to the soft limit; new instances may start slowly."),
        ).toBeInTheDocument();
        expect(document.querySelectorAll(".tile")).toHaveLength(4);
    });
});
