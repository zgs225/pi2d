import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SessionTree } from "@/features/chat/session-tree";
import { setLanguage } from "@/lib/i18n";
import type { SessionState } from "@/lib/protocol";

import { sessionFixture, subagentFixture } from "./chat-fixtures";

beforeAll(async () => {
    await setLanguage("en");
});

/** The title of the row for `sessionId` (`null` when the row is absent). */
function rowTitleText(container: HTMLElement, sessionId: string): string | null {
    const row = container.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
    return row?.querySelector<HTMLElement>(".t-name")?.textContent?.trim() ?? null;
}

function renderTree(overrides: Partial<ComponentProps<typeof SessionTree>> = {}) {
    const sessions = overrides.sessions ?? [];
    return render(
        <SessionTree
            sessions={sessions}
            workspaces={[
                {
                    workspaceId: "W1",
                    cwd: "/work/w1",
                    name: "W1",
                    trusted: true,
                    exists: true,
                    sessionCount: sessions.length,
                    liveCount: 0,
                    lastActiveAt: 0,
                    instance: null,
                },
            ]}
            activeWorkspaceId="W1"
            selectedId={null}
            activeSubagentId={null}
            filter=""
            collapsed={{}}
            activeOnly={false}
            showHidden={false}
            connected
            creating={false}
            onFilter={vi.fn()}
            onToggleCollapse={vi.fn()}
            onToggleAll={vi.fn()}
            onToggleActiveOnly={vi.fn()}
            onToggleShowHidden={vi.fn()}
            onSelectSession={vi.fn()}
            onSelectWorkspace={vi.fn()}
            onSelectSubagent={vi.fn()}
            onNewSession={vi.fn()}
            onRenameSession={vi.fn()}
            onCloseSession={vi.fn()}
            onDispatchSubagent={vi.fn()}
            onRenameSubagent={vi.fn()}
            {...overrides}
        />,
    );
}

describe("session list titles (pi2.nvim parity)", () => {
    it("renders (unnamed) for a session without a name and never the session id", () => {
        const sessionId = "9f8c1d2e-0000-4000-8000-aaaaaaaaaaaa";
        const { container } = renderTree({
            sessions: [sessionFixture({ sessionId, name: null, firstMessage: null })],
        });

        expect(rowTitleText(container, sessionId)).toBe("(unnamed)");
        expect(container.textContent ?? "").not.toContain(sessionId);
        // Identity still rides on the DOM attribute (routing/select handlers).
        expect(container.querySelector(`[data-session-id="${sessionId}"]`)).not.toBeNull();
    });

    it("marks the placeholder so it renders as the muted, non-animated state", () => {
        const sessionId = "s-unnamed";
        const { container } = renderTree({
            sessions: [sessionFixture({ sessionId, name: null, firstMessage: null })],
        });
        const name = container.querySelector<HTMLElement>(`[data-session-id="${sessionId}"] .t-name`);
        expect(name?.classList.contains("is-unnamed")).toBe(true);
        expect(name?.classList.contains("is-generating")).toBe(false);
    });

    it("prefers the first user message over the placeholder", () => {
        const sessionId = "s-first";
        const { container } = renderTree({
            sessions: [sessionFixture({ sessionId, name: null, firstMessage: "Fix the auth bug" })],
        });
        expect(rowTitleText(container, sessionId)).toBe("Fix the auth bug");
    });

    it("keeps (unnamed) and prefixes the braille spinner while a title is generated", () => {
        const sessionId = "s-generating";
        // The plugin's `pi-title` status is not on the wire yet, so the flag is
        // injected here: the row must already react the way pi2.nvim does.
        const session = {
            ...sessionFixture({ sessionId, name: null, firstMessage: "Fix the auth bug" }),
            titleGenerating: true,
        } as SessionState;
        const { container } = renderTree({ sessions: [session] });

        const row = container.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
        // Spinner is a prefix, the name stays the placeholder (no first message).
        expect(row?.querySelector(".t-spinner")).not.toBeNull();
        expect(rowTitleText(container, sessionId)).toBe("(unnamed)");
        expect(row?.querySelector(".t-name")?.classList.contains("is-generating")).toBe(true);
    });

    it("keeps the real name when there is one", () => {
        const { container } = renderTree({
            sessions: [sessionFixture({ sessionId: "s-named", name: "Alpha", subagents: [] })],
        });
        expect(rowTitleText(container, "s-named")).toBe("Alpha");
    });

    it("labels a nameless sub-session by its task prompt, not its id", () => {
        const subagent = subagentFixture({ id: "sub-uuid-1234", name: undefined, task: "Survey the plugin bridge" });
        const { container } = renderTree({
            sessions: [sessionFixture({ sessionId: "s-parent", name: "Alpha", subagents: [subagent] })],
        });

        const sub = container.querySelector<HTMLElement>('[data-subagent-id="sub-uuid-1234"] .t-name');
        expect(sub?.textContent?.trim()).toBe("Survey the plugin bridge");
        expect(container.textContent ?? "").not.toContain("sub-uuid-1234");
    });

    it("falls back to sub-session when the manifest carries no name or task", () => {
        const subagent = subagentFixture({ id: "sub-empty", name: undefined, task: undefined });
        const { container } = renderTree({
            sessions: [sessionFixture({ sessionId: "s-parent", name: "Alpha", subagents: [subagent] })],
        });
        expect(screen.getByText("sub-session")).toBeTruthy();
        expect(container.textContent ?? "").not.toContain("sub-empty");
    });
});
