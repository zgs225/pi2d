import { describe, expect, it } from "vitest";

import type { WorkspaceInfo } from "@/lib/protocol";

import {
    markWorkspaceUsed,
    readWorkspaceRecency,
    searchWorkspaces,
    sortByRecentUse,
    workspaceLabel,
    WORKSPACE_RECENCY_KEY,
    workspaceRecency,
} from "@/features/chat/workspace-order";

function workspace(
    overrides: Partial<WorkspaceInfo> & Pick<WorkspaceInfo, "workspaceId" | "cwd" | "name">,
): WorkspaceInfo {
    return {
        trusted: true,
        exists: true,
        sessionCount: 0,
        liveCount: 0,
        lastActiveAt: 0,
        instance: null,
        ...overrides,
    };
}

const alpha = workspace({ workspaceId: "WA", cwd: "/work/alpha", name: "Alpha", lastActiveAt: 100 });
const bravo = workspace({ workspaceId: "WB", cwd: "/srv/bravo", name: "Bravo", lastActiveAt: 300 });
const charlie = workspace({ workspaceId: "WC", cwd: "/work/charlie", name: "Charlie", lastActiveAt: 200 });

describe("workspaceLabel", () => {
    it("prefers the name, falls back to the cwd basename, then the id", () => {
        expect(workspaceLabel(alpha)).toBe("Alpha");
        expect(workspaceLabel(workspace({ workspaceId: "W", cwd: "/deep/path/proj/", name: "  " }))).toBe("proj");
        expect(workspaceLabel(workspace({ workspaceId: "W9", cwd: "/", name: "" }))).toBe("W9");
    });
});

describe("sortByRecentUse", () => {
    it("orders by the daemon's lastActiveAt", () => {
        expect(sortByRecentUse([alpha, bravo, charlie]).map((w) => w.workspaceId)).toEqual(["WB", "WC", "WA"]);
    });

    it("lets a browser-local stamp beat lastActiveAt", () => {
        const recency = { WA: 900 };
        expect(sortByRecentUse([bravo, charlie, alpha], recency).map((w) => w.workspaceId)).toEqual([
            "WA",
            "WB",
            "WC",
        ]);
    });

    it("falls back to the name, then the id, for never-touched rows", () => {
        const newer = workspace({ workspaceId: "WZ", cwd: "/work/newer", name: "Newer", lastActiveAt: 0 });
        const sameNameB = workspace({ workspaceId: "W2", cwd: "/a/beta", name: "beta", lastActiveAt: 0 });
        const sameNameA = workspace({ workspaceId: "W1", cwd: "/a/alpha", name: "alpha", lastActiveAt: 0 });
        expect(sortByRecentUse([sameNameB, newer, sameNameA]).map((w) => w.workspaceId)).toEqual([
            "W1",
            "W2",
            "WZ",
        ]);
    });

    it("never mutates the caller's array", () => {
        const list = [alpha, bravo];
        sortByRecentUse(list);
        expect(list.map((w) => w.workspaceId)).toEqual(["WA", "WB"]);
    });
});

describe("workspaceRecency", () => {
    it("takes the later of the local stamp and the daemon activity", () => {
        expect(workspaceRecency(charlie, { WC: 50 })).toBe(200);
        expect(workspaceRecency(charlie, { WC: 500 })).toBe(500);
        expect(workspaceRecency(workspace({ workspaceId: "WN", cwd: "/n", name: "N" }))).toBe(0);
    });
});

describe("searchWorkspaces", () => {
    const sorted = sortByRecentUse([alpha, bravo, charlie]);

    it("returns everything in the given order when the query is blank", () => {
        expect(searchWorkspaces(sorted, "").map((w) => w.workspaceId)).toEqual(["WB", "WC", "WA"]);
        expect(searchWorkspaces(sorted, "   ").map((w) => w.workspaceId)).toEqual(["WB", "WC", "WA"]);
    });

    it("matches the name case-insensitively", () => {
        expect(searchWorkspaces(sorted, "CHAR").map((w) => w.workspaceId)).toEqual(["WC"]);
    });

    it("matches the cwd, the basename and the id", () => {
        expect(searchWorkspaces(sorted, "/srv").map((w) => w.workspaceId)).toEqual(["WB"]);
        expect(searchWorkspaces(sorted, "alpha").map((w) => w.workspaceId)).toEqual(["WA"]);
        expect(searchWorkspaces(sorted, "wc").map((w) => w.workspaceId)).toEqual(["WC"]);
    });

    it("matches an alias", () => {
        const aliased = workspace({ workspaceId: "WD", cwd: "/x/y", name: "Delta", alias: "delta-nvim" });
        expect(searchWorkspaces([aliased], "nvim").map((w) => w.workspaceId)).toEqual(["WD"]);
    });

    it("requires every whitespace-separated term to hit some field", () => {
        expect(searchWorkspaces(sorted, "work char").map((w) => w.workspaceId)).toEqual(["WC"]);
        expect(searchWorkspaces(sorted, "work charlie extra")).toEqual([]);
    });
});

describe("recency persistence", () => {
    it("round-trips through localStorage and keeps the newest stamps", () => {
        markWorkspaceUsed("WA", 1000);
        markWorkspaceUsed("WB", 2000);
        expect(readWorkspaceRecency()).toEqual({ WA: 1000, WB: 2000 });
        markWorkspaceUsed("WA", 3000);
        expect(readWorkspaceRecency()).toEqual({ WA: 3000, WB: 2000 });
        expect(sortByRecentUse([bravo, alpha], readWorkspaceRecency()).map((w) => w.workspaceId)).toEqual([
            "WA",
            "WB",
        ]);
    });

    it("survives a corrupt payload", () => {
        localStorage.setItem(WORKSPACE_RECENCY_KEY, "{not json");
        expect(readWorkspaceRecency()).toEqual({});
        localStorage.setItem(WORKSPACE_RECENCY_KEY, '{"WA": "nope", "WB": 5}');
        expect(readWorkspaceRecency()).toEqual({ WB: 5 });
    });
});
