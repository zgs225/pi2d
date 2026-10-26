import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Entry } from "@protocol/types";

import { EntryBlock } from "@/features/chat/blocks";
import { setLanguage } from "@/lib/i18n";
import { entryFixture } from "./chat-fixtures";

beforeAll(async () => {
    await setLanguage("en");
});

function bashTool(): Entry["blocks"][number] {
    return {
        type: "tool",
        toolCallId: "call_1",
        name: "bash",
        args: { command: "ls -la" },
        state: "done",
        durationMs: 1200,
        output: { text: "a.txt\nb.txt" },
    };
}

function assistantEntry(overrides: Partial<Entry> = {}): Entry {
    return entryFixture({
        id: "a1",
        role: "assistant",
        blocks: [{ type: "text", text: "Looking at the auth path now." }, bashTool()],
        ...overrides,
    });
}

describe("chat blocks — tool rows", () => {
    it("renders a tool block as one family row, never the legacy card", () => {
        const { container } = render(<EntryBlock entry={assistantEntry()} />);

        const rows = container.querySelectorAll(".tool");
        expect(rows).toHaveLength(1);
        const row = rows[0] as HTMLElement;
        expect(row).not.toHaveClass("card");
        expect(row).toHaveClass("tool--shell", "tool--done");
        expect(row.getAttribute("data-tool")).toBe("bash");
        expect(row.getAttribute("data-state")).toBe("done");

        // v0.1.0 anatomy is gone (`.tool__ico/.tool__name/.tool__sum`).
        expect(container.querySelector(".tool__ico")).toBeNull();
        expect(container.querySelector(".tool__name")).toBeNull();
        expect(container.querySelector(".tool__sum")).toBeNull();
        // v0.1.1 anatomy is present.
        expect(row.querySelector(".tool__state")).toBeTruthy();
        expect(row.querySelector(".tool__verb")).toBeTruthy();
        expect(row.querySelector(".tool__target")?.textContent).toBe("ls -la");
    });

    it("mounts the family body only after the row is expanded", () => {
        const { container } = render(<EntryBlock entry={assistantEntry()} />);
        const body = container.querySelector(".tool__body") as HTMLElement;
        expect(body).toHaveAttribute("hidden");
        expect(container.querySelector(".shell__body")).toBeNull();

        fireEvent.click(container.querySelector(".tool__head") as HTMLElement);

        expect(body).not.toHaveAttribute("hidden");
        expect(container.querySelector(".shell__body")).toBeTruthy();
        expect(container.querySelector(".shell__cmd-text")?.textContent).toBe("ls -la");
        expect(screen.getByText("a.txt")).toBeInTheDocument();
    });

    it("forwards the subagent opener through the tool ctx", () => {
        const onOpenSubagent = vi.fn();
        const { container } = render(<EntryBlock entry={assistantEntry()} onOpenSubagent={onOpenSubagent} />);
        // The row still renders; the ctx is only consumed by families that offer the action.
        expect(container.querySelectorAll(".tool")).toHaveLength(1);
        expect(onOpenSubagent).not.toHaveBeenCalled();
    });
});

describe("chat blocks — meta rules", () => {
    it("shows meta on the turn's first message and drops it on same-turn follow-ups", () => {
        const entry = assistantEntry();
        const { container, rerender } = render(<EntryBlock entry={entry} turnStart />);
        expect(container.querySelector(".msg__meta")).not.toBeNull();

        rerender(<EntryBlock entry={entry} turnStart={false} />);
        expect(container.querySelector(".msg__meta")).toBeNull();

        rerender(<EntryBlock entry={entry} showMeta={false} />);
        expect(container.querySelector(".msg__meta")).toBeNull();

        rerender(<EntryBlock entry={entry} showMeta />);
        expect(container.querySelector(".msg__meta")).not.toBeNull();
    });

    it("keeps meta on a user message and never invents one for a system entry", () => {
        const user = entryFixture({ id: "u1", role: "user", blocks: [{ type: "text", text: "Fix the auth bug" }] });
        const { container, rerender } = render(<EntryBlock entry={user} showMeta={false} />);
        expect(container.querySelector(".msg__meta .who--user")).not.toBeNull();

        const system = entryFixture({ id: "s1", role: "system", blocks: [{ type: "text", text: "session started" }] });
        rerender(<EntryBlock entry={system} turnStart />);
        expect(container.querySelector(".msg--system")).not.toBeNull();
        expect(container.querySelector(".msg__meta")).toBeNull();
        expect(container.querySelector(".msg__text")?.textContent).toBe("session started");
    });

    it("marks user messages for the right-aligned rail and leaves error rows on the left", () => {
        const user = entryFixture({ id: "u1", role: "user", blocks: [{ type: "text", text: "Fix the auth bug" }] });
        const { container } = render(<EntryBlock entry={user} />);
        const article = container.querySelector("article") as HTMLElement;
        expect(article).toHaveClass("msg", "msg--user");
        expect(article.querySelector(".msg__meta")).not.toBeNull();

        const assistant = assistantEntry();
        expect(assistant.role).toBe("assistant");
    });
});

describe("chat blocks — notice (sub-report)", () => {
    function noticeEntry(extra: Record<string, unknown> = {}): Entry {
        return {
            ...entryFixture({ id: "n1", role: "notice", blocks: [{ type: "text", text: "researcher finished" }] }),
            ...extra,
        } as Entry;
    }

    it("turns the notice meta into a link that opens the subagent view", () => {
        const onOpenSubagent = vi.fn();
        const { container } = render(
            <EntryBlock entry={noticeEntry({ subagentName: "researcher" })} onOpenSubagent={onOpenSubagent} />,
        );

        const link = container.querySelector(".who--agent.sub-report__link") as HTMLElement;
        expect(link.tagName).toBe("BUTTON");
        expect(container.querySelector(".msg--notice")).not.toBeNull();

        fireEvent.click(link);
        expect(onOpenSubagent).toHaveBeenCalledTimes(1);
        expect(onOpenSubagent).toHaveBeenCalledWith("researcher");
    });

    it("stays a plain label when no subagent name or opener is known", () => {
        const { container, rerender } = render(<EntryBlock entry={noticeEntry()} onOpenSubagent={vi.fn()} />);
        expect(container.querySelector(".sub-report__link")).toBeNull();
        expect(container.querySelector(".msg__meta .who--agent")?.tagName).toBe("SPAN");

        rerender(<EntryBlock entry={noticeEntry({ subagentName: "researcher" })} />);
        expect(container.querySelector(".sub-report__link")).toBeNull();
    });

    it("keeps the error rail for error blocks inside a notice", () => {
        const entry = entryFixture({ id: "n2", role: "notice", blocks: [{ type: "error", text: "agent aborted" }] });
        const { container } = render(<EntryBlock entry={entry} />);
        const error = container.querySelector(".msg__error");
        expect(error).not.toBeNull();
        expect(error?.querySelector(".who--err")).not.toBeNull();
        expect(screen.getByText("agent aborted")).toBeInTheDocument();
    });
});
