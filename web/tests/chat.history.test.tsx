import { describe, expect, it } from "vitest";

import {
    mergeEntries,
    normalizeEntriesPage,
    prependUnique,
    projectEntries,
} from "@/lib/entry-projection";
import { entryFixture } from "./chat-fixtures";

const TS = 1_733_234_400_000;

function rawEntries() {
    return [
        {
            type: "message",
            id: "u1",
            timestamp: new Date(TS).toISOString(),
            message: { role: "user", content: "hello", timestamp: TS },
        },
        {
            type: "message",
            id: "a1",
            timestamp: new Date(TS + 1).toISOString(),
            message: {
                role: "assistant",
                timestamp: TS + 1,
                content: [
                    { type: "thinking", thinking: "hmm" },
                    { type: "text", text: "on it" },
                    { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
                ],
            },
        },
        {
            type: "message",
            id: "tr1",
            timestamp: new Date(TS + 2).toISOString(),
            message: {
                role: "toolResult",
                timestamp: TS + 2,
                toolCallId: "call_1",
                toolName: "bash",
                isError: false,
                content: [{ type: "text", text: "file.txt" }],
            },
        },
        {
            type: "custom",
            id: "todo1",
            customType: "pi2-todo",
            timestamp: new Date(TS + 3).toISOString(),
            data: {
                todos: [
                    { content: "one", status: "completed" },
                    { content: "two", status: "in_progress", activeForm: "doing two" },
                ],
            },
        },
    ];
}

describe("history entry projection", () => {
    it("projects raw messages, folds tool results and keeps todo checkpoints", () => {
        const entries = projectEntries(rawEntries());
        expect(entries.map((entry) => entry.id)).toEqual(["u1", "a1", "todo1"]);

        const assistant = entries[1];
        expect(assistant?.blocks[0]).toEqual({ type: "thinking", text: "hmm" });
        expect(assistant?.blocks[1]).toEqual({ type: "text", text: "on it" });
        expect(assistant?.blocks[2]).toMatchObject({
            type: "tool",
            toolCallId: "call_1",
            state: "done",
            output: { text: "file.txt" },
        });

        const todo = entries[2];
        expect(todo?.todo).toMatchObject({ completed: 1, total: 2 });
        expect(todo?.todo?.items[1]).toMatchObject({ status: "in_progress", activeForm: "doing two" });
    });

    it("merges live entries by id (live wins) without dropping history", () => {
        const history = [entryFixture({ id: "a", blocks: [{ type: "text", text: "old" }] })];
        const live = [
            entryFixture({ id: "a", blocks: [{ type: "text", text: "new" }] }),
            entryFixture({ id: "b", blocks: [{ type: "text", text: "tail" }] }),
        ];
        const merged = mergeEntries(history, live);
        expect(merged.map((entry) => entry.id)).toEqual(["a", "b"]);
        expect(merged[0]?.blocks[0]).toEqual({ type: "text", text: "new" });
    });

    it("prepends older pages without duplicating ids", () => {
        const page2 = projectEntries([
            {
                type: "message",
                id: "s02",
                message: { role: "user", content: "b", timestamp: TS + 2 },
            },
            {
                type: "message",
                id: "s03",
                message: { role: "user", content: "c", timestamp: TS + 3 },
            },
        ]);
        const page1 = projectEntries([
            {
                type: "message",
                id: "s01",
                message: { role: "user", content: "a", timestamp: TS + 1 },
            },
            {
                type: "message",
                id: "s02",
                message: { role: "user", content: "b", timestamp: TS + 2 },
            },
        ]);
        const combined = prependUnique(page2, page1);
        expect(combined.map((entry) => entry.id)).toEqual(["s01", "s02", "s03"]);
        expect(new Set(combined.map((entry) => entry.id)).size).toBe(combined.length);
    });

    it("normalizes the entries page cursor", () => {
        expect(
            normalizeEntriesPage({
                entries: [{ id: "e1" }, { id: "e2" }],
                cursor: { before: "e1", hasMore: true },
                bytes: 10,
            }),
        ).toEqual({ entries: [{ id: "e1" }, { id: "e2" }], cursor: { before: "e1", hasMore: true } });

        expect(
            normalizeEntriesPage({ entries: [{ id: "e9" }], hasMore: true }).cursor,
        ).toEqual({ before: "e9", hasMore: true });

        expect(normalizeEntriesPage({ entries: [] }).cursor).toEqual({ before: undefined, hasMore: false });
    });
});
