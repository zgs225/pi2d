import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { setLanguage } from "@/lib/i18n";
import { MessageStream } from "@/features/chat/message-stream";
import { fullStreamSession } from "./chat-fixtures";

beforeAll(async () => {
    await setLanguage("en");
});

function renderStream() {
    const session = fullStreamSession();
    const utils = render(
        <MessageStream
            session={session}
            entries={session.entries}
            hasMore={false}
            loadingOlder={false}
            error={null}
            onLoadOlder={vi.fn()}
            onRetry={vi.fn()}
            onOpenSubagent={vi.fn()}
        />,
    );
    return { ...utils, session };
}

describe("chat message stream", () => {
    it("renders user, assistant, thinking, tool, todo, batch and error blocks from a snapshot", () => {
        renderStream();

        expect(screen.getByText("Fix the auth bug")).toBeInTheDocument();
        expect(screen.getByText("Fix the auth bug").closest("article")).toHaveClass("msg--user");
        expect(screen.getByText("Looking at the auth path now.")).toBeInTheDocument();
        expect(screen.getByText("Check every caller before editing")).toBeInTheDocument();
        expect(screen.getByText("bash")).toBeInTheDocument();
        expect(screen.getByText("edit")).toBeInTheDocument();

        expect(screen.getByText("Todo · 1/3")).toBeInTheDocument();
        expect(screen.getByText("Applying the fix")).toBeInTheDocument();
        expect(screen.getByText("Apply fix")).toBeInTheDocument();
        expect(screen.getByText("Batch dispatch · 2/3")).toBeInTheDocument();
        expect(screen.getByText("writer")).toBeInTheDocument();

        expect(screen.getByText("agent aborted")).toBeInTheDocument();
        expect(screen.getByText("agent aborted").closest(".msg__error")).not.toBeNull();
    });

    it("expands a tool card to show output and an edit diff", () => {
        renderStream();

        const bashButton = screen.getByText("bash").closest("button");
        expect(bashButton).not.toBeNull();
        fireEvent.click(bashButton!);
        expect(screen.getByText(/a\.txt/)).toBeInTheDocument();
        expect(screen.getByText(/"command": "ls -la"/)).toBeInTheDocument();

        const editButton = screen.getByText("edit").closest("button");
        fireEvent.click(editButton!);
        expect(screen.getByText("permission denied")).toBeInTheDocument();
        expect(screen.getAllByText("src/auth.ts").length).toBeGreaterThan(0);
    });

    it("shows a streaming caret only for an unfinished assistant entry", () => {
        const session = fullStreamSession();
        session.entries = [
            {
                id: "a-live",
                role: "assistant",
                ts: Date.now(),
                done: false,
                blocks: [{ type: "text", text: "partial answer" }],
            },
        ];
        render(
            <MessageStream
                session={session}
                entries={session.entries}
                hasMore={false}
                loadingOlder={false}
                error={null}
                onLoadOlder={vi.fn()}
                onRetry={vi.fn()}
                onOpenSubagent={vi.fn()}
            />,
        );
        expect(screen.getByText("partial answer")).toHaveClass("streaming");
    });
});
