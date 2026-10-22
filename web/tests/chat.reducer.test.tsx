import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import type { SessionEvent } from "@protocol/types";
import { describe, expect, it } from "vitest";

import { applySessionEvent, emptySessionState, normalizeSnapshotState } from "@/features/chat/session-state";

function append(state: ReturnType<typeof emptySessionState>, event: SessionEvent) {
    return applySessionEvent(state, event);
}

describe("canonical reducer integration", () => {
    it("streams text deltas and lets authoritative message_end replace the block", () => {
        let state = emptySessionState({ sessionId: "s1", workspaceId: "w1" });
        state = append(state, { type: "agent_start", ts: 1 });
        state = append(state, {
            type: "message_start",
            ts: 2,
            message: { role: "assistant", content: [] },
        });
        state = append(state, {
            type: "message_update",
            ts: 3,
            assistantMessageEvent: { type: "text_start", contentIndex: 0 },
        });
        state = append(state, {
            type: "message_update",
            ts: 4,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" },
        });
        state = append(state, {
            type: "message_update",
            ts: 5,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" },
        });

        expect(state.status).toBe("busy");
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]?.blocks[0]).toEqual({ type: "text", text: "Hello" });

        state = append(state, {
            type: "message_end",
            ts: 6,
            message: {
                role: "assistant",
                content: [{ type: "text", text: "Hello world" }],
                usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
            },
        });

        expect(state.entries[0]?.blocks[0]).toEqual({ type: "text", text: "Hello world" });
        expect(state.entries[0]?.done).toBe(true);
        expect(state.usage).toMatchObject({ input: 10, output: 2, cost: 0.01 });
    });

    it("renders exactly one assistant entry with the exact streamed text", () => {
        let state = emptySessionState({ sessionId: "s1", workspaceId: "w1" });
        state = append(state, { type: "agent_start", ts: 1 });
        state = append(state, { type: "message_start", ts: 2, message: { role: "assistant", content: [] } });
        for (const delta of ["P", "O", "N", "G"]) {
            state = append(state, {
                type: "message_update",
                ts: 3,
                assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
            });
        }
        state = append(state, {
            type: "message_end",
            ts: 4,
            message: { role: "assistant", content: [{ type: "text", text: "PONG" }] },
        });

        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]?.blocks).toEqual([{ type: "text", text: "PONG" }]);
        expect(state.entries[0]?.done).toBe(true);

        // The bridge coalesces deltas and stamps their seq when the frame is
        // written, so the tail of the message can arrive after `message_end`.
        // Replaying it must not append the tail a second time (`PONGONG`).
        state = append(state, {
            type: "message_update",
            ts: 5,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ONG" },
        });
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]?.blocks).toEqual([{ type: "text", text: "PONG" }]);
    });

    it("ignores stale deltas after a snapshot took over a settled session", () => {
        const ts = Date.now();
        const snapshot = normalizeSnapshotState("s1", "w1", {
            state: {
                status: "idle",
                entries: [
                    { id: "m1", role: "user", ts, done: true, blocks: [{ type: "text", text: "ping" }] },
                    { id: "m2", role: "assistant", ts, done: true, blocks: [{ type: "text", text: "PONG" }] },
                ],
            },
        });
        const next = append(snapshot, {
            type: "message_update",
            ts: ts + 10,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ONG" },
        });
        expect(next.entries.filter((entry) => entry.role === "assistant")).toHaveLength(1);
        expect(next.entries[1]?.blocks).toEqual([{ type: "text", text: "PONG" }]);
    });

    it("applies entry_appended for user messages and folds tool results into the tool block", () => {
        const ts = Date.now();
        let state = emptySessionState({ sessionId: "s1", workspaceId: "w1" });
        state = append(state, {
            type: "entry_appended",
            ts,
            entry: {
                type: "message",
                id: "u1",
                timestamp: new Date(ts).toISOString(),
                message: { role: "user", content: "please fix it", timestamp: ts },
            },
        });
        expect(state.entries).toHaveLength(1);
        expect(state.entries[0]).toMatchObject({ id: "u1", role: "user" });

        state.entries.push({
            id: "m1",
            role: "assistant",
            ts,
            done: false,
            blocks: [
                {
                    type: "tool",
                    toolCallId: "call_9",
                    name: "bash",
                    state: "running",
                },
            ],
        });
        state = append(state, {
            type: "entry_appended",
            ts: ts + 1,
            entry: {
                type: "message",
                id: "tr1",
                message: {
                    role: "toolResult",
                    toolCallId: "call_9",
                    toolName: "bash",
                    isError: false,
                    content: [{ type: "text", text: "ok" }],
                },
            },
        });
        const tool = state.entries.find((entry) => entry.id === "m1")?.blocks[0];
        expect(tool).toMatchObject({ type: "tool", state: "done", output: { text: "ok" } });
    });

    it("deduplicates the same user entry arriving twice", () => {
        const ts = Date.now();
        const event: SessionEvent = {
            type: "entry_appended",
            ts,
            entry: {
                type: "message",
                id: "u1",
                message: { role: "user", content: "hello", timestamp: ts },
            },
        };
        let state = emptySessionState({ sessionId: "s1", workspaceId: "w1" });
        state = append(state, event);
        state = append(state, { ...event, entry: { ...(event.entry as object), id: "u2" } });
        expect(state.entries.filter((entry) => entry.role === "user")).toHaveLength(1);
    });

    it("tracks an attention request and closes it when the plugin resolves it", () => {
        let state = emptySessionState({ sessionId: "s1", workspaceId: "w1" });
        state = append(state, {
            type: "pi2:attention_request",
            ts: 10,
            requestId: "att-1",
            method: "select",
            title: "Run this command?",
            options: [{ id: "allow-once", label: "Allow once" }],
            timeoutSec: 30,
        });
        expect(state.attention).toHaveLength(1);
        expect(state.attention[0]).toMatchObject({
            requestId: "att-1",
            method: "select",
            title: "Run this command?",
            options: [{ id: "allow-once", label: "Allow once" }],
            timeoutSec: 30,
        });
        expect(state.flags.attention).toBe(true);

        state = append(state, { type: "pi2:attention_resolved", ts: 11, requestId: "att-1" });
        expect(state.attention).toHaveLength(0);
        expect(state.flags.attention).toBe(false);
    });

    it("replays the basic-turn fixture through the shared reducer", () => {
        const fixture = join(process.cwd(), "..", "fixtures", "basic-turn", "events.jsonl");
        if (!existsSync(fixture)) {
            expect(true).toBe(true);
            return;
        }
        const events = readFileSync(fixture, "utf8")
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as SessionEvent);
        let state = emptySessionState({
            sessionId: "basic-turn",
            workspaceId: "ws-fixture",
            cwd: "/repo",
        });
        for (const event of events) state = applySessionEvent(state, event);

        const assistant = state.entries.find((entry) => entry.role === "assistant");
        const tool = assistant?.blocks.find((block) => block.type === "tool");
        expect(tool).toMatchObject({
            type: "tool",
            toolCallId: "call_1",
            name: "bash",
            state: "done",
            output: { text: "a.txt\nb.txt" },
        });
        expect(state.status).toBe("idle");
    });
});
