import { describe, expect, it } from "vitest";

import {
    cancelResponse,
    chatCommands,
    confirmResponse,
    diffAnswer,
    diffResponse,
    selectResponse,
} from "@/features/chat/commands";

/**
 * Payload shapes are owned by the plugin
 * (`pi2.nvim-web/lua/pi/web/commands.lua`); these assertions are the contract.
 */
describe("chat command payloads", () => {
    it("sends prompts with the plugin's modes and images", () => {
        const plain = chatCommands.sendPrompt("s1", "hi");
        expect(plain).toMatchObject({ method: "prompt.send", sessionId: "s1", params: { text: "hi" } });
        // A prompt while idle is a plain prompt: no follow-up/steer wrapper.
        expect(plain.params).not.toHaveProperty("mode");

        expect(chatCommands.sendPrompt("s1", "hi", [], "follow_up").params).toMatchObject({
            text: "hi",
            mode: "follow_up",
        });
        expect(chatCommands.sendPrompt("s1", "hi", [], "steer").params).toMatchObject({
            text: "hi",
            mode: "steer",
        });
        expect(
            chatCommands.sendPrompt("s1", "hi", [{ mimeType: "image/png", data: "AAA" }], "follow_up").params,
        ).toMatchObject({
            text: "hi",
            mode: "follow_up",
            images: [{ mimeType: "image/png", data: "AAA" }],
        });
    });

    it("addresses queue entries by id and sets the steering mode", () => {
        expect(chatCommands.removeQueued("s1", "q1")).toMatchObject({
            method: "queue.remove",
            params: { id: "q1" },
        });
        expect(chatCommands.setQueueSteer("s1", true)).toMatchObject({
            method: "queue.setSteer",
            params: { mode: "all" },
        });
        expect(chatCommands.setQueueSteer("s1", false)).toMatchObject({
            method: "queue.setSteer",
            params: { mode: "one-at-a-time" },
        });
    });

    it("wraps model and thinking changes in the plugin's fields", () => {
        expect(chatCommands.setModel("s1", { provider: "anthropic", id: "m" })).toMatchObject({
            method: "session.setModel",
            params: { model: { provider: "anthropic", id: "m" } },
        });
        expect(chatCommands.setThinking("s1", "high")).toMatchObject({
            method: "session.setThinking",
            params: { level: "high" },
        });
    });

    it("builds attention answers in the `pi.attention.resolve` shape", () => {
        expect(selectResponse("allow-once")).toEqual({ value: "allow-once" });
        expect(confirmResponse(true)).toEqual({ confirmed: true });
        expect(confirmResponse(false)).toEqual({ confirmed: false });
        expect(cancelResponse()).toEqual({ cancelled: true });

        expect(chatCommands.respondAttention("s1", "att-1", selectResponse("allow-once"))).toMatchObject({
            method: "attention.respond",
            params: { requestId: "att-1", response: { value: "allow-once" } },
        });
        expect(chatCommands.respondAttention("s1", "att-1", confirmResponse(true))).toMatchObject({
            params: { requestId: "att-1", response: { confirmed: true } },
        });

        // Diff review: the JSON `{result, path?}` string rides inside `value`.
        expect(diffResponse("Accepted")).toBe(JSON.stringify({ result: "Accepted" }));
        expect(diffResponse("Rejected", "src/auth.ts")).toBe(
            JSON.stringify({ result: "Rejected", path: "src/auth.ts" }),
        );
        expect(diffAnswer("Accepted")).toEqual({ value: diffResponse("Accepted") });
        expect(chatCommands.respondAttention("s1", "att-2", diffAnswer("Accepted"))).toMatchObject({
            params: { requestId: "att-2", response: { value: diffResponse("Accepted") } },
        });
    });

    it("dispatches one batch item with the snake_case contract", () => {
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
                items: [
                    {
                        task: "do it",
                        name: "worker",
                        model: { provider: "anthropic", id: "m" },
                        thinking_level: "low",
                    },
                ],
                wait: true,
                cancel_siblings_on_fail: true,
            },
        });

        expect(chatCommands.dispatchSubagent("s1", { task: "solo" }).params).toEqual({
            items: [{ task: "solo" }],
            wait: false,
            cancel_siblings_on_fail: false,
        });
    });

    it("reads sub-sessions and task output by id", () => {
        expect(chatCommands.readSubagent("s1", "researcher")).toMatchObject({
            method: "subagent.read",
            params: { target: "researcher" },
        });
        expect(chatCommands.stopTask("s1", "t1")).toMatchObject({
            method: "task.stop",
            params: { taskId: "t1" },
        });
        expect(chatCommands.taskOutput("s1", "t1")).toMatchObject({
            method: "task.output",
            params: { taskId: "t1" },
        });
    });
});
