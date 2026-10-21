import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commandCalls, mockApi } from "./helpers/api-mock";
import { renderPage } from "./helpers/render-page";

import { setLanguage } from "@/lib/i18n";
import type { WorkspaceInfo } from "@/lib/protocol";
import { WorkspacePage } from "@/pages/workspace";
import { WorkspacesPage } from "@/pages/workspaces";

const infoBody = {
    v: 1,
    daemonId: "daemon-1",
    machineId: "machine-1",
    platform: "linux",
    capabilities: ["read", "steer"],
    limits: { maxInstances: 5 },
};

function workspace(overrides: Partial<WorkspaceInfo> & Pick<WorkspaceInfo, "workspaceId" | "cwd" | "name">): WorkspaceInfo {
    return {
        trusted: true,
        exists: true,
        sessionCount: 0,
        liveCount: 0,
        lastActiveAt: 0,
        instance: null,
        ...overrides,
    };
}

function routes() {
    return [
        { path: "/workspaces", component: WorkspacesPage },
        { path: "/chat", component: () => <div>Chat destination</div> },
        { path: "/status", component: () => <div>Status destination</div> },
    ];
}

beforeEach(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("WorkspacesPage", () => {
    it("sorts pinned workspaces first, then by lastActiveAt descending", async () => {
        const items = [
            workspace({ workspaceId: "ws-b", cwd: "/work/b", name: "Bravo", lastActiveAt: 3_000 }),
            workspace({ workspaceId: "ws-a", cwd: "/work/a", name: "Alpha", pinned: true, lastActiveAt: 1_000 }),
            workspace({ workspaceId: "ws-c", cwd: "/work/c", name: "Charlie", lastActiveAt: 2_000 }),
        ];
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            { path: "/api/v1/workspaces", handler: () => ({ body: items }) },
        ]);

        const { container } = await renderPage(routes(), "/workspaces", { paired: true });
        await screen.findByText("Bravo");

        const names = [...container.querySelectorAll(".list-row__name")].map((node) => node.textContent);
        expect(names).toEqual(["Alpha", "Bravo", "Charlie"]);
    });

    it("renders the empty state without a server picker", async () => {
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            { path: "/api/v1/workspaces", handler: () => ({ body: [] }) },
        ]);

        await renderPage(routes(), "/workspaces", { paired: true });
        expect(await screen.findByText("No workspaces yet")).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Open new workspace" }).length).toBeGreaterThan(0);
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    });

    it("shows an error state with retry when the list request fails", async () => {
        let attempts = 0;
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            {
                path: "/api/v1/workspaces",
                handler: () => {
                    attempts += 1;
                    return { status: 500, body: { error: { code: "E_INTERNAL", message: "boom" } } };
                },
            },
        ]);

        await renderPage(routes(), "/workspaces", { paired: true });
        expect(await screen.findByText("Could not load workspaces")).toBeInTheDocument();
        expect(attempts).toBe(1);

        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await waitFor(() => expect(attempts).toBe(2));
    });

    it("validates the path, then runs workspace.add + instance.ensure and navigates", async () => {
        const base = [workspace({ workspaceId: "ws-old", cwd: "/work/old", name: "Old project" })];
        let items = base;
        const fetchMock = mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            { path: "/api/v1/workspaces", handler: () => ({ body: items }) },
            {
                method: "POST",
                path: "/api/v1/cmd",
                handler: ({ body }) => {
                    const command = body as { method?: string };
                    if (command.method === "workspace.add") {
                        items = [...base, workspace({ workspaceId: "ws-new", cwd: "/work/new", name: "New project" })];
                        return { body: { accepted: true, workspaceId: "ws-new" } };
                    }
                    return { body: { accepted: true } };
                },
            },
        ]);

        const { router } = await renderPage(routes(), "/workspaces", { paired: true });
        await screen.findByText("Old project");

        fireEvent.click(screen.getByRole("button", { name: "Open new workspace" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
        expect(await within(dialog).findByText("Enter a working directory path")).toBeInTheDocument();
        expect(commandCalls(fetchMock)).toHaveLength(0);

        fireEvent.change(within(dialog).getByLabelText("Path"), { target: { value: "/work/new" } });
        fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "New project" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));

        await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
        expect(router.state.location.href).toContain("workspace=ws-new");

        const commands = commandCalls(fetchMock);
        expect(commands.map((command) => command.method)).toEqual(["workspace.add", "instance.ensure"]);
        expect(commands[1]?.params).toEqual({ workspaceId: "ws-new" });
        expect(await screen.findByText("Chat destination")).toBeInTheDocument();
    });

    it("redirects /workspace/:workspaceId deep links into chat", async () => {
        mockApi([{ path: "/api/v1/info", handler: () => ({ body: infoBody }) }]);
        const { router } = await renderPage(
            [
                { path: "/workspace/$workspaceId", component: WorkspacePage },
                { path: "/chat", component: () => <div>Chat destination</div> },
            ],
            "/workspace/ws-42",
            { paired: true },
        );

        await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
        expect(router.state.location.href).toContain("workspace=ws-42");
        expect(await screen.findByText("Chat destination")).toBeInTheDocument();
    });
});
