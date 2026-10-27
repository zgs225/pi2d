import { describe, expect, it } from "vitest";

import type { SessionState } from "@protocol/types";
import {
    compareSiblings,
    effectiveParentOf,
    firstRootSession,
    orderSessions,
    type SiblingItem,
} from "@/features/chat/session-order";
import { emptySessionState } from "@/features/chat/session-state";

/** Minimal session row: only list metadata (`tab`, `createdAt`, `parentId`) matters here. */
function session(overrides: Partial<SessionState> & { sessionId: string }): SessionState {
    const { sessionId, ...rest } = overrides;
    return { ...emptySessionState({ sessionId, workspaceId: "w1" }), ...rest };
}

function ids(sessions: readonly SessionState[]): string[] {
    return sessions.map((s) => s.sessionId);
}

function sibling(id: string, createdAt?: number | null): SiblingItem {
    return createdAt === undefined ? { id } : { createdAt, id };
}

/** Deterministic Fisher–Yates shuffle (LCG seed) so a failure is reproducible. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
    const out = [...items];
    let state = seed;
    for (let i = out.length - 1; i > 0; i -= 1) {
        state = (state * 1103515245 + 12345) % 2147483648;
        const j = state % (i + 1);
        const a = out[i]!;
        out[i] = out[j]!;
        out[j] = a;
    }
    return out;
}

describe("orderSessions — root rank (tab ASC)", () => {
    it("orders roots by tab ascending and puts tabless roots last", () => {
        const rows = [
            session({ sessionId: "r3", tab: 3 }),
            session({ sessionId: "plain" }),
            session({ sessionId: "r1", tab: 1 }),
            session({ sessionId: "r2", tab: 2 }),
        ];

        expect(ids(orderSessions(rows))).toEqual(["r1", "r2", "r3", "plain"]);
    });

    it("ignores a non-positive or non-finite own tab", () => {
        const rows = [
            session({ sessionId: "b_zero", tab: 0 }),
            session({ sessionId: "tabbed", tab: 4 }),
            session({ sessionId: "b_negative", tab: -2 }),
            session({ sessionId: "b_nan", tab: Number.NaN }),
            session({ sessionId: "b_null", tab: null }),
        ];

        // All the tabless rows tie at rank +Infinity, so plain code-unit id order decides.
        expect(ids(orderSessions(rows))).toEqual(["tabbed", "b_nan", "b_negative", "b_null", "b_zero"]);
    });

    it("lets a child-view parent inherit the smallest tab of its descendants", () => {
        const rows = [
            session({ sessionId: "q", tab: 5 }),
            session({ sessionId: "p" }),
            session({ sessionId: "c", parentId: "p", tab: 2 }),
        ];

        // `p` has no tab of its own but its subtree does: it lands at slot 2, before `q`.
        expect(ids(orderSessions(rows))).toEqual(["p", "c", "q"]);
    });

    it("places a lineage at the earliest tab it occupies (smaller descendant tab wins over root tab)", () => {
        const rows = [
            session({ sessionId: "q", tab: 4 }),
            session({ sessionId: "p", tab: 7 }),
            session({ sessionId: "c", parentId: "p", tab: 2 }),
        ];

        // Lineage p occupies tab 2 (via child c) and tab 7 (own tab); earliest is 2, so p lands before q (tab 4).
        expect(ids(orderSessions(rows))).toEqual(["p", "c", "q"]);
    });

    it("prefers tabRank over a conflicting tab handle", () => {
        // Visual tabline rank reflects :tabmove / mid-tabline insertion; handle is legacy fallback.
        const rows = [
            session({ sessionId: "moved_right", tab: 1, tabRank: 3 }),
            session({ sessionId: "moved_left", tab: 5, tabRank: 1 }),
        ];

        expect(ids(orderSessions(rows))).toEqual(["moved_left", "moved_right"]);
    });

    it("falls back to tab handle when tabRank is absent", () => {
        const rows = [
            session({ sessionId: "b", tab: 2 }),
            session({ sessionId: "a", tab: 1 }),
        ];

        expect(ids(orderSessions(rows))).toEqual(["a", "b"]);
    });

    it("orders mixed rows with tabRank and legacy tab handles deterministically", () => {
        const rows = [
            session({ sessionId: "rank2", tabRank: 2, tab: 9 }),
            session({ sessionId: "handle1", tab: 1 }),
            session({ sessionId: "rank3", tabRank: 3 }),
        ];

        expect(ids(orderSessions(rows))).toEqual(["handle1", "rank2", "rank3"]);
    });

    it("inherits the minimum tab across the whole subtree, not just direct children", () => {
        const rows = [
            session({ sessionId: "other", tab: 6 }),
            session({ sessionId: "p" }),
            session({ sessionId: "c", parentId: "p", tab: 8 }),
            session({ sessionId: "g", parentId: "c", tab: 3 }),
        ];

        expect(ids(orderSessions(rows))).toEqual(["p", "c", "g", "other"]);
    });
});

describe("orderSessions — root tie-break chain", () => {
    it("sorts equal rank by createdAt DESC, then lastActiveAt DESC, then sessionId ASC", () => {
        const rows = [
            session({ sessionId: "b", createdAt: 100, lastActiveAt: 1_000 }),
            session({ sessionId: "a", createdAt: 100, lastActiveAt: 1_000 }),
            session({ sessionId: "c", createdAt: 100, lastActiveAt: 2_000 }),
            session({ sessionId: "d", createdAt: 300, lastActiveAt: 500 }),
            session({ sessionId: "e", lastActiveAt: 9_999 }),
            session({ sessionId: "f" }),
        ];

        expect(ids(orderSessions(rows))).toEqual(["d", "c", "a", "b", "e", "f"]);
    });

    it("applies the same tie-break chain when the equal rank comes from a tab", () => {
        const rows = [
            session({ sessionId: "b", tab: 1, createdAt: 100, lastActiveAt: 5 }),
            session({ sessionId: "a", tab: 1, createdAt: 100, lastActiveAt: 9 }),
            session({ sessionId: "c", tab: 1, createdAt: 200, lastActiveAt: 1 }),
        ];

        expect(ids(orderSessions(rows))).toEqual(["c", "a", "b"]);
    });
});

describe("compareSiblings", () => {
    it("sorts createdAt DESC and puts missing createdAt last", () => {
        expect([sibling("old", 1), sibling("new", 9), sibling("none")].sort(compareSiblings).map((s) => s.id)).toEqual([
            "new",
            "old",
            "none",
        ]);
        expect(compareSiblings(sibling("dated", 1), sibling("none"))).toBeLessThan(0);
        expect(compareSiblings(sibling("none"), sibling("dated", 1))).toBeGreaterThan(0);
        // Two missing createdAt values fall back to id ASC.
        expect(compareSiblings(sibling("none"), sibling("alsoNone", null))).toBeGreaterThan(0);
    });

    it("tie-breaks equal createdAt (and missing createdAt) by id ascending", () => {
        expect(compareSiblings(sibling("a", 5), sibling("b", 5))).toBeLessThan(0);
        expect(compareSiblings(sibling("b", 5), sibling("a", 5))).toBeGreaterThan(0);
        expect(compareSiblings(sibling("a", 5), sibling("a", 5))).toBe(0);
        expect(compareSiblings(sibling("b"), sibling("a"))).toBeGreaterThan(0);
        // Plain code-unit comparison: "B" (0x42) sorts before "a" (0x61), unlike localeCompare.
        expect(compareSiblings(sibling("B", 1), sibling("a", 1))).toBeLessThan(0);
    });

    it("is a total order: every shuffled permutation sorts to the same sequence", () => {
        const items: SiblingItem[] = [
            sibling("a", 3),
            sibling("b", 3),
            sibling("c", 9),
            sibling("d"),
            sibling("e", null),
            sibling("f", 1),
        ];
        const expected = ["c", "a", "b", "f", "d", "e"];

        for (let seed = 1; seed <= 20; seed += 1) {
            expect(shuffled(items, seed).sort(compareSiblings).map((s) => s.id)).toEqual(expected);
        }
    });
});

describe("orderSessions — subtree flattening", () => {
    it("emits a parent then its children by createdAt DESC, grandchildren nested", () => {
        const rows = [
            session({ sessionId: "root", tab: 1, createdAt: 10 }),
            session({ sessionId: "childOld", parentId: "root", createdAt: 1 }),
            session({ sessionId: "childNew", parentId: "root", createdAt: 5 }),
            session({ sessionId: "grand1", parentId: "childOld", createdAt: 2 }),
            session({ sessionId: "grand2", parentId: "childOld", createdAt: 3 }),
            session({ sessionId: "grandNoDate", parentId: "childOld" }),
        ];

        const ordered = orderSessions(rows);

        expect(ids(ordered)).toEqual(["root", "childNew", "childOld", "grand2", "grand1", "grandNoDate"]);
        // No row is dropped.
        expect([...ids(ordered)].sort()).toEqual([...ids(rows)].sort());
    });

    it("tie-breaks equal createdAt siblings by sessionId ASC", () => {
        const rows = [
            session({ sessionId: "root", tab: 1 }),
            session({ sessionId: "c_b", parentId: "root", createdAt: 7 }),
            session({ sessionId: "c_a", parentId: "root", createdAt: 7 }),
            session({ sessionId: "c_c", parentId: "root" }),
        ];

        expect(ids(orderSessions(rows))).toEqual(["root", "c_a", "c_b", "c_c"]);
    });

    it("keeps a grandchild under its own parent, not directly under the root", () => {
        const rows = [
            session({ sessionId: "root", tab: 1 }),
            session({ sessionId: "c1", parentId: "root", createdAt: 2 }),
            session({ sessionId: "c2", parentId: "root", createdAt: 1 }),
            session({ sessionId: "g1", parentId: "c2" }),
        ];

        expect(ids(orderSessions(rows))).toEqual(["root", "c1", "c2", "g1"]);
    });

    it("renders a duplicate sessionId once, keeping the first occurrence", () => {
        const rows = [
            session({ sessionId: "root", tab: 1 }),
            session({ sessionId: "dup", parentId: "root", createdAt: 1 }),
            session({ sessionId: "dup", parentId: "root", createdAt: 999 }),
        ];

        const ordered = orderSessions(rows);

        expect(ids(ordered)).toEqual(["root", "dup"]);
        expect(ordered[1]?.createdAt).toBe(1);
    });

    it("terminates on a parent cycle and renders both rows exactly once", () => {
        const ordered = orderSessions([
            session({ sessionId: "a", parentId: "b" }),
            session({ sessionId: "b", parentId: "a" }),
        ]);

        expect(ids(ordered)).toEqual(["a", "b"]);
    });

    it("keeps every row of a 3-cycle plus a child of the cycle", () => {
        const rows = [
            session({ sessionId: "a", parentId: "b" }),
            session({ sessionId: "b", parentId: "c" }),
            session({ sessionId: "c", parentId: "a" }),
            session({ sessionId: "x", parentId: "a" }),
        ];
        const ordered = orderSessions(rows);
        const index = new Map(rows.map((r) => [r.sessionId, r]));

        expect(ordered).toHaveLength(4);
        expect([...ids(ordered)].sort()).toEqual(["a", "b", "c", "x"]);
        // Cycle-breaking promotes every member and child of the cycle to a root ('never lose a row').
        expect(effectiveParentOf(rows[3]!, index)).toBeNull();
    });

    it("treats a self-parent row as a root", () => {
        const ordered = orderSessions([
            session({ sessionId: "self", parentId: "self" }),
            session({ sessionId: "other", tab: 1 }),
        ]);

        expect(ids(ordered)).toEqual(["other", "self"]);
    });
});

describe("orderSessions — determinism", () => {
    it("yields the same id sequence for 20 shuffles of the same input", () => {
        const rows = [
            session({ sessionId: "r1", tab: 2, createdAt: 50 }),
            session({ sessionId: "c1", parentId: "r1", createdAt: 20 }),
            session({ sessionId: "c2", parentId: "r1", createdAt: 30 }),
            session({ sessionId: "g2", parentId: "c2", createdAt: 5 }),
            session({ sessionId: "g3", parentId: "c2" }),
            session({ sessionId: "r2", createdAt: 400 }),
            session({ sessionId: "g1", parentId: "r2", tab: 3 }),
            session({ sessionId: "r3", createdAt: 100 }),
        ];
        const expected = ["r1", "c2", "g2", "g3", "c1", "r2", "g1", "r3"];

        expect(ids(orderSessions(rows))).toEqual(expected);
        for (let seed = 1; seed <= 20; seed += 1) {
            expect(ids(orderSessions(shuffled(rows, seed)))).toEqual(expected);
        }
    });
});

describe("firstRootSession", () => {
    it("returns the first ordered root, skipping children that sort earlier", () => {
        const rows = [
            session({ sessionId: "child", parentId: "root", createdAt: 9_999 }),
            session({ sessionId: "root", createdAt: 1 }),
        ];

        expect(firstRootSession(rows)?.sessionId).toBe("root");
        expect(ids(orderSessions(rows))).toEqual(["root", "child"]);
    });

    it("returns undefined for an empty list", () => {
        expect(firstRootSession([])).toBeUndefined();
    });
});

describe("effectiveParentOf", () => {
    function indexOf(rows: readonly SessionState[]): Map<string, SessionState> {
        return new Map(rows.map((row) => [row.sessionId, row]));
    }

    it("returns the parent id when the parent exists", () => {
        const rows = [
            session({ sessionId: "root" }),
            session({ sessionId: "child", parentId: "root" }),
            session({ sessionId: "grand", parentId: "child" }),
        ];
        const index = indexOf(rows);

        expect(effectiveParentOf(rows[1]!, index)).toBe("root");
        // The direct parent is reported, never the grandparent.
        expect(effectiveParentOf(rows[2]!, index)).toBe("child");
    });

    it("returns null for a missing parent, a null parent and a self parent", () => {
        const orphan = session({ sessionId: "orphan", parentId: "gone" });
        const root = session({ sessionId: "root" });
        const self = session({ sessionId: "self", parentId: "self" });
        const index = indexOf([orphan, root, self]);

        expect(effectiveParentOf(orphan, index)).toBeNull();
        expect(effectiveParentOf(root, index)).toBeNull();
        expect(effectiveParentOf(self, index)).toBeNull();
    });

    it("returns null when the parent chain forms a cycle", () => {
        const a = session({ sessionId: "a", parentId: "b" });
        const b = session({ sessionId: "b", parentId: "a" });
        const index = indexOf([a, b]);

        expect(effectiveParentOf(a, index)).toBeNull();
        expect(effectiveParentOf(b, index)).toBeNull();
    });
});
