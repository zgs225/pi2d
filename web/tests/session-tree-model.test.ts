import type { TreeNode } from "@/features/chat/session-tree-model";
import { buildSessionTree, treeNodeId } from "@/features/chat/session-tree-model";
import { sessionFixture, subagentFixture } from "./chat-fixtures";

function ids(nodes: TreeNode[]): string[] {
    return nodes.map((node) => treeNodeId(node));
}

function childOf(overrides: Parameters<typeof sessionFixture>[0] = {}) {
    return sessionFixture({ sessionId: "c1", name: "Child session", parentId: "s1", ...overrides });
}

describe("buildSessionTree", () => {
    it("nests a sub-session under its parent instead of listing it flat", () => {
        const tree = buildSessionTree([
            sessionFixture({ sessionId: "s1", name: "Alpha" }),
            childOf(),
            sessionFixture({ sessionId: "s2", name: "Beta" }),
        ]);

        expect(ids(tree)).toEqual(["s1", "s2"]);
        expect(tree[0]).toMatchObject({ kind: "session", depth: 0, childCount: 1, hidden: false });
        expect(ids(tree[0]?.children ?? [])).toEqual(["c1"]);
        expect(tree[0]?.children[0]).toMatchObject({ kind: "session", depth: 1, hidden: false });
        expect(tree[0]?.children[0]?.session.sessionId).toBe("c1");
    });

    it("hides a sub-session the plugin marked invisible by default", () => {
        const tree = buildSessionTree([
            sessionFixture({ sessionId: "s1", name: "Alpha" }),
            childOf({ visible: false }),
        ]);

        expect(ids(tree)).toEqual(["s1"]);
        expect(tree[0]?.children).toEqual([]);
        expect(tree[0]?.childCount).toBe(0);
    });

    it("always renders the routed sub-session, even when it is hidden", () => {
        const tree = buildSessionTree(
            [sessionFixture({ sessionId: "s1", name: "Alpha" }), childOf({ visible: false })],
            { selectedId: "c1" },
        );

        expect(ids(tree)).toEqual(["s1"]);
        expect(ids(tree[0]?.children ?? [])).toEqual(["c1"]);
        // Kept only because it is selected: flagged hidden for a muted style.
        expect(tree[0]?.children[0]?.hidden).toBe(true);
    });

    it("renders hidden sub-sessions when showHidden is on", () => {
        const tree = buildSessionTree(
            [sessionFixture({ sessionId: "s1", name: "Alpha" }), childOf({ visible: false })],
            { showHidden: true },
        );

        expect(ids(tree[0]?.children ?? [])).toEqual(["c1"]);
        expect(tree[0]?.children[0]?.hidden).toBe(true);
    });

    it("dedupes a manifest subagent against its own child session row", () => {
        const tree = buildSessionTree([
            sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [subagentFixture({ id: "c1" })] }),
            childOf(),
        ]);

        expect(tree).toHaveLength(1);
        // The session row wins; the manifest entry is not rendered a second time.
        expect(ids(tree[0]?.children ?? [])).toEqual(["c1"]);
        expect(tree[0]?.children[0]?.kind).toBe("session");
        expect(tree[0]?.childCount).toBe(1);
    });

    it("renders a manifest subagent that has no session row as a synthetic node", () => {
        const tree = buildSessionTree([
            sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [subagentFixture({ id: "sa1" })] }),
        ]);

        expect(tree[0]?.children[0]).toMatchObject({ kind: "subagent", depth: 1 });
        expect(ids(tree[0]?.children ?? [])).toEqual(["sa1"]);
    });

    it("promotes a child whose parent is not in the list to a root", () => {
        const tree = buildSessionTree([childOf({ parentId: "gone" })]);

        expect(ids(tree)).toEqual(["c1"]);
        expect(tree[0]).toMatchObject({ kind: "session", depth: 0, childCount: 0 });
    });

    it("keeps grandchildren at depth 2 and survives a parent cycle", () => {
        const tree = buildSessionTree([
            sessionFixture({ sessionId: "s1", name: "Alpha" }),
            childOf(),
            sessionFixture({ sessionId: "c2", name: "Grandchild", parentId: "c1" }),
        ]);
        expect(tree[0]?.children[0]?.children[0]).toMatchObject({ kind: "session", depth: 2 });
        expect(tree[0]?.children[0]?.childCount).toBe(1);

        const cyclic = buildSessionTree([
            sessionFixture({ sessionId: "a", parentId: "b" }),
            sessionFixture({ sessionId: "b", parentId: "a" }),
        ]);
        expect(ids(cyclic).sort()).toEqual(["a", "b"]);
    });

    it("keeps the ancestor chain of a filter match, including a hidden child", () => {
        const tree = buildSessionTree(
            [
                sessionFixture({ sessionId: "s1", name: "Alpha" }),
                childOf({ name: "hidden-worker", visible: false }),
                sessionFixture({ sessionId: "s2", name: "Beta" }),
            ],
            { filter: "hidden-work" },
        );

        expect(ids(tree)).toEqual(["s1"]);
        expect(ids(tree[0]?.children ?? [])).toEqual(["c1"]);
        expect(tree[0]?.children[0]?.hidden).toBe(true);
    });

    it("preserves input order and counts rendered children only", () => {
        const tree = buildSessionTree([
            sessionFixture({ sessionId: "s2", name: "Beta" }),
            sessionFixture({ sessionId: "s1", name: "Alpha" }),
            childOf(),
            childOf({ sessionId: "c2", visible: false }),
        ]);

        // No sorting: roots keep the order the list delivered.
        expect(ids(tree)).toEqual(["s2", "s1"]);
        // The hidden child is not rendered, so it is not counted either.
        expect(tree[1]?.childCount).toBe(1);
        expect(ids(tree[1]?.children ?? [])).toEqual(["c1"]);
    });

    it("marks the ancestor chain of the routed row forced-open", () => {
        const tree = buildSessionTree(
            [
                sessionFixture({ sessionId: "s1", name: "Alpha" }),
                childOf(),
                sessionFixture({ sessionId: "c2", name: "Grandchild", parentId: "c1" }),
            ],
            { selectedId: "c2" },
        );

        // The component folds children by default; the path to the routed row
        // must stay open or the selection would silently disappear.
        expect(tree[0]?.forcedOpen).toBe(true);
        expect(tree[0]?.children[0]?.forcedOpen).toBe(true);
        // The routed row itself may be folded by the user like any other row.
        expect(tree[0]?.children[0]?.children[0]?.forcedOpen).toBe(false);
    });

    it("forces folded ancestors open while a filter is active", () => {
        const tree = buildSessionTree(
            [sessionFixture({ sessionId: "s1", name: "Alpha" }), childOf({ name: "child-match" })],
            { filter: "child-match" },
        );

        expect(tree[0]?.forcedOpen).toBe(true);
        expect(ids(tree[0]?.children ?? [])).toEqual(["c1"]);
    });

    it("pins the filter over the routed row (an explicit search wins)", () => {
        const tree = buildSessionTree(
            [sessionFixture({ sessionId: "s1", name: "Alpha" }), childOf()],
            { filter: "zzz", selectedId: "c1" },
        );

        expect(tree).toEqual([]);
    });

    it("renders a duplicated session id once", () => {
        const tree = buildSessionTree([
            sessionFixture({ sessionId: "s1", name: "Alpha" }),
            sessionFixture({ sessionId: "s1", name: "Alpha again" }),
        ]);

        expect(tree).toHaveLength(1);
        expect(tree[0]?.session.name).toBe("Alpha");
    });
});
