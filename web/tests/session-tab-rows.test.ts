import { describe, expect, it } from "vitest";

import { normalizeSessionsPayload, tabSessionRows } from "@/features/chat/session-state";

/**
 * `workspace.query{kind:"sessions"}` rows come from the plugin as a union of the
 * workspace's JSONL history and its live sessions. Only the tab-backed component
 * is the nvim session list; everything else is history.
 */

function ids(rows: Record<string, unknown>[]): string[] {
    return rows.map((row) => String(row.sessionId ?? row.session_id ?? row.id));
}

describe("tabSessionRows", () => {
    it("drops disk-only history and keeps the tab-backed row", () => {
        const raw = {
            sessions: [
                { sessionId: "old-1", name: "history one", status: "done" },
                { sessionId: "tab-1", name: "the only tab", tab: 1, live: true, status: "idle" },
                { sessionId: "old-2", name: "history two" },
            ],
        };

        expect(ids(tabSessionRows(raw))).toEqual(["tab-1"]);
    });

    it("drops a live session that owns no tab", () => {
        // A detached background session is not an nvim tab: `:PiSessions` renders
        // it as a child row, never as a root.
        const raw = {
            sessions: [
                { sessionId: "tab-1", tab: 1, live: true },
                { sessionId: "detached", live: true, status: "busy" },
            ],
        };

        expect(ids(tabSessionRows(raw))).toEqual(["tab-1"]);
    });

    it("keeps the sub-sessions linked to a tab, at any depth", () => {
        const raw = {
            sessions: [
                { sessionId: "child", parentId: "tab-1", status: "interrupted" },
                { sessionId: "grandchild", parentId: "child", status: "done" },
                { sessionId: "tab-1", tab: 1, live: true },
                { sessionId: "orphan-history", parentId: "gone", status: "done" },
            ],
        };

        expect(ids(tabSessionRows(raw))).toEqual(["child", "grandchild", "tab-1"]);
    });

    it("keeps the parent row when the tab is in a child view", () => {
        // `view_parent_id`: the tab is attached to the child session, the parent
        // row anchors the tree and its other children stay in the list.
        const raw = {
            sessions: [
                { sessionId: "root", live: true, status: "idle" },
                { sessionId: "viewed-child", parentId: "root", tab: 2, live: true },
                { sessionId: "sibling", parentId: "root", status: "completed" },
            ],
        };

        expect(ids(tabSessionRows(raw))).toEqual(["root", "viewed-child", "sibling"]);
    });

    it("accepts a bare array payload and the snake_case aliases", () => {
        const raw = [
            { session_id: "old" },
            { session_id: "child", parent_id: "tab-1" },
            { session_id: "tab-1", tab: 3 },
        ];

        expect(ids(tabSessionRows(raw))).toEqual(["child", "tab-1"]);
    });

    it("returns no rows when nothing is attached to a tab", () => {
        expect(tabSessionRows({ sessions: [{ sessionId: "old-1" }, { sessionId: "old-2" }] })).toEqual([]);
        expect(tabSessionRows({ sessions: [] })).toEqual([]);
        expect(tabSessionRows(undefined)).toEqual([]);
    });

    it("feeds the render states so a historical row never reaches the tree", () => {
        const states = normalizeSessionsPayload(
            tabSessionRows({
                sessions: [
                    { sessionId: "old-1", name: "history", status: "done" },
                    { sessionId: "tab-1", name: "the only tab", tab: 1, live: true, status: "idle" },
                ],
            }),
            "w1",
        );

        expect(states.map((state) => state.sessionId)).toEqual(["tab-1"]);
        expect(states[0]?.name).toBe("the only tab");
    });
});
