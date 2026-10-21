import { describe, expect, it } from "vitest";

import { connectHref, safeNext } from "@/lib/routing";

describe("safeNext", () => {
    it("keeps whitelisted navigation routes with their query", () => {
        expect(safeNext("/workspaces")).toBe("/workspaces");
        expect(safeNext("/status?tab=devices")).toBe("/status?tab=devices");
        expect(safeNext("/chat/01a15368")).toBe("/chat/01a15368");
        expect(safeNext("/workspace/ws-pi2?x=1")).toBe("/workspace/ws-pi2?x=1");
    });

    it("keeps paired deep links (session + workspace query) across the pairing round trip", () => {
        expect(safeNext("/chat/01a15368?workspace=ws-1")).toBe("/chat/01a15368?workspace=ws-1");
        expect(safeNext("/chat/01a1?workspace=ws-1&tab=todo")).toBe("/chat/01a1?workspace=ws-1&tab=todo");
        expect(connectHref(safeNext("/chat/01a1?workspace=ws-1"))).toBe(
            "/connect?next=%2Fchat%2F01a1%3Fworkspace%3Dws-1",
        );
        // The `next` param survives a full redirect → pairing → redirect cycle.
        const href = connectHref("/chat/01a1?workspace=ws-1");
        const next = new URLSearchParams(href.split("?")[1]).get("next");
        expect(safeNext(next)).toBe("/chat/01a1?workspace=ws-1");
    });

    it("falls back for unknown or unsafe targets", () => {
        expect(safeNext(undefined)).toBe("/workspaces");
        expect(safeNext("/servers")).toBe("/workspaces");
        expect(safeNext("/connect")).toBe("/workspaces");
        expect(safeNext("/pair/ABCD1234")).toBe("/workspaces");
        expect(safeNext("javascript:alert(1)")).toBe("/workspaces");
        expect(safeNext("https://evil.example/not-a-page")).toBe("/workspaces");
        // A protocol-relative link keeps only its path (the host is never used).
        expect(safeNext("//evil.example/chat/1")).toBe("/chat/1");
        expect(safeNext("//evil.example/not-a-page")).toBe("/workspaces");
    });

    it("builds an encoded connect redirect", () => {
        expect(connectHref("/chat/01a1?tab=todo")).toBe("/connect?next=%2Fchat%2F01a1%3Ftab%3Dtodo");
        expect(connectHref("/nope")).toBe("/connect?next=%2Fworkspaces");
    });
});
