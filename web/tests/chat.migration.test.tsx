import { beforeEach, describe, expect, it } from "vitest";

import { sessionMigration } from "@/features/chat/data";
import { chatSessionPath, migrateSessionId, onSessionMigration, replaceChatUrl } from "@/features/chat/migration";
import { useChatStore } from "@/features/chat/store";
import { useSessionsStore } from "@/stores/sessions";

import { entryFixture, sessionFixture } from "./chat-fixtures";

beforeEach(() => {
    useSessionsStore.getState().reset();
    useChatStore.setState({ history: {}, sending: null, preview: null });
    window.history.replaceState(null, "", "/chat");
});

describe("session id migration (`tmp-N` → real id)", () => {
    it("re-keys the session row, history, in-flight prompt and the URL", () => {
        useSessionsStore.getState().setSessions("w1", [sessionFixture({ sessionId: "tmp-1", name: "New session" })]);
        useChatStore.getState().receiveInitial("tmp-1", [entryFixture({ id: "u1", role: "user" })], {
            before: "u1",
            hasMore: true,
        });
        useChatStore.getState().setSending({ sessionId: "tmp-1", text: "hello" });
        useChatStore.getState().setPreview({ sessionId: "tmp-1", subagentId: "sa1" });
        window.history.replaceState(null, "", "/chat/tmp-1?workspace=w1");

        const seen: string[] = [];
        const off = onSessionMigration((migration) => seen.push(`${migration.from}->${migration.to}`));
        const migration = migrateSessionId("tmp-1", "01a1-real", "w1");
        off();

        expect(seen).toEqual(["tmp-1->01a1-real"]);
        expect(migration?.path).toBe("/chat/01a1-real?workspace=w1");

        // The tree row, the history page and the optimistic chip all followed.
        expect(useSessionsStore.getState().listFor("w1").map((session) => session.sessionId)).toEqual([
            "01a1-real",
        ]);
        expect(useSessionsStore.getState().getSession("tmp-1")).toBeUndefined();
        expect(useChatStore.getState().history["tmp-1"]).toBeUndefined();
        expect(useChatStore.getState().history["01a1-real"]?.entries).toHaveLength(1);
        expect(useChatStore.getState().history["01a1-real"]?.cursor).toEqual({ before: "u1", hasMore: true });
        expect(useChatStore.getState().sending).toEqual({ sessionId: "01a1-real", text: "hello" });
        expect(useChatStore.getState().preview).toEqual({ sessionId: "01a1-real", subagentId: "sa1" });

        expect(replaceChatUrl("tmp-1", "01a1-real", "w1")).toBe(true);
        expect(window.location.pathname + window.location.search).toBe("/chat/01a1-real?workspace=w1");
    });

    it("leaves the URL alone when the route addressed another session", () => {
        window.history.replaceState(null, "", "/chat/other?workspace=w1");
        expect(replaceChatUrl("tmp-1", "01a1-real", "w1")).toBe(false);
        expect(window.location.pathname).toBe("/chat/other");
        expect(chatSessionPath("01a1-real")).toBe("/chat/01a1-real");
    });

    it("is a no-op for the same id and never invents a history slice", () => {
        expect(migrateSessionId("s1", "s1", "w1")).toBeNull();
        expect(useChatStore.getState().history["s1"]).toBeUndefined();
    });

    it("reads the migration announcement off the old-id `pi2:session` event", () => {
        expect(
            sessionMigration("tmp-1", {
                type: "pi2:session",
                session: { sessionId: "01a1-real", previousSessionId: "tmp-1" },
            }),
        ).toEqual({ from: "tmp-1", to: "01a1-real" });

        // A plain patch on the same id is not a migration.
        expect(sessionMigration("s1", { type: "pi2:session", session: { sessionId: "s1" } })).toBeUndefined();
        // A patch about a different session must not steal this subscription.
        expect(
            sessionMigration("tmp-1", {
                type: "pi2:session",
                session: { sessionId: "01a1-real", previousSessionId: "tmp-9" },
            }),
        ).toBeUndefined();
        // Only `pi2:session` announces migrations.
        expect(
            sessionMigration("tmp-1", { type: "pi2:todo", session: { sessionId: "01a1-real" } }),
        ).toBeUndefined();
    });
});
