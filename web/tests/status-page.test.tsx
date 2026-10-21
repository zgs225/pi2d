import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commandCalls, mockApi } from "./helpers/api-mock";
import { renderPage } from "./helpers/render-page";

import { setLanguage } from "@/lib/i18n";
import { StatusPage } from "@/pages/status";

const infoBody = {
    v: 1,
    daemonId: "daemon-1",
    machineId: "machine-1",
    platform: "linux",
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
        instance: null,
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

function routes() {
    return [
        { path: "/status", component: StatusPage },
        { path: "/connect", component: () => <div>Connect destination</div> },
        { path: "/workspaces", component: () => <div>Workspaces destination</div> },
    ];
}

function apiRoutes(devicesHandler = () => ({ body: { devices: devicesBody } })) {
    return [
        { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
        { path: "/api/v1/health", handler: () => ({ body: healthBody }) },
        { path: "/api/v1/resources", handler: () => ({ body: resourcesBody }) },
        { path: "/api/v1/workspaces", handler: () => ({ body: workspacesBody }) },
        { path: "/api/v1/models", handler: () => ({ body: modelsBody }) },
        { path: "/api/v1/devices", handler: devicesHandler },
        { method: "POST" as const, path: "/api/v1/cmd", handler: () => ({ body: { accepted: true } }) },
    ];
}

const devicesBody = [
    {
        id: "dev-1",
        name: "Pixel",
        kind: "phone",
        scopes: ["read", "steer"],
        lastActiveAt: Date.now() - 60_000,
        revokedAt: null,
    },
];

beforeEach(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("StatusPage", () => {
    it("renders server, health, resources, models and devices", async () => {
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
        expect(await screen.findByText("Pixel")).toBeInTheDocument();
        expect(screen.getByText("Paired devices")).toBeInTheDocument();
    });

    it("revokes a device only after the confirmation dialog", async () => {
        const fetchMock = mockApi(apiRoutes());
        await renderPage(routes(), "/status", { paired: true });
        await screen.findByText("Pixel");

        fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText('Revoke access for "Pixel"? The phone\'s next request will fail.')).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

        await waitFor(() => expect(screen.queryByText("Pixel")).not.toBeInTheDocument());

        const commands = commandCalls(fetchMock);
        expect(commands).toHaveLength(1);
        expect(commands[0]).toEqual({ method: "device.revoke", params: { deviceId: "dev-1" } });
    });
});
