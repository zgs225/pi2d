import { describe, expect, it } from "vitest";

import { connectHref, safeNext } from "@/lib/routing";

describe("safeNext", () => {
    it("keeps whitelisted navigation routes with their query", () => {
        expect(safeNext("/workspaces")).toBe("/workspaces");
        expect(safeNext("/status?tab=devices")).toBe("/status?tab=devices");
        expect(safeNext("/chat/01a15368")).toBe("/chat/01a15368");
        expect(safeNext("/workspace/ws-pi2?x=1")).toBe("/workspace/ws-pi2?x=1");
    });

    it("falls back for unknown or unsafe targets", () => {
        expect(safeNext(undefined)).toBe("/workspaces");
        expect(safeNext("/servers")).toBe("/workspaces");
        expect(safeNext("/connect")).toBe("/workspaces");
        expect(safeNext("javascript:alert(1)")).toBe("/workspaces");
        expect(safeNext("https://evil.example/not-a-page")).toBe("/workspaces");
    });

    it("builds an encoded connect redirect", () => {
        expect(connectHref("/chat/01a1?tab=todo")).toBe("/connect?next=%2Fchat%2F01a1%3Ftab%3Dtodo");
        expect(connectHref("/nope")).toBe("/connect?next=%2Fworkspaces");
    });
});
