import type { Batch, Entry, SessionState, Subagent, TodoItem } from "@protocol/types";

import { emptySessionState } from "@/features/chat/session-state";

export function entryFixture(overrides: Partial<Entry> = {}): Entry {
    return {
        id: "e1",
        role: "assistant",
        ts: Date.now(),
        blocks: [{ type: "text", text: "hello" }],
        done: true,
        ...overrides,
    };
}

export function subagentFixture(overrides: Partial<Subagent> = {}): Subagent {
    return {
        id: "sa1",
        name: "researcher",
        status: "active",
        model: "claude-sonnet-4-5",
        thinking: "low",
        task: "Research the auth flow",
        createdAt: Date.now() - 60_000,
        lastActiveAt: Date.now() - 5_000,
        ...overrides,
    };
}

export function todoFixture(): TodoItem[] {
    return [
        { content: "Inspect callers", status: "completed" },
        { content: "Apply fix", status: "in_progress", activeForm: "Applying the fix" },
        { content: "Run tests", status: "pending" },
    ];
}

export function batchFixture(overrides: Partial<Batch> = {}): Batch {
    return {
        batchId: "b1",
        status: "running",
        items: [
            { ref: "0", name: "researcher", status: "ok" },
            { ref: "1", name: "writer", status: "failed", error: "boom" },
            { ref: "2", name: "tester", status: "running" },
        ],
        ...overrides,
    };
}

export function sessionFixture(overrides: Partial<SessionState> = {}): SessionState {
    return {
        ...emptySessionState({
            sessionId: "s1",
            workspaceId: "w1",
            cwd: "/repo",
            name: "Alpha",
            status: "busy",
            model: { provider: "anthropic", id: "claude-sonnet-4-5" },
            thinking: "high",
        }),
        ...overrides,
    };
}

/** Snapshot carrying one of every stream block kind. */
export function fullStreamSession(): SessionState {
    const now = Date.now();
    const user = entryFixture({
        id: "u1",
        role: "user",
        ts: now - 40_000,
        blocks: [{ type: "text", text: "Fix the auth bug" }],
    });
    const assistant = entryFixture({
        id: "a1",
        role: "assistant",
        ts: now - 30_000,
        done: true,
        blocks: [
            { type: "thinking", text: "Check every caller before editing" },
            { type: "text", text: "Looking at the auth path now." },
            {
                type: "tool",
                toolCallId: "call_1",
                name: "bash",
                args: { command: "ls -la" },
                state: "done",
                durationMs: 1200,
                output: { text: "a.txt\nb.txt" },
            },
            {
                type: "tool",
                toolCallId: "call_2",
                name: "edit",
                args: { path: "src/auth.ts", oldText: "a", newText: "b" },
                state: "error",
                durationMs: 300,
                output: { text: "permission denied", isError: true },
            },
        ],
    });
    const error = entryFixture({
        id: "n1",
        role: "notice",
        ts: now - 20_000,
        blocks: [{ type: "error", text: "agent aborted" }],
    });
    return sessionFixture({
        entries: [user, assistant, error],
        todos: todoFixture(),
        batches: [batchFixture()],
        subagents: [subagentFixture(), subagentFixture({ id: "sa2", name: "writer", status: "failed" })],
    });
}
