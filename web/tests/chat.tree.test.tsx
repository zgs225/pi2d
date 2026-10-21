import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { setLanguage } from "@/lib/i18n";
import { SessionTree } from "@/features/chat/session-tree";
import { sessionFixture, subagentFixture } from "./chat-fixtures";

beforeAll(async () => {
    await setLanguage("en");
});

function renderTree(props: Partial<ComponentProps<typeof SessionTree>> = {}) {
    const onSelectSession = vi.fn();
    const onToggleCollapse = vi.fn();
    const onToggleAll = vi.fn();
    const sessions = props.sessions ?? [
        sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [subagentFixture()] }),
        sessionFixture({ sessionId: "s2", name: "Beta", subagents: [] }),
    ];
    const utils = render(
        <SessionTree
            sessions={sessions}
            selectedId="s1"
            filter=""
            collapsed={{}}
            connected
            onFilter={vi.fn()}
            onToggleCollapse={onToggleCollapse}
            onToggleAll={onToggleAll}
            onSelectSession={onSelectSession}
            onNewSession={vi.fn()}
            onRenameSession={vi.fn()}
            onCloseSession={vi.fn()}
            {...props}
        />,
    );
    return { ...utils, sessions, onSelectSession, onToggleCollapse, onToggleAll };
}

describe("session tree", () => {
    it("selects a session and shows the nested subagent", () => {
        const { onSelectSession } = renderTree();
        fireEvent.click(screen.getByRole("button", { name: "Beta" }));
        expect(onSelectSession).toHaveBeenCalledWith("s2");
        expect(screen.getByText("researcher")).toBeInTheDocument();
        expect(screen.getByText("claude-sonnet-4-5 · low")).toBeInTheDocument();
    });

    it("folds a parent without drawing vertical guides", () => {
        const { onToggleCollapse, rerender, sessions } = renderTree();
        const row = screen.getByRole("button", { name: "Alpha" });
        fireEvent.click(within(row).getByLabelText("Collapse"));
        expect(onToggleCollapse).toHaveBeenCalledWith("s1");

        rerender(
            <SessionTree
                sessions={sessions}
                selectedId="s1"
                filter=""
                collapsed={{ s1: true }}
                onFilter={vi.fn()}
                onToggleCollapse={vi.fn()}
                onToggleAll={vi.fn()}
                onSelectSession={vi.fn()}
                onNewSession={vi.fn()}
                onRenameSession={vi.fn()}
                onCloseSession={vi.fn()}
            />,
        );
        expect(screen.queryByText("researcher")).not.toBeInTheDocument();
    });

    it("filters sessions by name and toggles all rows", () => {
        const { onToggleAll } = renderTree({ filter: "Beta" });
        expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
        expect(screen.getByText("Beta")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Collapse or expand all" }));
        expect(onToggleAll).toHaveBeenCalledTimes(1);
    });
});
