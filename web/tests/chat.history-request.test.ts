import { afterEach, describe, expect, it } from "vitest";

import { fetchEntriesPage, HISTORY_PAGE_SIZE, setSessionMeta } from "@/features/chat/history";

import { mockApi } from "./helpers/api-mock";

const ENTRIES_PATH = /^\/api\/v1\/sessions\/[^/]+\/entries$/;

function page(entries: unknown[] = [], cursor: Record<string, unknown> = { hasMore: false }) {
    return { status: 200, body: { entries, cursor } };
}

afterEach(() => {
    // `sessionMeta` is module state; keep each case's rows isolated.
    for (const id of ["s-hint", "s-meta", "s-cursor", "s-response"]) {
        setSessionMeta(id, { workspaceId: undefined, sessionFile: undefined });
    }
});

describe("history page request", () => {
    it("routes with the caller's workspace hint and the row's session file", async () => {
        setSessionMeta("s-hint", { workspaceId: "ws-meta", sessionFile: "/tmp/s-hint.jsonl" });
        const fetchMock = mockApi([{ path: ENTRIES_PATH, handler: () => page() }]);
        await fetchEntriesPage("s-hint", { workspaceId: "ws-page" });

        const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
        expect(url.pathname).toBe("/api/v1/sessions/s-hint/entries");
        // The page's workspace wins: it is known before the list effect lands.
        expect(url.searchParams.get("workspaceId")).toBe("ws-page");
        expect(url.searchParams.get("sessionFile")).toBe("/tmp/s-hint.jsonl");
        expect(url.searchParams.get("limit")).toBe(String(HISTORY_PAGE_SIZE));
        expect(url.searchParams.has("before")).toBe(false);
    });

    it("falls back to the row's workspace when the caller has none", async () => {
        setSessionMeta("s-meta", { workspaceId: "ws-meta" });
        const fetchMock = mockApi([{ path: ENTRIES_PATH, handler: () => page() }]);
        await fetchEntriesPage("s-meta", {});

        const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
        expect(url.searchParams.get("workspaceId")).toBe("ws-meta");
        expect(url.searchParams.has("sessionFile")).toBe(false);
    });

    it("forwards the before cursor for older pages", async () => {
        const fetchMock = mockApi([{ path: ENTRIES_PATH, handler: () => page() }]);
        await fetchEntriesPage("s-cursor", { before: "e9", limit: 25, workspaceId: "ws-page" });

        const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
        expect(url.searchParams.get("before")).toBe("e9");
        expect(url.searchParams.get("limit")).toBe("25");
    });

    it("projects raw entries and keeps the plugin's cursor", async () => {
        mockApi([
            {
                path: ENTRIES_PATH,
                handler: () =>
                    page(
                        [
                            {
                                type: "message",
                                id: "u1",
                                message: { role: "user", content: "hi", timestamp: 1_733_234_400_000 },
                            },
                        ],
                        { before: "u1", hasMore: true },
                    ),
            },
        ]);
        const result = await fetchEntriesPage("s-response", { workspaceId: "ws-page" });

        expect(result.entries.map((entry) => entry.id)).toEqual(["u1"]);
        expect(result.entries[0]?.role).toBe("user");
        expect(result.cursor).toEqual({ before: "u1", hasMore: true });
    });
});
