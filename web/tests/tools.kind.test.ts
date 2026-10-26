import { describe, expect, it } from "vitest";

import { FAMILY_IDS, KIND_ICON, KIND_OF, humanName, kindOf } from "@/features/chat/tools/kind";
import type { FamilyId } from "@/features/chat/tools/types";

/** Table-driven: every documented tool name → its family (contract §5, `core.js:13-27`). */
const TABLE: [string, FamilyId][] = [
    ["bash", "shell"],
    ["exec", "shell"],
    ["shell", "shell"],
    ["read", "read"],
    ["edit", "write"],
    ["write", "write"],
    ["patch", "write"],
    ["apply_patch", "write"],
    ["edit_file", "write"],
    ["multi_edit", "write"],
    ["grep", "search"],
    ["search", "search"],
    ["find", "find"],
    ["glob", "find"],
    ["ls", "find"],
    ["list_dir", "find"],
    ["web_search", "web"],
    ["web_fetch", "web"],
    ["fetch_content", "web"],
    ["source_check", "web"],
    ["get_search_content", "web"],
    ["web", "web"],
    ["todo_write", "plan"],
    ["update_plan", "plan"],
    ["plan", "plan"],
    ["dispatch_subagents", "subagent"],
    ["list_subagents", "subagent"],
    ["read_subagent", "subagent"],
    ["poll_subagents", "subagent"],
    ["wait_subagents", "subagent"],
    ["list_batches", "subagent"],
    ["stop_subagents", "subagent"],
    ["vision", "vision"],
    ["image", "vision"],
    ["screenshot", "vision"],
    ["task", "task"],
    ["tasks", "task"],
];

describe("kindOf", () => {
    it("covers every registered tool name (37 names, 11 kinds)", () => {
        expect(TABLE.length).toBeGreaterThanOrEqual(22);
        for (const [name, kind] of TABLE) {
            expect(kindOf(name), name).toBe(kind);
            expect(KIND_OF[name], name).toBe(kind);
        }
        // `generic` is the fallback, so every *other* family must be reachable by name.
        const named = new Set(TABLE.map(([, kind]) => kind));
        expect(named).toEqual(new Set(FAMILY_IDS.filter((kind) => kind !== "generic")));
        expect(FAMILY_IDS).toHaveLength(11);
    });

    it("trims and lowercases before lookup", () => {
        expect(kindOf("  BASH ")).toBe("shell");
        expect(kindOf("Web_Search")).toBe("web");
    });

    it("falls back to generic for unknown names and MCP tools", () => {
        expect(kindOf("mcp__slack__post")).toBe("generic");
        expect(kindOf("totally_unknown")).toBe("generic");
        expect(kindOf("")).toBe("generic");
        expect(kindOf(undefined)).toBe("generic");
        expect(kindOf(null)).toBe("generic");
        expect(kindOf(42)).toBe("generic");
    });

    it("has a glyph for every family", () => {
        for (const kind of FAMILY_IDS) expect(KIND_ICON[kind], kind).toBeTruthy();
    });
});

describe("humanName", () => {
    it("humanizes MCP names and keeps everything else verbatim", () => {
        expect(humanName("mcp__slack__post")).toBe("slack · post");
        expect(humanName("mcp__only")).toBe("only");
        expect(humanName("grep")).toBe("grep");
        expect(humanName("")).toBe("");
        expect(humanName(undefined)).toBe("tool");
    });
});
