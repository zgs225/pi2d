import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { WorkspaceInfo } from "@/lib/protocol";

import { setLanguage } from "@/lib/i18n";
import { WorkspaceSwitch } from "@/features/chat/workspace-switch";
import { WORKSPACE_RECENCY_KEY } from "@/features/chat/workspace-order";

beforeAll(async () => {
    await setLanguage("en");
});

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
        ...overrides,
    };
}

const alpha = workspace({ workspaceId: "WA", cwd: "/work/alpha", name: "Alpha", lastActiveAt: 100, sessionCount: 4 });
const bravo = workspace({ workspaceId: "WB", cwd: "/srv/bravo", name: "Bravo", lastActiveAt: 300, sessionCount: 2 });
const charlie = workspace({ workspaceId: "WC", cwd: "/work/charlie", name: "Charlie", lastActiveAt: 200 });

/** The picker with live open state, so open/close paths are exercised. */
function Harness({
    workspaces = [alpha, bravo, charlie],
    activeWorkspaceId = "WC",
    initiallyOpen = true,
    onSelect = vi.fn(),
}: {
    workspaces?: WorkspaceInfo[];
    activeWorkspaceId?: string | null;
    initiallyOpen?: boolean;
    onSelect?: (workspaceId: string) => void;
}) {
    const [open, setOpen] = useState(initiallyOpen);
    return (
        <WorkspaceSwitch
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            sessionCount={7}
            open={open}
            onOpenChange={setOpen}
            onSelect={onSelect}
        />
    );
}

function rowIds(): string[] {
    return screen
        .getAllByRole("option")
        .map((element) => element.getAttribute("data-workspace-id") ?? "");
}

describe("WorkspaceSwitch", () => {
    it("lists workspaces most-recently-used first", () => {
        render(<Harness />);
        expect(rowIds()).toEqual(["WB", "WC", "WA"]);
        // The active row is selected, and the trigger shows the live count.
        expect(screen.getByRole("option", { selected: true })).toHaveAttribute("data-workspace-id", "WC");
        expect(screen.getByTestId("ws-switch")).toHaveTextContent("Charlie");
        expect(screen.getByTestId("ws-switch")).toHaveTextContent("7");
    });

    it("puts a browser-locally used workspace on top", () => {
        localStorage.setItem(WORKSPACE_RECENCY_KEY, JSON.stringify({ WA: 5_000 }));
        render(<Harness />);
        expect(rowIds()).toEqual(["WA", "WB", "WC"]);
    });

    it("filters as the user types and reports no match", () => {
        render(<Harness />);
        const search = screen.getByTestId("ws-menu-search");

        fireEvent.change(search, { target: { value: "char" } });
        expect(rowIds()).toEqual(["WC"]);

        fireEvent.change(search, { target: { value: "zzz" } });
        expect(screen.queryAllByRole("option")).toEqual([]);
        expect(screen.getByTestId("ws-menu-empty")).toHaveTextContent("zzz");

        // The clear button empties the field and keeps focus in the picker.
        fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
        expect(rowIds()).toEqual(["WB", "WC", "WA"]);
        expect(search).toHaveValue("");
    });

    it("selects the first match with Enter from the search field", () => {
        const onSelect = vi.fn();
        render(<Harness onSelect={onSelect} />);
        const search = screen.getByTestId("ws-menu-search");

        fireEvent.change(search, { target: { value: "bravo" } });
        fireEvent.keyDown(search, { key: "Enter" });

        expect(onSelect).toHaveBeenCalledWith("WB");
        expect(screen.queryAllByRole("option")).toEqual([]);
    });

    it("moves focus with the arrow keys and closes on Escape", async () => {
        render(<Harness />);
        const search = screen.getByTestId("ws-menu-search");
        await waitFor(() => expect(search).toHaveFocus());

        fireEvent.keyDown(search, { key: "ArrowDown" });
        expect(screen.getByRole("option", { name: /Bravo/ })).toHaveFocus();
        fireEvent.keyDown(search, { key: "ArrowDown" });
        expect(screen.getByRole("option", { name: /Charlie/ })).toHaveFocus();
        fireEvent.keyDown(search, { key: "ArrowUp" });
        expect(screen.getByRole("option", { name: /Bravo/ })).toHaveFocus();
        fireEvent.keyDown(search, { key: "End" });
        expect(screen.getByRole("option", { name: /Alpha/ })).toHaveFocus();

        fireEvent.keyDown(search, { key: "Escape" });
        expect(screen.queryAllByRole("option")).toEqual([]);
        await waitFor(() => expect(screen.getByTestId("ws-switch")).toHaveFocus());
    });

    it("selects a clicked row and closes; clicking the active row only closes", () => {
        const onSelect = vi.fn();
        render(<Harness onSelect={onSelect} />);

        fireEvent.click(screen.getByRole("option", { name: /Alpha/ }));
        expect(onSelect).toHaveBeenCalledWith("WA");
        expect(screen.queryAllByRole("option")).toEqual([]);

        fireEvent.click(screen.getByTestId("ws-switch"));
        fireEvent.click(screen.getByRole("option", { selected: true }));
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(screen.queryAllByRole("option")).toEqual([]);
    });

    it("disables the trigger when the daemon reports no workspaces", () => {
        render(<Harness workspaces={[]} activeWorkspaceId={null} initiallyOpen={false} />);
        const trigger = screen.getByTestId("ws-switch");
        expect(trigger).toBeDisabled();
        expect(trigger).toHaveTextContent("No workspaces yet");
    });
});
