import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { Composer } from "@/features/chat/composer";
import { chatCommands } from "@/features/chat/commands";
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
    it("sends on Enter and keeps Shift+Enter for a newline", () => {
        const { onSend } = renderComposer();
        const textarea = screen.getByRole("textbox", { name: "Message input" });

        fireEvent.change(textarea, { target: { value: "hello" } });
        fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
        expect(onSend).not.toHaveBeenCalled();

        fireEvent.keyDown(textarea, { key: "Enter" });
        expect(onSend).toHaveBeenCalledWith("hello", []);
        expect(textarea).toHaveValue("");
    });

    it("turns the send button into an abort button while the session is busy", () => {
        const session = sessionFixture({ status: "busy" });
        const { onAbort, onSend } = renderComposer(session);
        fireEvent.click(screen.getByRole("button", { name: "Abort" }));
        expect(onAbort).toHaveBeenCalledTimes(1);
        expect(onSend).not.toHaveBeenCalled();
    });

    it("renders queue chips with steer toggle and remove", () => {
        const session = sessionFixture({
            status: "idle",
            queue: [{ id: "q1", text: "later please", steer: false }],
        });
        const { onRemoveQueue, onSetSteer } = renderComposer(session);

        expect(screen.getByText("later please")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("checkbox", { name: "Steer" }));
        expect(onSetSteer).toHaveBeenCalledWith("q1", true);

        fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
        expect(onRemoveQueue).toHaveBeenCalledWith("q1");
    });

    it("builds the documented command payloads", () => {
        expect(chatCommands.sendPrompt("s1", "hi")).toMatchObject({
            method: "prompt.send",
            sessionId: "s1",
            params: { text: "hi", mode: "queue" },
        });
        expect(chatCommands.sendPrompt("s1", "hi", [{ mimeType: "image/png", data: "AAA" }])).toMatchObject({
            params: { text: "hi", mode: "queue", images: [{ mimeType: "image/png", data: "AAA" }] },
        });
        expect(chatCommands.abort("s1")).toMatchObject({ method: "prompt.abort", sessionId: "s1" });
        expect(chatCommands.removeQueued("s1", "q1")).toMatchObject({
            method: "queue.remove",
            params: { queueId: "q1" },
        });
        expect(chatCommands.setQueueSteer("s1", "q1", true)).toMatchObject({
            method: "queue.setSteer",
            params: { queueId: "q1", steer: true },
        });
        expect(chatCommands.setModel("s1", { provider: "anthropic", id: "m" })).toMatchObject({
            method: "session.setModel",
            params: { provider: "anthropic", id: "m" },
        });
        expect(chatCommands.setThinking("s1", "high")).toMatchObject({
            method: "session.setThinking",
            params: { level: "high" },
        });
        expect(chatCommands.respondAttention("s1", "att-1", "allow-once")).toMatchObject({
            method: "attention.respond",
            params: { requestId: "att-1", response: "allow-once" },
        });
        expect(
            chatCommands.dispatchSubagent("s1", {
                task: "do it",
                name: "worker",
                model: { provider: "anthropic", id: "m" },
                thinking: "low",
                wait: true,
                cancelSiblingsOnFail: true,
            }),
        ).toMatchObject({
            method: "subagent.dispatch",
            params: {
                task: "do it",
                name: "worker",
                model: { provider: "anthropic", id: "m" },
                thinking: "low",
                wait: true,
                cancelSiblingsOnFail: true,
            },
        });
        expect(chatCommands.stopTask("s1", "t1")).toMatchObject({
            method: "task.stop",
            params: { taskId: "t1" },
        });
    });
});
