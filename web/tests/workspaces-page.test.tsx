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

/** Card names are also repeated in the activity column, so wait on the cards. */
async function waitForCards(count: number) {
    await waitFor(() => expect(screen.getAllByTestId("workspace-row")).toHaveLength(count));
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
        await waitForCards(3);

        const names = [...container.querySelectorAll(".ws-grid .ws-card__name")].map((node) => node.textContent);
        expect(names).toEqual(["Alpha", "Bravo", "Charlie"]);

        // Stable hooks for the e2e/Playwright suite (whole-card link per row).
        const rows = screen.getAllByTestId("workspace-row");
        expect(rows.map((row) => row.getAttribute("data-workspace-id"))).toEqual(["ws-a", "ws-b", "ws-c"]);
        expect(rows.map((row) => row.getAttribute("href"))).toEqual([
            "/chat?workspace=ws-a",
            "/chat?workspace=ws-b",
            "/chat?workspace=ws-c",
        ]);
    });

    it("makes the whole card the link and drops the in-row primary button", async () => {
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            {
                path: "/api/v1/workspaces",
                handler: () => ({
                    body: [
                        workspace({
                            workspaceId: "ws-a",
                            cwd: "/work/alpha",
                            name: "Alpha",
                            sessionCount: 3,
                            liveCount: 2,
                            lastActiveAt: 4_000,
                            instance: {
                                workspaceId: "ws-a",
                                instanceId: "inst-a",
                                status: "ready",
                                nvimPid: 42,
                                pluginVersion: "0.1.1",
                                hasUI: true,
                                attachedClients: 1,
                                listenAddr: "127.0.0.1:7777",
                                startedAt: 1_000,
                            },
                        }),
                    ],
                }),
            },
        ]);

        const { container } = await renderPage(routes(), "/workspaces", { paired: true });
        await waitForCards(1);

        const [card] = screen.getAllByTestId("workspace-row");
        expect(card?.tagName).toBe("A");
        expect(card).toHaveClass("ws-card");
        // Accessible name carries name + cwd + count (v0.1.1 §1.3).
        expect(card?.getAttribute("aria-label")).toContain("Alpha — /work/alpha — 3 sessions");

        // Aggregate state is a dot *plus* text, never colour alone.
        expect(card?.querySelector(".ws-card__state .dot")).toHaveClass("dot--ok");
        expect(card?.querySelector(".ws-card__state")).toHaveTextContent("Instance ready");
        // Foot: count + the (non-interactive) "open" affordance.
        expect(card?.querySelector(".ws-card__count")).toHaveTextContent("3 sessions");
        expect(card?.querySelector(".ws-card__open")).toBeInTheDocument();

        // No row-level primary "enter" button left anywhere on the page.
        expect(screen.queryByTestId("workspace-enter")).toBeNull();
        const primaries = [...container.querySelectorAll(".btn--primary")];
        expect(primaries).toHaveLength(1);
        expect(primaries[0]).toHaveTextContent("Open new workspace");
    });

    it("renders the server summary as one single-line status strip", async () => {
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            {
                path: "/api/v1/workspaces",
                handler: () => ({
                    body: [
                        workspace({ workspaceId: "ws-a", cwd: "/work/a", name: "Alpha", lastActiveAt: 1_000 }),
                        workspace({ workspaceId: "ws-b", cwd: "/work/b", name: "Bravo", liveCount: 1, lastActiveAt: 2_000 }),
                    ],
                }),
            },
        ]);

        const { container } = await renderPage(routes(), "/workspaces", { paired: true });
        await waitForCards(2);

        const strip = screen.getByTestId("workspaces-status-line");
        expect(strip.tagName).toBe("SECTION");
        expect(strip).toHaveClass("status-line");
        expect(strip).toHaveAttribute("role", "group");
        expect(strip).toHaveAttribute("aria-label", "Current server");
        expect(strip).toHaveTextContent("127.0.0.1:4321");
        expect(strip).toHaveTextContent("2 workspaces");
        expect(strip.querySelector(".dot")).toHaveClass("dot--lg");
        expect(within(strip).getByRole("link")).toHaveAttribute("href", "/status");

        // The v0.1.0 card-shaped context bar is gone.
        expect(container.querySelector(".ws-context")).toBeNull();
    });

    it("lists the newest workspaces in a recent-activity column", async () => {
        const items = [1, 2, 3, 4, 5, 6].map((n) =>
            workspace({ workspaceId: `ws-${n}`, cwd: `/work/${n}`, name: `Project ${n}`, lastActiveAt: n * 1_000 }),
        );
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            { path: "/api/v1/workspaces", handler: () => ({ body: items }) },
        ]);

        await renderPage(routes(), "/workspaces", { paired: true });
        await waitForCards(6);

        const activity = screen.getByTestId("workspaces-activity");
        expect(activity.tagName).toBe("ASIDE");

        const rows = within(activity).getAllByTestId("workspace-activity-row");
        // Newest first, capped at 5 (v0.1.1 §5.1).
        expect(rows.map((row) => row.getAttribute("data-workspace-id"))).toEqual(["ws-6", "ws-5", "ws-4", "ws-3", "ws-2"]);
        expect(rows[0]).toHaveAttribute("href", "/chat?workspace=ws-6");
        // Head carries the section label + the entry count (a11y name is the i18n label).
        expect(activity).toHaveAttribute("aria-label");
        expect(activity.querySelector(".ws-activity__count")).toHaveTextContent("5");
    });

    it("opens the new-workspace dialog from the empty state", async () => {
        const fetchMock = mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            { path: "/api/v1/workspaces", handler: () => ({ body: [] }) },
        ]);

        const { container } = await renderPage(routes(), "/workspaces", { paired: true });
        await screen.findByText("No workspaces yet");

        // The empty state owns the only primary; the page-head action stays off.
        const newButtons = screen.getAllByRole("button", { name: "Open new workspace" });
        expect(newButtons).toHaveLength(1);
        expect(newButtons[0]).toHaveClass("btn--primary");
        expect(container.querySelector(".page-head__actions")).toBeNull();

        fireEvent.click(newButtons[0]!);
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByLabelText("Path")).toBeInTheDocument();

        // An empty path is rejected inline and issues no command.
        fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));
        expect(await within(dialog).findByText("Enter a working directory path")).toBeInTheDocument();
        expect(commandCalls(fetchMock)).toHaveLength(0);
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
        // The activity column keeps its own empty state.
        expect(screen.getByTestId("workspaces-activity")).toBeInTheDocument();
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

        // Retry is not a second primary (the header primary stays off in error states).
        const retry = screen.getByRole("button", { name: "Retry" });
        expect(retry).not.toHaveClass("btn--primary");
        expect(screen.queryByRole("button", { name: "Open new workspace" })).toBeNull();

        fireEvent.click(retry);
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
        await waitForCards(1);

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
