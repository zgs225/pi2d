import type { Entry, SessionState } from "@protocol/types";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SubagentView, synthesizeSubagentTimeline } from "@/features/chat/subagent-view";
import { emptySessionState } from "@/features/chat/session-state";
import i18n, { setLanguage } from "@/lib/i18n";

import { entryFixture, sessionFixture, subagentFixture } from "./chat-fixtures";

// jsdom + a full child view is heavy; keep the suite resilient under load.
vi.setConfig({ testTimeout: 20_000 });

beforeAll(async () => {
    await setLanguage("en");
});

const t = (key: string, params?: Record<string, unknown>) =>
    params ? i18n.t(key, params) : i18n.t(key);

function session(overrides: Partial<SessionState> = {}): SessionState {
    return {
        ...sessionFixture(),
        ...emptySessionState({ sessionId: "s1", workspaceId: "w1" }),
        ...overrides,
    } as SessionState;
}

/** Parent transcript: a subagent tool call, an unrelated tool call, a sub-report notice, plain text. */
function parentEntries(): Entry[] {
    // Realistic epoch-ms timestamps: the synthesized task (`createdAt`) sorts before these.
    const base = Date.now() - 20_000;
    return [
        entryFixture({ id: "u1", role: "user", ts: base, blocks: [{ type: "text", text: "Parent question" }] }),
        entryFixture({
            id: "a1",
            role: "assistant",
            ts: base + 1_000,
            blocks: [
                { type: "text", text: "Parent narration" },
                {
                    type: "tool",
                    toolCallId: "c1",
                    name: "task",
                    args: { agent: "researcher", task: "read the auth flow" },
                    state: "done",
                    output: { text: "done" },
                },
                { type: "tool", toolCallId: "c2", name: "bash", args: { command: "ls" }, state: "done" },
            ],
        }),
        entryFixture({
            id: "n1",
            role: "notice",
            ts: base + 2_000,
            blocks: [{ type: "text", text: "researcher finished: 3 files changed" }],
        }),
        entryFixture({ id: "a2", role: "assistant", ts: base + 3_000, blocks: [{ type: "text", text: "Unrelated text" }] }),
    ];
}

function renderView(overrides: Partial<Parameters<typeof SubagentView>[0]> = {}) {
    const onBack = vi.fn();
    const onOpenTray = vi.fn();
    const onSteer = vi.fn();
    const props: Parameters<typeof SubagentView>[0] = {
        session: session(),
        subagent: subagentFixture({ createdAt: Date.now() - 30_000 }),
        entries: parentEntries(),
        onBack,
        onOpenTray,
        onOpenTree: vi.fn(),
        onSteer,
        chips: {
            planDone: 1,
            planTotal: 3,
            taskCount: 2,
            runningTasks: 0,
            trayTab: "todo",
            trayOpen: false,
            onToggle: vi.fn(),
        },
        composer: { models: [], connected: true, paired: true },
        ...overrides,
    };
    const utils = render(<SubagentView {...props} />);
    return { ...utils, onBack, onOpenTray, onSteer, props };
}

describe("subagent child view header", () => {
    it("owns `.stream-head--sub`: back button, dot, name, chips, menu", () => {
        renderView();
        const head = screen.getByTestId("subagent-view").querySelector(".stream-head--sub") as HTMLElement;

        // `← 父级`
        const back = head.querySelector(".sub-back") as HTMLButtonElement;
        expect(back).toHaveTextContent(t("chat.subview.back"));
        expect(back).toHaveAttribute("aria-label", t("chat.subview.backTo", { name: "researcher" }));
        expect(head.querySelector(".stream-title .dot")).not.toBeNull();
        expect(head.querySelector(".stream-name")).toHaveTextContent("researcher");
        expect(head.querySelector("[data-testid='head-chips']")).not.toBeNull();
        expect(head.querySelector(".sub-more")).toHaveAttribute("aria-haspopup", "menu");
    });

    it("never writes status text, model, elapsed or thinking back into the title (CHG-26-19)", () => {
        renderView();
        const head = screen.getByTestId("subagent-view").querySelector(".stream-head--sub") as HTMLElement;

        expect(head.querySelector(".sub-state")).toBeNull();
        expect(head.querySelector(".sub-facts")).toBeNull();
        expect(head.querySelector(".sub-fact")).toBeNull();
        expect(head.querySelector(".telemetry__state")).toBeNull();
        expect(head.querySelector(".ctx-ring")).toBeNull();

        const text = head.textContent ?? "";
        expect(text).not.toMatch(/Running|Took|elapsed/i);
        expect(text).not.toContain("claude-sonnet-4-5");
        expect(text).not.toContain("low");
    });

    it("goes back through `← 父级` and the `…` menu", () => {
        const { container, onBack, onOpenTray, onSteer } = renderView();

        fireEvent.click(container.querySelector(".sub-back") as HTMLElement);
        expect(onBack).toHaveBeenCalledTimes(1);

        const more = container.querySelector(".sub-more") as HTMLButtonElement;
        fireEvent.click(more);
        expect(more).toHaveAttribute("aria-expanded", "true");
        const items = [...container.querySelectorAll('[role="menuitem"]')];
        expect(items).toHaveLength(3);
        expect(items[0]).toHaveTextContent(t("chat.subview.openTray"));
        expect(items[1]).toHaveTextContent(t("chat.backToParent"));
        expect(items[2]).toHaveTextContent(t("chat.subview.copyId"));
        fireEvent.click(items[0] as HTMLElement);
        expect(onOpenTray).toHaveBeenCalledTimes(1);
        expect(container.querySelector('[role="menu"]')).toBeNull();

        // Esc closes the menu only — the page keeps its own child-view Esc.
        fireEvent.click(more);
        fireEvent.keyDown(document, { key: "Escape" });
        expect(container.querySelector('[role="menu"]')).toBeNull();
        expect(more).toHaveAttribute("aria-expanded", "false");
        expect(onBack).toHaveBeenCalledTimes(1);
        expect(onSteer).not.toHaveBeenCalled();
    });
});

describe("subagent synthesized timeline", () => {
    it("starts with the task as a user message and keeps only the entries that reference the subagent", () => {
        const { container } = renderView();
        const items = [...container.querySelectorAll(".stream-item")];

        expect(items).toHaveLength(3);
        expect(items[0]?.querySelector(".msg--user")).not.toBeNull();
        expect(items[0]).toHaveTextContent("Research the auth flow");

        // The `task` tool block is kept, the sibling `bash` call is not.
        expect(screen.getByText("task")).not.toBeNull();
        expect(screen.queryByText("bash")).toBeNull();
        // Parent narration and unrelated later text stay in the parent stream.
        expect(screen.queryByText("Parent narration")).toBeNull();
        expect(screen.queryByText("Unrelated text")).toBeNull();
        expect(screen.queryByText("Parent question")).toBeNull();
        // The sub-report notice is the third item.
        expect(items[2]).toHaveTextContent("researcher finished: 3 files changed");
    });

    it("synthesizes nothing but the task when no parent entry names the subagent", () => {
        const agent = subagentFixture();
        const timeline = synthesizeSubagentTimeline(agent, [
            entryFixture({ id: "x1", role: "assistant", blocks: [{ type: "text", text: "unrelated" }] }),
        ]);
        expect(timeline).toHaveLength(1);
        expect(timeline[0]?.role).toBe("user");
        expect(timeline[0]?.blocks[0]).toEqual({ type: "text", text: "Research the auth flow" });
    });

    it("falls back to the empty state with the retained-message explanation", () => {
        const { container } = renderView({
            subagent: subagentFixture({ task: undefined }),
            entries: [entryFixture({ id: "x1", blocks: [{ type: "text", text: "unrelated" }] })],
        });
        expect(container.querySelector(".stream-item")).toBeNull();
        const empty = container.querySelector(".empty");
        expect(empty).not.toBeNull();
        expect(empty).toHaveTextContent(t("chat.subview.emptyTitle"));
        expect(empty).toHaveTextContent(t("chat.subview.emptyText"));
    });
});

describe("subagent scope + steer composer", () => {
    it("states the session scope of TODO / Tasks instead of faking a per-subagent filter", () => {
        renderView();
        const note = screen.getByTestId("sub-scope");
        expect(note).toHaveTextContent(t("chat.subview.scopeNote"));
        expect(note).toHaveClass("faint");
    });

    it("turns the composer into steer mode: no attach / model / thinking, steer placeholder", () => {
        const { container } = renderView();
        const composer = container.querySelector(".composer");
        expect(composer).toHaveClass("is-sub");
        expect(container.querySelector(".sub-note")).toHaveTextContent(t("chat.subview.steerNote"));

        const textarea = screen.getByTestId("composer-input");
        expect(textarea).toHaveAttribute("placeholder", t("chat.steerPlaceholder"));
        expect(textarea).toHaveAttribute("aria-label", t("chat.steer"));
        expect(textarea).not.toBeDisabled();
    });

    it("disables steering once the subagent has ended", () => {
        renderView({ subagent: subagentFixture({ status: "completed", live: false }) });
        expect(screen.getByTestId("composer-input")).toBeDisabled();
        expect(screen.getByTestId("composer-send")).toBeDisabled();
        expect(document.querySelector(".sub-note")).toHaveTextContent(t("chat.subview.endedNote"));
    });
});
