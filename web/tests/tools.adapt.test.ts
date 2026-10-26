import { describe, expect, it } from "vitest";

import type { Block } from "@protocol/types";

import { diffFromArgs, fromPi2Block } from "@/features/chat/tools/adapt";
import { fileTarget } from "@/features/chat/tools/format";
import { normalizeTool } from "@/features/chat/tools/facts";
import type { ToolView } from "@/features/chat/tools/types";

type ToolBlock = Extract<Block, { type: "tool" }>;

function block(overrides: Partial<ToolBlock> = {}): ToolBlock {
    return { type: "tool", toolCallId: "t1", name: "bash", state: "done", ...overrides };
}

const plain = (): ToolView => ({ id: "x", name: "mystery" });

describe("fromPi2Block — wire DTO", () => {
    it("maps the four wire states onto the canonical vocabulary", () => {
        expect(fromPi2Block(block({ state: "pending" }), "m1").state).toBe("queued");
        expect(fromPi2Block(block({ state: "running" }), "m1").state).toBe("running");
        expect(fromPi2Block(block({ state: "done" }), "m1").state).toBe("done");
        expect(fromPi2Block(block({ state: "error" }), "m1").state).toBe("failed");
    });

    it("falls back to the alias table for wire states it does not know", () => {
        const view = fromPi2Block({ ...block(), state: "interrupted" } as unknown as ToolBlock, "m1");
        expect(view.state).toBe("interrupted");
    });

    it("only records startedAt while running, using the message timestamp", () => {
        expect(fromPi2Block(block({ state: "running" }), "m1", { ts: 1000 }).startedAt).toBe(1000);
        expect(fromPi2Block(block({ state: "done" }), "m1", { ts: 1000 }).startedAt).toBeUndefined();
        expect(fromPi2Block(block({ state: "running" }), "m1").startedAt).toBeUndefined();
        expect(fromPi2Block(block({ state: "running" }), "m1", { startedAt: 42 }).startedAt).toBe(42);
    });

    it("carries ids, names, kind, duration and agent", () => {
        const view = fromPi2Block(block({ name: "grep", durationMs: 1234 }), "m7", { agent: "researcher" });
        expect(view.id).toBe("t1");
        expect(view.messageId).toBe("m7");
        expect(view.kind).toBe("search");
        expect(view.durationMs).toBe(1234);
        expect(view.agent).toBe("researcher");
    });

    it("passes object args through as input and merges args.meta", () => {
        const view = fromPi2Block(block({ args: { command: "ls -la", meta: { lines: 12 } } }), "m1");
        expect(view.input).toEqual({ command: "ls -la", meta: { lines: 12 } });
        expect(view.meta?.lines).toBe(12);
    });

    it("keeps non-object args in raw for the generic family", () => {
        const view = fromPi2Block(block({ name: "mcp__x__y", args: "plain text" }), "m1");
        expect(view.input).toBeUndefined();
        expect(view.raw).toBe("plain text");
        expect(view.kind).toBe("generic");
    });
});

describe("fromPi2Block — legacy DTO degradation", () => {
    it("splits legacy output text into text.lines", () => {
        const view = fromPi2Block(block({ output: { text: "hello\nworld" } }), "m1");
        expect(view.text?.lines).toEqual(["hello", "world"]);
        expect(view.result?.error).toBeUndefined();
    });

    it("turns `output.details` text into text.lines and keeps it as legacy details", () => {
        const view = fromPi2Block(block({ output: { details: "a\nb" } }), "m1");
        expect(view.text?.lines).toEqual(["a", "b"]);
        expect(view.result?.details).toBe("a\nb");
        expect(view.result?.error).toBeUndefined();
    });

    it("promotes isError output to result.error", () => {
        const view = fromPi2Block(block({ state: "error", output: { text: "boom\nstack", isError: true } }), "m1");
        expect(view.result?.error).toBe("boom\nstack");
    });

    it("lifts structured details into meta facts without losing the payload", () => {
        const details = { exitCode: 2, truncated: true, added: 3, removed: 1 };
        const view = fromPi2Block(block({ output: { details } }), "m1");
        expect(view.meta?.exitCode).toBe(2);
        expect(view.meta?.added).toBe(3);
        expect(view.meta?.removed).toBe(1);
        expect(view.result?.exitCode).toBe(2);
        expect(view.result?.truncated).toBe(true);
        expect(view.result?.details).toEqual(details);
    });

    it("normalizes a legacy `details` string on a hand-built view without mutating it", () => {
        const legacy: ToolView = { id: "x", name: "bash", details: "one\ntwo" };
        const view = normalizeTool(legacy);
        expect(view.text?.lines).toEqual(["one", "two"]);
        expect(legacy.text).toBeUndefined();

        const withLines: ToolView = { id: "x", name: "bash", details: "ignored", text: { lines: ["kept"] } };
        expect(normalizeTool(withLines)).toBe(withLines);
    });

    it("uses the legacy `summary` as the row target when there is no structured input", () => {
        expect(fileTarget({ ...plain(), summary: "Did a thing" })).toBe("Did a thing");
        expect(fileTarget(plain())).toBe("mystery");
    });
});

describe("diffFromArgs", () => {
    it("rebuilds a diff from before/after snippets", () => {
        const diff = diffFromArgs({ path: "a.ts", oldText: "a\nb", newText: "a\nc" });
        expect(diff?.files).toHaveLength(1);
        const file = diff?.files[0];
        expect(file?.path).toBe("a.ts");
        expect(file?.status).toBe("modified");
        expect(file?.added).toBe(1);
        expect(file?.removed).toBe(1);
        const kinds = (file?.hunks ?? []).flatMap((hunk) => (hunk.lines ?? []).map((line) => line.t));
        expect(kinds).toContain("add");
        expect(kinds).toContain("del");
    });

    it("accepts a structured patch payload and numbers its lines", () => {
        const diff = diffFromArgs({
            diff: {
                files: [{ path: "b.ts", status: "added", hunks: [{ header: "@@ -1,1 +1,2 @@", lines: ["+one", "+two"] }] }],
            },
        });
        const lines = diff?.files[0]?.hunks?.[0]?.lines;
        expect(lines?.map((line) => [line.t, line.new])).toEqual([
            ["add", 1],
            ["add", 2],
        ]);
    });

    it("returns undefined when there is nothing to diff", () => {
        expect(diffFromArgs(undefined)).toBeUndefined();
        expect(diffFromArgs({ path: "a.ts" })).toBeUndefined();
        expect(diffFromArgs({ diff: { files: [] } })).toBeUndefined();
    });
});
