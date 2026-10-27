import { describe, expect, it } from "vitest";

import { FALLBACK_NAME_CHARS, sessionTitle, subagentTitle } from "@/features/chat/session-title";

const phrases = { unnamed: "(unnamed)", subagentUnnamed: "sub-session" };

describe("sessionTitle", () => {
    it("prefers the session's own name", () => {
        expect(sessionTitle({ name: "Fix login", firstMessage: "hello" }, phrases)).toEqual({
            text: "Fix login",
            kind: "name",
            provisional: false,
            spinner: false,
        });
    });

    it("trims the name and falls through when it is blank", () => {
        expect(sessionTitle({ name: "  Fix login  " }, phrases).text).toBe("Fix login");
        expect(sessionTitle({ name: "   ", firstMessage: "hello" }, phrases).text).toBe("hello");
        expect(sessionTitle({ name: "", firstMessage: "" }, phrases).text).toBe("(unnamed)");
    });

    it("falls back to the first user message (pi2.nvim's first_message)", () => {
        expect(sessionTitle({ name: null, firstMessage: " Fix the auth bug " }, phrases)).toEqual({
            text: "Fix the auth bug",
            kind: "first-message",
            provisional: false,
            spinner: false,
        });
    });

    it("shows (unnamed) when nothing is known — never an id", () => {
        const title = sessionTitle({ name: null, firstMessage: null }, phrases);
        expect(title).toEqual({ text: "(unnamed)", kind: "unnamed", provisional: true, spinner: false });
    });

    it("suppresses the first message and spins while the backend generates a title", () => {
        expect(sessionTitle({ name: null, firstMessage: "Fix the auth bug", titleGenerating: true }, phrases)).toEqual({
            text: "(unnamed)",
            kind: "generating",
            provisional: true,
            spinner: true,
        });
    });

    it("drops the spinner the moment a real name arrives", () => {
        const title = sessionTitle({ name: "Fix login", titleGenerating: true }, phrases);
        expect(title.kind).toBe("name");
        expect(title.spinner).toBe(false);
    });
});

describe("subagentTitle", () => {
    it("prefers the sub-session name", () => {
        expect(subagentTitle({ name: "researcher", task: "Research the auth flow" }, phrases).text).toBe("researcher");
    });

    it("derives the name from the task prompt, capped like Manifest.fallback_name", () => {
        const task = "x".repeat(FALLBACK_NAME_CHARS + 25);
        const title = subagentTitle({ name: null, task }, phrases);
        expect(title.text).toBe("x".repeat(FALLBACK_NAME_CHARS));
        expect(title.kind).toBe("task");
        expect(FALLBACK_NAME_CHARS).toBe(40);
    });

    it("falls back to sub-session — never the subagent id", () => {
        expect(subagentTitle({ name: "  ", task: "" }, phrases)).toEqual({
            text: "sub-session",
            kind: "unnamed",
            provisional: true,
            spinner: false,
        });
    });
});
