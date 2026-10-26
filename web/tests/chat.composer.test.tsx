import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { Composer, type ComposerProps } from "@/features/chat/composer";
import { setLanguage } from "@/lib/i18n";
import { sessionFixture } from "./chat-fixtures";

beforeAll(async () => {
    await setLanguage("en");
});

const MODELS = [
    {
        provider: "anthropic",
        models: [{ id: "claude-sonnet-4-5" }, { id: "claude-haiku-4-5" }],
    },
];

function renderComposer(session = sessionFixture(), overrides: Partial<ComposerProps> = {}) {
    const onSend = vi.fn();
    const onAbort = vi.fn();
    const onRemoveQueue = vi.fn();
    const onSetSteer = vi.fn();
    const onSetModel = vi.fn();
    const onSetThinking = vi.fn();
    const utils = render(
        <Composer
            session={session}
            models={MODELS}
            connected
            onSend={onSend}
            onAbort={onAbort}
            onRemoveQueue={onRemoveQueue}
            onSetSteer={onSetSteer}
            onSetModel={onSetModel}
            onSetThinking={onSetThinking}
            {...overrides}
        />,
    );
    return { ...utils, onSend, onAbort, onRemoveQueue, onSetSteer, onSetModel, onSetThinking };
}

describe("composer", () => {
    it("exposes the stable Playwright selectors", () => {
        renderComposer(sessionFixture({ status: "busy" }));
        expect(screen.getByTestId("composer-input")).toHaveClass("composer__ta");
        // Busy: the single slot is the abort button, so `composer-send` is absent.
        expect(screen.queryByTestId("composer-send")).not.toBeInTheDocument();
        expect(screen.getByTestId("composer-abort")).toHaveClass("composer__send");
        expect(screen.getByTestId("composer-model")).toHaveAttribute("aria-label", "Model");
        expect(screen.getByTestId("composer-thinking")).toHaveAttribute("aria-label", "Thinking level");
    });

    it("keeps one circular send slot while the session is idle", () => {
        renderComposer(sessionFixture({ status: "idle" }));
        const send = screen.getByTestId("composer-send");
        expect(send).toHaveClass("composer__send");
        expect(send).not.toHaveClass("is-busy");
        expect(screen.queryByTestId("composer-abort")).not.toBeInTheDocument();
        // The text label is screen-reader only; the button itself is an icon.
        expect(screen.getByRole("button", { name: "Send" })).toBe(send);
    });

    it("sends on Enter and keeps Shift+Enter for a newline", () => {
        const { onSend } = renderComposer(sessionFixture({ status: "idle" }));
        const textarea = screen.getByTestId("composer-input");

        fireEvent.change(textarea, { target: { value: "hello" } });
        fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
        expect(onSend).not.toHaveBeenCalled();

        fireEvent.keyDown(textarea, { key: "Enter" });
        // An idle session sends a plain prompt (no `follow_up` / `steer` mode).
        expect(onSend).toHaveBeenCalledWith("hello", [], undefined);
        expect(textarea).toHaveValue("");
    });

    it("queues an Enter send as a follow-up while the session is busy", () => {
        const { onSend } = renderComposer(sessionFixture({ status: "busy" }));
        const textarea = screen.getByTestId("composer-input");
        fireEvent.change(textarea, { target: { value: "next step" } });
        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(onSend).toHaveBeenCalledWith("next step", [], "follow_up");
    });

    it("turns the send slot into a single red abort circle while busy", () => {
        const { onAbort } = renderComposer(sessionFixture({ status: "busy" }));

        // No separate steer / abort text buttons any more (CHG-2026-10-26-16).
        expect(screen.queryByTestId("composer-steer")).not.toBeInTheDocument();
        const abort = screen.getByTestId("composer-abort");
        expect(abort).toHaveClass("composer__send");
        expect(abort).toHaveClass("is-busy");
        expect(screen.queryAllByTestId("composer-send")).toHaveLength(0);

        fireEvent.click(abort);
        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    it("never renders queue bodies, per-item steer toggles or delete buttons", () => {
        const session = sessionFixture({
            status: "idle",
            queue: [
                { id: "q1", text: "later please", steer: false },
                { id: "q2", text: "and this one", steer: true },
            ],
        });
        renderComposer(session);

        expect(screen.queryByText("later please")).not.toBeInTheDocument();
        expect(screen.queryByText("and this one")).not.toBeInTheDocument();
        expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Remove queued message" })).not.toBeInTheDocument();
    });

    it("reports counts in a role=status bar, not the message text", () => {
        const session = sessionFixture({
            status: "busy",
            queue: [
                { id: "q1", text: "later please", steer: false },
                { id: "q2", text: "and this one", steer: true },
            ],
        });
        renderComposer(session);

        const bar = screen.getByTestId("composer-queue");
        expect(bar).toHaveAttribute("role", "status");
        expect(bar).toHaveAttribute("aria-live", "polite");
        expect(bar).not.toHaveClass("is-empty");
        expect(bar).toHaveTextContent(/2 pending/);
        expect(bar).toHaveTextContent(/1 inserting now/);
        // "inserting now" supersedes the after-turn hint.
        expect(bar).not.toHaveTextContent(/Sends after this turn/);
    });

    it("falls back to the after-turn hint and hides the bar when the queue is empty", () => {
        const session = sessionFixture({
            status: "busy",
            queue: [{ id: "q1", text: "later please", steer: false }],
        });
        const { rerender } = renderComposer(session);
        expect(screen.getByTestId("composer-queue")).toHaveTextContent(/1 pending/);
        expect(screen.getByTestId("composer-queue")).toHaveTextContent(/Sends after this turn/);

        rerender(
            <Composer
                session={sessionFixture({ status: "busy", queue: [] })}
                models={MODELS}
                connected
                onSend={vi.fn()}
                onAbort={vi.fn()}
                onRemoveQueue={vi.fn()}
                onSetSteer={vi.fn()}
                onSetModel={vi.fn()}
                onSetThinking={vi.fn()}
            />,
        );
        const empty = screen.getByTestId("composer-queue");
        expect(empty).toHaveClass("is-empty");
        expect(empty).toHaveTextContent(/0 pending/);
    });

    it("counts the optimistic send until the queue projects it, and honours queuedCount", () => {
        const sending = { text: "first prompt" };
        const { unmount } = renderComposer(sessionFixture({ status: "busy", queue: [] }), { sending });
        expect(screen.getByTestId("composer-queue")).toHaveTextContent(/1 pending/);
        // The body of the optimistic message never shows up in the composer.
        expect(screen.queryByText("first prompt")).not.toBeInTheDocument();
        unmount();

        renderComposer(
            sessionFixture({
                status: "busy",
                queue: [{ id: "q1", text: "later please", steer: false }],
            }),
            { sending, queuedCount: 7 },
        );
        expect(screen.getByTestId("composer-queue")).toHaveTextContent(/7 pending/);
    });

    it("clears the queue through onClearQueue", () => {
        const session = sessionFixture({
            status: "busy",
            queue: [
                { id: "q1", text: "later please", steer: false },
                { id: "q2", text: "and this one", steer: false },
            ],
        });
        const onClearQueue = vi.fn();
        const { onRemoveQueue } = renderComposer(session, { onClearQueue });

        fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
        expect(onClearQueue).toHaveBeenCalledTimes(1);
        expect(onRemoveQueue).not.toHaveBeenCalled();
    });

    it("falls back to per-item removal when no bulk clear is wired", () => {
        const session = sessionFixture({
            status: "busy",
            queue: [
                { id: "q1", text: "later please", steer: false },
                { id: "q2", text: "and this one", steer: false },
            ],
        });
        const { onRemoveQueue } = renderComposer(session);

        fireEvent.click(screen.getByRole("button", { name: "Clear queue" }));
        expect(onRemoveQueue.mock.calls.map(([id]) => id)).toEqual(["q1", "q2"]);
    });

    it("drops the mock-era demo copy from the attachment dialog", () => {
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
        expect(screen.queryByText(/Demo only/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/prototype demo only/i)).not.toBeInTheDocument();
    });
});
