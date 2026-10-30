import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEEN_STORAGE_KEY } from "@/features/chat/acknowledged";
import { emptySessionState, normalizeSnapshotState } from "@/features/chat/session-state";
import { useSessionsStore } from "@/stores/sessions";
import { entryFixture, sessionFixture } from "./chat-fixtures";

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

function fixture(
    overrides: Omit<Partial<ReturnType<typeof sessionFixture>>, "flags"> & {
        flags?: Partial<ReturnType<typeof sessionFixture>["flags"]>;
    },
) {
    return sessionFixture({
        ...overrides,
        flags: {
            attention: false,
            done: false,
            error: false,
            ...(overrides.flags ?? {}),
        },
    });
}

describe("sessions store — markSeen", () => {
    it("clears flags.done when seen", () => {
        state().setSessions("w1", [fixture({ sessionId: "s1", workspaceId: "w1", flags: { done: true } })]);
        expect(state().getSession("s1")?.flags.done).toBe(true);

        state().markSeen("s1");
        expect(state().getSession("s1")?.flags).toEqual({
            attention: false,
            done: false,
            error: false,
        });
    });

    it("clears flags.error when seen", () => {
        state().setSessions("w1", [fixture({ sessionId: "s1", workspaceId: "w1", flags: { error: true } })]);
        expect(state().getSession("s1")?.flags.error).toBe(true);

        state().markSeen("s1");
        expect(state().getSession("s1")?.flags).toEqual({
            attention: false,
            done: false,
            error: false,
        });
    });

    it("clears both flags.done and flags.error simultaneously", () => {
        state().setSessions("w1", [
            fixture({ sessionId: "s1", workspaceId: "w1", flags: { done: true, error: true } }),
        ]);

        state().markSeen("s1");
        expect(state().getSession("s1")?.flags).toEqual({
            attention: false,
            done: false,
            error: false,
        });
    });

    it("keeps flags.attention when attention array is non-empty", () => {
        state().setSessions("w1", [
            fixture({
                sessionId: "s1",
                workspaceId: "w1",
                flags: { done: true, attention: true },
                attention: [{ id: "q1" } as any],
            }),
        ]);

        state().markSeen("s1");
        expect(state().getSession("s1")?.flags).toEqual({
            attention: true,
            done: false,
            error: false,
        });
    });

    it("sets flags.attention to true if attention array has items even when flag was false", () => {
        state().setSessions("w1", [
            fixture({
                sessionId: "s1",
                workspaceId: "w1",
                flags: { done: true, attention: false },
                attention: [{ id: "q1" } as any],
            }),
        ]);

        state().markSeen("s1");
        expect(state().getSession("s1")?.flags).toEqual({
            attention: true,
            done: false,
            error: false,
        });
    });

    it("clears stale flags.attention when attention array is empty", () => {
        state().setSessions("w1", [
            fixture({
                sessionId: "s1",
                workspaceId: "w1",
                flags: { attention: true, done: false, error: false },
                attention: [],
            }),
        ]);

        state().markSeen("s1");
        expect(state().getSession("s1")?.flags).toEqual({
            attention: false,
            done: false,
            error: false,
        });
    });

    it("leaves other rows untouched in the same and other workspaces", () => {
        const s1 = fixture({ sessionId: "s1", workspaceId: "w1", flags: { done: true } });
        const s2 = fixture({ sessionId: "s2", workspaceId: "w1", flags: { done: true } });
        const s3 = fixture({ sessionId: "s3", workspaceId: "w2", flags: { error: true } });

        state().setSessions("w1", [s1, s2]);
        state().setSessions("w2", [s3]);

        const s2Before = state().getSession("s2");
        const s3Before = state().getSession("s3");

        state().markSeen("s1");

        expect(state().getSession("s1")?.flags.done).toBe(false);
        // Untouched rows preserve flags and object identity
        expect(state().getSession("s2")).toBe(s2Before);
        expect(state().getSession("s2")?.flags.done).toBe(true);
        expect(state().getSession("s3")).toBe(s3Before);
        expect(state().getSession("s3")?.flags.error).toBe(true);
    });

    it("returns the same state object (identity) and does not notify subscribers when there is nothing to consume", () => {
        state().setSessions("w1", [
            fixture({
                sessionId: "s1",
                workspaceId: "w1",
                flags: { done: false, error: false, attention: false },
                attention: [],
            }),
        ]);

        const before = useSessionsStore.getState();
        const listener = vi.fn();
        const unsub = useSessionsStore.subscribe(listener);

        state().markSeen("s1");

        const after = useSessionsStore.getState();
        expect(after).toBe(before);
        expect(listener).not.toHaveBeenCalled();

        unsub();
    });

    it("is a no-op for an unknown id, returning the same state object without notifying subscribers", () => {
        state().setSessions("w1", [
            fixture({ sessionId: "s1", workspaceId: "w1", flags: { done: true } }),
        ]);

        const before = useSessionsStore.getState();
        const listener = vi.fn();
        const unsub = useSessionsStore.subscribe(listener);

        state().markSeen("unknown-id");

        const after = useSessionsStore.getState();
        expect(after).toBe(before);
        expect(listener).not.toHaveBeenCalled();
        expect(state().getSession("s1")?.flags.done).toBe(true);

        unsub();
    });
});

describe("sessions store — an acknowledged notification never replays", () => {
    const entries = (...ids: string[]) => ids.map((id) => entryFixture({ id }));

    it("keeps done cleared when a reload's snapshot replays the same notification", () => {
        const transcript = entries("e1", "e2");
        state().setSessions("w1", [
            fixture({ sessionId: "s1", workspaceId: "w1", flags: { done: true }, entries: transcript }),
        ]);
        state().markSeen("s1");
        expect(state().getSession("s1")?.flags.done).toBe(false);
        // The occurrence the browser acknowledged is the transcript tail.
        expect(JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? "{}")).toEqual({ s1: "e2" });

        // Page reload: the store is empty, but the plugin still raises `done`
        // until nvim's TabEnter, so the snapshot carries it again.
        state().reset();
        state().upsertSession(
            normalizeSnapshotState("s1", "w1", {
                state: { status: "idle", flags: { attention: false, done: true, error: false }, entries: transcript },
            }),
        );
        expect(state().getSession("s1")?.flags.done).toBe(false);

        // A reconnect replays it too, through the cached-row merge.
        state().upsertSession({
            ...emptySessionState({ sessionId: "s1", workspaceId: "w1" }),
            flags: { attention: false, done: true, error: false },
            entries: transcript,
        });
        expect(state().getSession("s1")?.flags.done).toBe(false);
    });

    it("blinks again once the next turn appends an entry", () => {
        state().setSessions("w1", [
            fixture({ sessionId: "s1", workspaceId: "w1", flags: { done: true }, entries: entries("e1") }),
        ]);
        state().markSeen("s1");

        state().upsertSession({
            ...emptySessionState({ sessionId: "s1", workspaceId: "w1" }),
            status: "idle",
            flags: { attention: false, done: true, error: false },
            entries: entries("e1", "e2"),
        });
        expect(state().getSession("s1")?.flags.done).toBe(true);
    });

    it("re-arms an acknowledged error the same way", () => {
        state().setSessions("w1", [
            fixture({ sessionId: "s1", workspaceId: "w1", flags: { error: true }, entries: entries("e1") }),
        ]);
        state().markSeen("s1");

        state().reset();
        state().upsertSession({
            ...emptySessionState({ sessionId: "s1", workspaceId: "w1" }),
            status: "idle",
            flags: { attention: false, done: false, error: true },
            entries: entries("e1"),
        });
        expect(state().getSession("s1")?.flags.error).toBe(false);

        state().upsertSession({
            ...emptySessionState({ sessionId: "s1", workspaceId: "w1" }),
            status: "idle",
            flags: { attention: false, done: false, error: true },
            entries: entries("e1", "e2"),
        });
        expect(state().getSession("s1")?.flags.error).toBe(true);
    });

    it("carries the acknowledgement across the tmp-N → real-id migration", () => {
        state().setSessions("w1", [
            fixture({ sessionId: "tmp-1", workspaceId: "w1", flags: { done: true }, entries: entries("e1") }),
        ]);
        state().markSeen("tmp-1");
        state().renameSessionId("tmp-1", "real-1");

        state().reset();
        state().upsertSession(
            normalizeSnapshotState("real-1", "w1", {
                state: { status: "idle", flags: { attention: false, done: true, error: false }, entries: entries("e1") },
            }),
        );
        expect(state().getSession("real-1")?.flags.done).toBe(false);
    });

    it("forgets the acknowledgement when the session is removed", () => {
        state().setSessions("w1", [
            fixture({ sessionId: "s1", workspaceId: "w1", flags: { done: true }, entries: entries("e1") }),
        ]);
        state().markSeen("s1");
        state().removeSession("s1");
        expect(JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? "{}")).not.toHaveProperty("s1");
    });
});
