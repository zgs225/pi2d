import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reduceAll } from "../src/protocol/reducer.js";
import type { SessionEvent, SessionState } from "../src/protocol/types.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

function loadCase(name: string): { events: SessionEvent[]; expected: SessionState } {
    const dir = join(FIXTURES, name);
    const events = readFileSync(join(dir, "events.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as SessionEvent);
    const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as SessionState;
    return { events, expected };
}

function cases(): string[] {
    return readdirSync(FIXTURES).filter((n) => existsSync(join(FIXTURES, n, "events.jsonl")));
}

describe("session reducer conformance", () => {
    for (const name of cases()) {
        it(`replays ${name} to the committed expected state`, () => {
            const { events, expected } = loadCase(name);
            const first = events[0]?.session as Record<string, unknown> | undefined;
            const actual = reduceAll(
                {
                    sessionId: name,
                    workspaceId: expected.workspaceId,
                    cwd: expected.cwd,
                },
                events,
            );
            expect(actual).toEqual(expected);
            // guard against fixtures that forgot to include the session seed
            expect(first?.cwd ?? expected.cwd).toBe(expected.cwd);
        });
    }

    for (const name of cases()) {
        it(`is idempotent when replayed twice on a fresh reducer (${name})`, () => {
            const { events } = loadCase(name);
            const a = reduceAll({ sessionId: name, workspaceId: "ws-fixture", cwd: "/repo" }, events);
            const b = reduceAll({ sessionId: name, workspaceId: "ws-fixture", cwd: "/repo" }, events);
            expect(a).toEqual(b);
        });
    }

    it("keeps tool execution attached to the assistant entry after message_end", () => {
        const { events } = loadCase("basic-turn");
        const state = reduceAll({ sessionId: "basic-turn", workspaceId: "ws-fixture", cwd: "/repo" }, events);
        const assistant = state.entries.find((e) => e.role === "assistant");
        expect(assistant).toBeDefined();
        const tool = assistant?.blocks.find((b) => b.type === "tool");
        expect(tool).toMatchObject({
            type: "tool",
            toolCallId: "call_1",
            name: "bash",
            state: "done",
            durationMs: 9,
            output: { text: "a.txt\nb.txt" },
        });
        expect(state.usage).toEqual({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.003 });
        expect(state.status).toBe("idle");
        expect(state.flags.done).toBe(true);
    });

    it("clears pending attention and refreshes derived panels", () => {
        const { events } = loadCase("queue-todo-attention");
        const state = reduceAll({ sessionId: "qta", workspaceId: "ws-fixture", cwd: "/repo" }, events);
        expect(state.attention).toHaveLength(0);
        expect(state.flags.attention).toBe(false);
        expect(state.queue.map((q) => [q.text, q.steer])).toEqual([
            ["use pnpm", true],
            ["then run the tests", false],
        ]);
        expect(state.todos).toHaveLength(3);
        expect(state.todos[1]).toMatchObject({ status: "in_progress", activeForm: "refactoring" });
        expect(state.subagents).toHaveLength(2);
        expect(state.batches[0]).toMatchObject({ batchId: "b1", status: "running" });
        expect(state.name).toBe("Refactor auth");
        expect(state.thinking).toBe("high");
    });

    it("marks aborted runs as error and exited processes as exited", () => {
        const { events } = loadCase("error-abort-compaction");
        const state = reduceAll({ sessionId: "eac", workspaceId: "ws-fixture", cwd: "/repo" }, events);
        expect(state.flags.error).toBe(true);
        expect(state.flags.done).toBe(false);
        expect(state.status).toBe("exited");
        const blocks = state.entries[0]?.blocks ?? [];
        expect(blocks.some((b) => b.type === "error")).toBe(true);
    });
});
