import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { Composer } from "@/features/chat/composer";
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

function renderComposer(session = sessionFixture()) {
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
        />,
    );
    return { ...utils, onSend, onAbort, onRemoveQueue, onSetSteer, onSetModel, onSetThinking };
}

describe("composer", () => {
    it("exposes the stable Playwright selectors", () => {
        renderComposer(sessionFixture({ status: "busy" }));
        expect(screen.getByTestId("composer-input")).toHaveClass("composer__ta");
        expect(screen.getByTestId("composer-send")).toHaveClass("composer__send");
        expect(screen.getByTestId("composer-abort")).toBeInTheDocument();
        expect(screen.getByTestId("composer-model")).toHaveAttribute("aria-label", "Model");
        expect(screen.getByTestId("composer-thinking")).toHaveAttribute("aria-label", "Thinking level");
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

    it("keeps send for follow-ups and adds steer + abort while the session is busy", () => {
        const session = sessionFixture({ status: "busy" });
        const { onAbort, onSend } = renderComposer(session);

        fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "queue me" } });
        fireEvent.click(screen.getByTestId("composer-send"));
        expect(onSend).toHaveBeenLastCalledWith("queue me", [], "follow_up");

        fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "interrupt" } });
        fireEvent.click(screen.getByTestId("composer-steer"));
        expect(onSend).toHaveBeenLastCalledWith("interrupt", [], "steer");

        fireEvent.click(screen.getByRole("button", { name: "Abort" }));
        expect(onAbort).toHaveBeenCalledTimes(1);
    });

    it("renders queue chips with the session-wide steer toggle and remove", () => {
        const session = sessionFixture({
            status: "idle",
            queue: [{ id: "q1", text: "later please", steer: false }],
        });
        const { onRemoveQueue, onSetSteer } = renderComposer(session);

        expect(screen.getByText("later please")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("checkbox", { name: "Steer" }));
        // Steering is a session-wide mode, so the toggle carries no queue id.
        expect(onSetSteer).toHaveBeenCalledWith(true);

        fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
        expect(onRemoveQueue).toHaveBeenCalledWith("q1");
    });

    it("drops the mock-era demo copy from the attachment dialog", () => {
        renderComposer();
        fireEvent.click(screen.getByRole("button", { name: "Add attachment" }));
        expect(screen.queryByText(/Demo only/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/prototype demo only/i)).not.toBeInTheDocument();
    });
});
