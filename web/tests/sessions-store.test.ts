import { beforeEach, describe, expect, it } from "vitest";

import { emptySessionState, normalizeSnapshotState } from "@/features/chat/session-state";
import { useSessionsStore } from "@/stores/sessions";
import { sessionFixture } from "./chat-fixtures";

function state() {
    return useSessionsStore.getState();
}

beforeEach(() => {
    state().reset();
});

describe("sessions store — tree metadata", () => {
    it("keeps parentId/visible/task when an incoming update omits them", () => {
        const child = sessionFixture({
            sessionId: "c1",
            workspaceId: "w1",
            parentId: "s1",
            visible: false,
            task: "Research the auth flow",
        });
        state().setSessions("w1", [child]);

        // A reducer event / `pi2:session` row carries no list metadata.
        state().upsertSession({
            ...emptySessionState({ sessionId: "c1", workspaceId: "w1" }),
            parentId: undefined,
            visible: undefined,
            task: undefined,
            status: "busy",
        });

        expect(state().getSession("c1")).toMatchObject({
            parentId: "s1",
            visible: false,
            task: "Research the auth flow",
            status: "busy",
        });
    });

    it("lets an explicit parentId: null (root) win over the cached parent", () => {
        state().setSessions("w1", [sessionFixture({ sessionId: "c1", workspaceId: "w1", parentId: "s1" })]);

        state().upsertSession({
            ...emptySessionState({ sessionId: "c1", workspaceId: "w1" }),
            parentId: null,
            visible: true,
        });

        expect(state().getSession("c1")?.parentId).toBeNull();
        expect(state().getSession("c1")?.visible).toBe(true);
    });

    it("rewrites child parentIds on the tmp-N → real-id migration", () => {
        state().setSessions("w1", [
            sessionFixture({ sessionId: "tmp-1", workspaceId: "w1" }),
            sessionFixture({ sessionId: "c1", workspaceId: "w1", parentId: "tmp-1" }),
        ]);

        state().renameSessionId("tmp-1", "real-1");

        const list = state().listFor("w1");
        expect(list.map((row) => row.sessionId)).toEqual(["real-1", "c1"]);
        expect(list[1]?.parentId).toBe("real-1");
    });

    it("re-parents children to root when their parent is removed", () => {
        state().setSessions("w1", [
            sessionFixture({ sessionId: "s1", workspaceId: "w1" }),
            sessionFixture({ sessionId: "c1", workspaceId: "w1", parentId: "s1" }),
        ]);

        state().removeSession("s1");

        const list = state().listFor("w1");
        expect(list.map((row) => row.sessionId)).toEqual(["c1"]);
        expect(list[0]?.parentId).toBeNull();
    });

    it("keeps parentId/visible/task from the cached row through a snapshot", () => {
        state().setSessions("w1", [
            sessionFixture({
                sessionId: "c1",
                workspaceId: "w1",
                parentId: "s1",
                visible: false,
                task: "Research the auth flow",
            }),
        ]);

        const snapshot = normalizeSnapshotState(
            "c1",
            "w1",
            { state: { status: "busy", entries: [] } },
            state().getSession("c1"),
        );
        expect(snapshot).toMatchObject({
            parentId: "s1",
            visible: false,
            task: "Research the auth flow",
            status: "busy",
        });

        state().upsertSession(snapshot);
        expect(state().getSession("c1")).toMatchObject({
            parentId: "s1",
            visible: false,
            task: "Research the auth flow",
        });
    });

    it("does not turn a child into a root when the snapshot has no list metadata", () => {
        const child = sessionFixture({ sessionId: "c1", workspaceId: "w1", parentId: "s1", visible: false });

        // No cached row at all: the snapshot alone cannot invent a parent, and
        // must not claim `visible: false` was revoked.
        const bare = normalizeSnapshotState("c1", "w1", { state: { status: "idle" } });
        expect(bare.parentId).toBeNull();
        expect(bare.visible).toBe(true);

        const withRow = normalizeSnapshotState("c1", "w1", { state: { status: "idle" } }, child);
        expect(withRow.parentId).toBe("s1");
        expect(withRow.visible).toBe(false);
    });

    it("does not clobber tree metadata when a fresh empty state is upserted", () => {
        const child = sessionFixture({ sessionId: "c1", workspaceId: "w1", parentId: "s1", visible: false });
        state().setSessions("w1", [child]);

        // `emptySessionState` marks list metadata as "not carried" (undefined),
        // so a cold-start update cannot silently flatten the row to a root.
        state().upsertSession(emptySessionState({ sessionId: "c1", workspaceId: "w1" }));
        expect(state().getSession("c1")?.parentId).toBe("s1");
        expect(state().getSession("c1")?.visible).toBe(false);
    });
});
