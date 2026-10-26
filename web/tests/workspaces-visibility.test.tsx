import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockApi } from "./helpers/api-mock";
import { renderPage } from "./helpers/render-page";

import {
    countSecondary,
    partitionWorkspaces,
    readShowAll,
    reasonLabelKey,
    SHOW_ALL_STORAGE_KEY,
    writeShowAll,
} from "@/features/workspaces/visibility";
import { setLanguage } from "@/lib/i18n";
import type { WorkspaceInfo, WorkspaceVisibilityReason } from "@/lib/protocol";
import { WorkspacesPage } from "@/pages/workspaces";

const infoBody = {
    v: 1,
    daemonId: "daemon-1",
    machineId: "machine-1",
    platform: "linux",
    capabilities: ["read", "steer"],
    limits: { maxInstances: 5 },
};

function workspace(
    overrides: Partial<WorkspaceInfo> & Pick<WorkspaceInfo, "workspaceId" | "cwd" | "name">,
): WorkspaceInfo {
    return {
        trusted: true,
        exists: true,
        sessionCount: 0,
        liveCount: 0,
        lastActiveAt: 0,
        instance: null,
        visibility: "default",
        ...overrides,
    };
}

function secondary(
    workspaceId: string,
    name: string,
    reason: WorkspaceVisibilityReason,
    overrides: Partial<WorkspaceInfo> = {},
): WorkspaceInfo {
    return workspace({
        workspaceId,
        cwd: `/work/${name.toLowerCase()}`,
        name,
        visibility: "secondary",
        visibilityReason: reason,
        ...overrides,
    });
}

const primary = workspace({ workspaceId: "ws-a", cwd: "/work/alpha", name: "Alpha", lastActiveAt: 3_000 });
const ghost = secondary("ws-g", "Ghost", "ghost", { exists: false, lastActiveAt: 2_000 });
const hidden = secondary("ws-h", "Hidden", "hidden", { hidden: true, lastActiveAt: 1_000 });

function routes() {
    return [{ path: "/workspaces", component: WorkspacesPage }];
}

function serve(items: WorkspaceInfo[]) {
    return mockApi([
        { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
        { path: "/api/v1/workspaces", handler: () => ({ body: items }) },
    ]);
}

/** Names are also repeated in the activity column; assert on the grid only. */
async function waitForCards(count: number) {
    await waitFor(() => expect(screen.getAllByTestId("workspace-row")).toHaveLength(count));
}

function grid(): HTMLElement {
    const node = document.querySelector<HTMLElement>(".ws-grid");
    if (!node) throw new Error("no workspace grid rendered");
    return node;
}

beforeEach(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("partitionWorkspaces", () => {
    it("splits default rows from secondary rows without dropping any", () => {
        const legacyHidden = workspace({ workspaceId: "ws-l", cwd: "/work/legacy", name: "Legacy", hidden: true });
        delete legacyHidden.visibility;
        const list = [primary, ghost, hidden, legacyHidden];

        const { primary: shown, secondary: collapsed } = partitionWorkspaces(list);
        expect(shown.map((item) => item.workspaceId)).toEqual(["ws-a"]);
        // Legacy daemons omit `visibility`; `hidden: true` still means secondary.
        expect(collapsed.map((item) => item.workspaceId)).toEqual(["ws-g", "ws-h", "ws-l"]);
        expect(partitionWorkspaces(list, true)).toEqual({ primary: shown, secondary: collapsed });
        expect(countSecondary(list)).toBe(3);
        expect(countSecondary([primary])).toBe(0);
    });

    it("maps every reason to a badge i18n key", () => {
        expect(reasonLabelKey(primary)).toBeNull();
        expect(reasonLabelKey(ghost)).toBe("workspaces.reason.ghost");
        expect(reasonLabelKey(hidden)).toBe("workspaces.reason.hidden");
        expect(reasonLabelKey(secondary("ws-t", "Tmp", "temp"))).toBe("workspaces.reason.temp");
        expect(reasonLabelKey(secondary("ws-o", "Out", "outside-roots"))).toBe("workspaces.reason.outside-roots");
        expect(reasonLabelKey(secondary("ws-s", "Stale", "stale"))).toBe("workspaces.reason.stale");
        // Pre-classification daemon: hidden infers the reason.
        const legacy = workspace({ workspaceId: "ws-x", cwd: "/work/x", name: "X", hidden: true });
        expect(reasonLabelKey(legacy)).toBe("workspaces.reason.hidden");
    });
});

describe("show-all persistence", () => {
    it("defaults to off and round-trips through localStorage", () => {
        expect(readShowAll()).toBe(false);
        writeShowAll(true);
        expect(localStorage.getItem(SHOW_ALL_STORAGE_KEY)).toBe("1");
        expect(readShowAll()).toBe(true);
        writeShowAll(false);
        expect(readShowAll()).toBe(false);
    });

    it("treats an unexpected stored value as off", () => {
        localStorage.setItem(SHOW_ALL_STORAGE_KEY, "yes");
        expect(readShowAll()).toBe(false);
    });
});

describe("WorkspacesPage secondary rows", () => {
    it("lists only primary rows by default and counts the hidden ones", async () => {
        serve([primary, ghost, hidden]);
        const { container } = await renderPage(routes(), "/workspaces");

        await waitForCards(1);
        expect(within(grid()).getByText("Alpha")).toBeInTheDocument();
        expect(screen.queryByText("Ghost")).not.toBeInTheDocument();
        expect(screen.queryByText("Hidden")).not.toBeInTheDocument();

        const toggle = await screen.findByTestId("workspaces-show-all");
        expect(toggle).toHaveTextContent("Show 2 hidden");
        expect(toggle).toHaveAttribute("aria-pressed", "false");
        // The toggle lives in the collapsed strip under the grid, outside the head,
        // and is never a second primary (H1).
        expect(toggle.closest(".ws-hidden-bar")).not.toBeNull();
        expect(toggle).not.toHaveClass("btn--primary");
        expect(container.querySelectorAll('[data-testid="workspace-row"]')).toHaveLength(1);
        expect(container.querySelectorAll(".btn--primary")).toHaveLength(1);
        expect(readShowAll()).toBe(false);
    });

    it("reveals dimmed secondary rows with a reason badge on toggle", async () => {
        serve([primary, ghost, hidden]);
        await renderPage(routes(), "/workspaces");
        await waitForCards(1);

        fireEvent.click(screen.getByTestId("workspaces-show-all"));

        expect(await within(grid()).findByText("Ghost")).toBeInTheDocument();
        expect(within(grid()).getByText("Hidden")).toBeInTheDocument();

        const rows = screen.getAllByTestId("workspace-row");
        expect(rows.map((row) => row.getAttribute("data-visibility"))).toEqual(["default", "secondary", "secondary"]);
        const ghostRow = rows.find((row) => row.getAttribute("data-workspace-id") === "ws-g");
        expect(ghostRow).toHaveAttribute("data-visibility-reason", "ghost");
        // Dimming is a class (no inline styles on the page).
        expect(ghostRow).toHaveClass("ws-card--secondary");
        expect(ghostRow?.querySelector('[data-testid="workspace-reason"]')).toHaveTextContent("missing");
        // The card stays a link to the chat UI even when it is secondary.
        expect(ghostRow?.getAttribute("href")).toBe("/chat?workspace=ws-g");

        const toggle = screen.getByTestId("workspaces-show-all");
        expect(toggle).toHaveTextContent("Hide 2 hidden");
        expect(toggle).toHaveAttribute("aria-pressed", "true");
        await waitFor(() => expect(localStorage.getItem(SHOW_ALL_STORAGE_KEY)).toBe("1"));

        fireEvent.click(toggle);
        await waitFor(() => expect(screen.queryByText("Ghost")).not.toBeInTheDocument());
        expect(localStorage.getItem(SHOW_ALL_STORAGE_KEY)).toBe("0");
    });

    it("honours a persisted toggle on mount", async () => {
        serve([primary, ghost, hidden]);
        await renderPage(routes(), "/workspaces", { storage: { [SHOW_ALL_STORAGE_KEY]: "1" } });

        await waitForCards(3);
        expect(within(grid()).getByText("Alpha")).toBeInTheDocument();
        expect(within(grid()).getByText("Ghost")).toBeInTheDocument();
        expect(within(grid()).getByText("Hidden")).toBeInTheDocument();
    });

    it("offers the toggle from the empty state when every row is secondary", async () => {
        serve([ghost, hidden]);
        await renderPage(routes(), "/workspaces");

        expect(await screen.findByText("All workspaces are hidden")).toBeInTheDocument();
        fireEvent.click(screen.getByTestId("workspaces-show-all"));
        await waitForCards(2);
        expect(within(grid()).getByText("Ghost")).toBeInTheDocument();
    });
});
