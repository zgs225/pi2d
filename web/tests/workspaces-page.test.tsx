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
        { path: "/chat/$sessionId", component: () => <div>Chat session destination</div> },
        { path: "/status", component: () => <div>Status destination</div> },
    ];
}

/** The activity column's disk feed; most tests only need it to resolve empty. */
function recentRoute(rows: unknown[] = []) {
    return { path: "/api/v1/sessions/recent", handler: () => ({ body: { sessions: rows } }) };
}

/** One workspace's `/sessions` relay (only called for live instances). */
function sessionsRoute(workspaceId: string, rows: unknown[] = []) {
    return { path: `/api/v1/workspaces/${workspaceId}/sessions`, handler: () => ({ body: { sessions: rows } }) };
}

function diskSession(overrides: Record<string, unknown> & { sessionId: string; workspaceId: string }) {
    return {
        workspaceName: overrides.workspaceId,
        cwd: `/work/${overrides.workspaceId}`,
        sessionFile: `/sessions/${overrides.workspaceId}/${overrides.sessionId}.jsonl`,
        timestamp: 1_000,
        modified: 1_000,
        ...overrides,
    };
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
            recentRoute(),
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
            recentRoute(),
            sessionsRoute("ws-a"),
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
            recentRoute(),
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

    it("lists the newest sessions across workspaces in a recent-activity column", async () => {
        const items = [
            workspace({ workspaceId: "ws-a", cwd: "/work/a", name: "Alpha", lastActiveAt: 1_000 }),
            workspace({ workspaceId: "ws-b", cwd: "/work/b", name: "Bravo", lastActiveAt: 2_000 }),
        ];
        const rows = [
            diskSession({ sessionId: "s-6", workspaceId: "ws-b", workspaceName: "Bravo", modified: 6_000 }),
            diskSession({ sessionId: "s-1", workspaceId: "ws-a", workspaceName: "Alpha", modified: 1_000 }),
            diskSession({ sessionId: "s-4", workspaceId: "ws-a", workspaceName: "Alpha", modified: 4_000 }),
            diskSession({ sessionId: "s-2", workspaceId: "ws-b", workspaceName: "Bravo", modified: 2_000 }),
            diskSession({ sessionId: "s-5", workspaceId: "ws-a", workspaceName: "Alpha", modified: 5_000 }),
            diskSession({ sessionId: "s-3", workspaceId: "ws-a", workspaceName: "Alpha", modified: 3_000 }),
        ];
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            { path: "/api/v1/workspaces", handler: () => ({ body: items }) },
            recentRoute(rows),
        ]);

        await renderPage(routes(), "/workspaces", { paired: true });
        await waitForCards(2);

        const activity = screen.getByTestId("workspaces-activity");
        expect(activity.tagName).toBe("ASIDE");

        const links = await within(activity).findAllByTestId("workspace-activity-row");
        // Newest session first, capped at 5 (v0.1.1 §5.1), regardless of the
        // workspace order in the grid.
        expect(links.map((row) => row.getAttribute("data-session-id"))).toEqual(["s-6", "s-5", "s-4", "s-3", "s-2"]);
        expect(links[0]).toHaveAttribute("href", "/chat/s-6?workspace=ws-b");
        expect(links[0]).toHaveTextContent("Bravo");
        // Head carries the section label + the entry count (a11y name is the i18n label).
        expect(activity).toHaveAttribute("aria-label");
        expect(activity.querySelector(".ws-activity__count")).toHaveTextContent("5");
    });

    it("enriches a recent-activity row with the live session's title and status", async () => {
        const items = [
            workspace({
                workspaceId: "ws-a",
                cwd: "/work/a",
                name: "Alpha",
                sessionCount: 1,
                liveCount: 1,
                lastActiveAt: 5_000,
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
        ];
        const liveRow = {
            sessionId: "s-live",
            workspaceId: "ws-a",
            name: "Refactor the console",
            status: "busy",
            flags: { attention: false, done: false, error: false },
            lastActiveAt: 9_000,
        };
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            { path: "/api/v1/workspaces", handler: () => ({ body: items }) },
            recentRoute([diskSession({ sessionId: "s-live", workspaceId: "ws-a", modified: 4_000 })]),
            sessionsRoute("ws-a", [liveRow]),
        ]);

        await renderPage(routes(), "/workspaces", { paired: true });
        await waitForCards(1);

        const activity = screen.getByTestId("workspaces-activity");
        expect(await within(activity).findByText("Refactor the console")).toBeInTheDocument();
        const [row] = within(activity).getAllByTestId("workspace-activity-row");
        expect(row).toHaveAttribute("data-session-id", "s-live");
        expect(row).toHaveAttribute("href", "/chat/s-live?workspace=ws-a");
        expect(row?.querySelector(".ws-activity__ws")).toHaveTextContent("Alpha");
        expect(row?.querySelector(".dot")).toHaveClass("dot--busy");
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
            recentRoute(),
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
        // The daemon persists the display name as `alias` (`name` is not a param).
        expect(commands[0]?.params).toEqual({ cwd: "/work/new", alias: "New project" });
        expect(commands[1]?.params).toEqual({ workspaceId: "ws-new" });
        expect(await screen.findByText("Chat destination")).toBeInTheDocument();
    });

    it("rejects a relative path inline instead of round-tripping to the daemon", async () => {
        const fetchMock = mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            {
                path: "/api/v1/workspaces",
                handler: () => ({ body: [workspace({ workspaceId: "ws-old", cwd: "/work/old", name: "Old project" })] }),
            },
            recentRoute(),
        ]);

        await renderPage(routes(), "/workspaces", { paired: true });
        await waitForCards(1);

        fireEvent.click(screen.getByRole("button", { name: "Open new workspace" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.change(within(dialog).getByLabelText("Path"), { target: { value: "work/relative" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));

        expect(
            await within(dialog).findByText("Enter an absolute path, or a path that starts with ~/"),
        ).toBeInTheDocument();
        expect(commandCalls(fetchMock)).toHaveLength(0);
        // Stays open so the path can be corrected in place.
        expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("sends a ~ path verbatim and lets the daemon expand it", async () => {
        const fetchMock = mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            {
                path: "/api/v1/workspaces",
                handler: () => ({ body: [workspace({ workspaceId: "ws-old", cwd: "/work/old", name: "Old project" })] }),
            },
            recentRoute(),
            {
                method: "POST",
                path: "/api/v1/cmd",
                handler: ({ body }) => {
                    const command = body as { method?: string };
                    if (command.method === "workspace.add") return { body: { accepted: true, workspaceId: "ws-home" } };
                    return { body: { accepted: true } };
                },
            },
        ]);

        const { router } = await renderPage(routes(), "/workspaces", { paired: true });
        await waitForCards(1);

        fireEvent.click(screen.getByRole("button", { name: "Open new workspace" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.change(within(dialog).getByLabelText("Path"), { target: { value: "~/Workspace/Misc/my-project" } });
        fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "My project" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));

        await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
        const commands = commandCalls(fetchMock);
        expect(commands.map((command) => command.method)).toEqual(["workspace.add", "instance.ensure"]);
        // Verbatim `~`: the daemon owns home expansion, the browser must not guess.
        expect(commands[0]?.params).toEqual({ cwd: "~/Workspace/Misc/my-project", alias: "My project" });
        expect(commands[1]?.params).toEqual({ workspaceId: "ws-home" });
    });

    it("keeps the dialog open with the daemon reason, then retries only instance.ensure", async () => {
        let ensures = 0;
        let items = [workspace({ workspaceId: "ws-old", cwd: "/work/old", name: "Old project" })];
        const fetchMock = mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            { path: "/api/v1/workspaces", handler: () => ({ body: items }) },
            recentRoute(),
            {
                method: "POST",
                path: "/api/v1/cmd",
                handler: ({ body }) => {
                    const command = body as { method?: string };
                    if (command.method === "workspace.add") {
                        items = [...items, workspace({ workspaceId: "ws-new", cwd: "/work/new", name: "New project" })];
                        return { body: { accepted: true, workspaceId: "ws-new" } };
                    }
                    ensures += 1;
                    if (ensures === 1) {
                        return {
                            status: 503,
                            body: {
                                error: {
                                    code: "E_INSTANCE_UNAVAILABLE",
                                    message: "nvim exited during startup (code 1)",
                                    retryable: true,
                                },
                            },
                        };
                    }
                    return { body: { accepted: true } };
                },
            },
        ]);

        const { router } = await renderPage(routes(), "/workspaces", { paired: true });
        await waitForCards(1);

        fireEvent.click(screen.getByRole("button", { name: "Open new workspace" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.change(within(dialog).getByLabelText("Path"), { target: { value: "/work/new" } });
        fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "New project" } });
        fireEvent.click(within(dialog).getByRole("button", { name: "Open" }));

        const alert = await within(dialog).findByTestId("workspace-form-error");
        // The reason the user can act on, not a code and never a JSON blob.
        expect(alert).toHaveTextContent("nvim exited during startup (code 1)");
        expect(alert.textContent ?? "").not.toContain("E_INSTANCE_UNAVAILABLE");
        expect(alert.textContent ?? "").not.toContain("{");
        expect(alert.className).toContain("ws-form__error--reason");
        expect(screen.getByRole("dialog")).toBeInTheDocument();
        expect(router.state.location.pathname).toBe("/workspaces");

        fireEvent.click(within(dialog).getByRole("button", { name: "Retry starting Neovim" }));

        await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
        expect(router.state.location.href).toContain("workspace=ws-new");
        const commands = commandCalls(fetchMock);
        // One extra instance.ensure only: the workspace was not added a second time.
        expect(commands.map((command) => command.method)).toEqual(["workspace.add", "instance.ensure", "instance.ensure"]);
        expect(commands[2]?.params).toEqual({ workspaceId: "ws-new" });
    });

    it("renders a not-yet-started workspace as idle and explains a degraded instance", async () => {
        const items = [
            workspace({ workspaceId: "ws-new", cwd: "/work/new", name: "Not started" }),
            workspace({
                workspaceId: "ws-bad",
                cwd: "/work/bad",
                name: "Degraded",
                instance: {
                    workspaceId: "ws-bad",
                    instanceId: "inst-bad",
                    status: "degraded",
                    nvimPid: 42,
                    pluginVersion: null,
                    hasUI: false,
                    attachedClients: 0,
                    listenAddr: null,
                    startedAt: 1_000,
                    reason: "plugin handshake timed out after 1500ms",
                },
            }),
            workspace({
                workspaceId: "ws-busy",
                cwd: "/work/busy",
                name: "Running",
                instance: {
                    workspaceId: "ws-busy",
                    instanceId: "inst-busy",
                    status: "ready",
                    nvimPid: 43,
                    pluginVersion: "0.1.1",
                    hasUI: true,
                    attachedClients: 1,
                    listenAddr: "127.0.0.1:7779",
                    startedAt: 2_000,
                    reason: "stale startup note",
                },
            }),
        ];
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
            { path: "/api/v1/workspaces", handler: () => ({ body: items }) },
            recentRoute(),
        ]);

        await renderPage(routes(), "/workspaces", { paired: true });
        await waitForCards(3);

        const rows = screen.getAllByTestId("workspace-row");
        const [notStarted, degraded, ready] = rows;
        // No instance row means "opens on demand", not "stopped".
        expect(notStarted?.querySelector(".ws-card__state .dot")).toHaveClass("dot--idle");
        expect(notStarted?.querySelector(".ws-card__state")).toHaveTextContent("Not started · opens on demand");
        expect(notStarted?.querySelector(".ws-card__state")).not.toHaveTextContent("Instance stopped");
        expect(notStarted?.querySelector('[data-testid="workspace-instance-reason"]')).toBeNull();

        const reason = degraded?.querySelector('[data-testid="workspace-instance-reason"]');
        expect(reason).toHaveTextContent("plugin handshake timed out after 1500ms");
        expect(reason).toHaveAttribute("title", "plugin handshake timed out after 1500ms");
        expect(degraded?.querySelector(".ws-card__state")).toHaveTextContent("Instance degraded");

        // A healthy instance keeps its plain label (a stale reason is not news).
        expect(ready?.querySelector(".ws-card__state")).toHaveTextContent("Instance ready");
        expect(ready?.querySelector('[data-testid="workspace-instance-reason"]')).toBeNull();
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
