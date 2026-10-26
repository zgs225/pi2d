import type { SessionState } from "@protocol/types";
import type { TreeNode } from "@/features/chat/session-tree-model";
import {
    buildSessionTree,
    buildSessionTreeView,
    isSessionActive,
    isSubagentActive,
    subagentPathIds,
    treeNodeId,
} from "@/features/chat/session-tree-model";
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

/* ------------------------------------------------------------------ */
/* IA lens (`activeOnly`) vs plugin policy (`showHidden`)              */
/* ------------------------------------------------------------------ */

describe("active-row predicates", () => {
    it("treats finished/exited sessions as inactive", () => {
        expect(isSessionActive({ status: "busy" })).toBe(true);
        expect(isSessionActive({ status: "idle" })).toBe(true);
        expect(isSessionActive({ status: "exited" })).toBe(false);
        // The plugin can report the terminal words the wire enum does not carry;
        // the predicate is a superset on purpose.
        const status = (value: string) => ({ status: value }) as unknown as Pick<SessionState, "status">;
        expect(isSessionActive(status("done"))).toBe(false);
        expect(isSessionActive(status("dormant"))).toBe(false);
    });

    it("keeps failed/interrupted subagents reachable", () => {
        expect(isSubagentActive({ status: "active" })).toBe(true);
        expect(isSubagentActive({ status: "interrupted" })).toBe(true);
        expect(isSubagentActive({ status: "failed" })).toBe(true);
        expect(isSubagentActive({ status: "completed" })).toBe(false);
        expect(isSubagentActive({ status: "dormant" })).toBe(false);
    });

    it("resolves the manifest path of the subagent in the child view", () => {
        const nested = subagentFixture({ id: "sa1", children: [subagentFixture({ id: "sa2" })] });
        expect(subagentPathIds([nested], "sa2")).toEqual(["sa1", "sa2"]);
        expect(subagentPathIds([nested], "nope")).toEqual([]);
        expect(subagentPathIds([nested], null)).toEqual([]);
    });
});

describe("buildSessionTreeView (IA lens)", () => {
    const lensSessions = () => [
        sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [] }),
        sessionFixture({ sessionId: "s2", name: "Beta", status: "exited", subagents: [] }),
        childOf({ visible: false }),
    ];

    it("drops finished root sessions and reports how many", () => {
        const view = buildSessionTreeView(lensSessions(), { activeOnly: true });

        expect(ids(view.roots)).toEqual(["s1"]);
        expect(view.hiddenSessions).toBe(1);
    });

    it("always keeps the routed session, even when its process is gone", () => {
        const view = buildSessionTreeView(lensSessions(), { activeOnly: true, selectedId: "s2" });

        expect(ids(view.roots)).toEqual(["s1", "s2"]);
        expect(view.hiddenSessions).toBe(0);
    });

    it("drops finished subagents and counts them per parent (+N)", () => {
        const view = buildSessionTreeView(
            [
                sessionFixture({
                    sessionId: "s1",
                    name: "Alpha",
                    subagents: [
                        subagentFixture({ id: "sa1", status: "active" }),
                        subagentFixture({ id: "sa2", status: "completed" }),
                    ],
                }),
            ],
            { activeOnly: true },
        );

        expect(ids(view.roots[0]?.children ?? [])).toEqual(["sa1"]);
        expect(view.roots[0]?.hiddenCount).toBe(1);
    });

    it("keeps the whole path to the subagent in the child view", () => {
        const nested = subagentFixture({
            id: "sa1",
            status: "active",
            children: [subagentFixture({ id: "sa2", status: "completed" })],
        });
        const view = buildSessionTreeView(
            [sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [nested] })],
            // The child view keeps the owning session selected (`?session=`), so the
            // manifest path is resolved from that session.
            { activeOnly: true, selectedId: "s1", viewingSubagentId: "sa2" },
        );

        expect(view.viewingPath).toEqual(["sa1", "sa2"]);
        expect(ids(view.roots[0]?.children ?? [])).toEqual(["sa1"]);
        expect(ids(view.roots[0]?.children[0]?.children ?? [])).toEqual(["sa2"]);
        // Folded parents must still reveal the child view's row.
        expect(view.roots[0]?.forcedOpen).toBe(true);
    });

    it("counts the rows the visibility policy hides", () => {
        expect(buildSessionTreeView(lensSessions(), {}).hiddenByPolicy).toBe(1);
        expect(buildSessionTreeView(lensSessions(), { showHidden: true }).hiddenByPolicy).toBe(0);
    });

    it("keeps activeOnly and showHidden independent in every combination", () => {
        // lens on, policy hiding          → finished root gone, policy row gone
        const both = buildSessionTreeView(lensSessions(), { activeOnly: true, showHidden: false });
        expect(ids(both.roots)).toEqual(["s1"]);
        expect(both.hiddenSessions).toBe(1);
        expect(both.hiddenByPolicy).toBe(1);
        expect(both.roots[0]?.children).toEqual([]);

        // lens off, policy hiding         → finished root back, policy row still gone
        const policyOnly = buildSessionTreeView(lensSessions(), { activeOnly: false, showHidden: false });
        expect(ids(policyOnly.roots)).toEqual(["s1", "s2"]);
        expect(policyOnly.hiddenSessions).toBe(0);
        expect(policyOnly.hiddenByPolicy).toBe(1);

        // lens off, policy shown          → everything renders
        const shown = buildSessionTreeView(lensSessions(), { activeOnly: false, showHidden: true });
        expect(ids(shown.roots)).toEqual(["s1", "s2"]);
        expect(ids(shown.roots[0]?.children ?? [])).toEqual(["c1"]);
        expect(shown.hiddenByPolicy).toBe(0);

        // lens on, policy shown           → the IA filter still wins on finished rows
        const lensShown = buildSessionTreeView(lensSessions(), { activeOnly: true, showHidden: true });
        expect(ids(lensShown.roots)).toEqual(["s1"]);
        expect(ids(lensShown.roots[0]?.children ?? [])).toEqual(["c1"]);
        expect(lensShown.roots[0]?.children[0]?.hidden).toBe(true);
        expect(lensShown.hiddenSessions).toBe(1);
        expect(lensShown.hiddenByPolicy).toBe(0);
    });
});
