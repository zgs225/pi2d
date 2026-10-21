import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setLanguage } from "@/lib/i18n";
import { SessionTree } from "@/features/chat/session-tree";
import { useChatStore } from "@/features/chat/store";
import { ChatPage } from "@/pages/chat";
import { useSessionsStore } from "@/stores/sessions";
import { sessionFixture, subagentFixture } from "./chat-fixtures";
import { mockApi } from "./helpers/api-mock";
import { renderPage } from "./helpers/render-page";

beforeAll(async () => {
    await setLanguage("en");
});

function renderTree(props: Partial<ComponentProps<typeof SessionTree>> = {}) {
    const onSelectSession = vi.fn();
    const onToggleCollapse = vi.fn();
    const onToggleAll = vi.fn();
    const sessions = props.sessions ?? [
        sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [subagentFixture()] }),
        sessionFixture({ sessionId: "s2", name: "Beta", subagents: [] }),
    ];
    const utils = render(
        <SessionTree
            sessions={sessions}
            selectedId="s1"
            filter=""
            collapsed={{}}
            connected
            onFilter={vi.fn()}
            onToggleCollapse={onToggleCollapse}
            onToggleAll={onToggleAll}
            onSelectSession={onSelectSession}
            onNewSession={vi.fn()}
            onRenameSession={vi.fn()}
            onCloseSession={vi.fn()}
            {...props}
        />,
    );
    return { ...utils, sessions, onSelectSession, onToggleCollapse, onToggleAll };
}

describe("session tree", () => {
    it("selects a session and shows the nested subagent", () => {
        const { onSelectSession } = renderTree();
        fireEvent.click(screen.getByRole("button", { name: "Beta" }));
        expect(onSelectSession).toHaveBeenCalledWith("s2");
        expect(screen.getByText("researcher")).toBeInTheDocument();
        expect(screen.getByText("claude-sonnet-4-5 · low")).toBeInTheDocument();
    });

    it("folds a parent without drawing vertical guides", () => {
        const { onToggleCollapse, rerender, sessions } = renderTree();
        const row = screen.getByRole("button", { name: "Alpha" });
        fireEvent.click(within(row).getByLabelText("Collapse"));
        expect(onToggleCollapse).toHaveBeenCalledWith("s1");

        rerender(
            <SessionTree
                sessions={sessions}
                selectedId="s1"
                filter=""
                collapsed={{ s1: true }}
                onFilter={vi.fn()}
                onToggleCollapse={vi.fn()}
                onToggleAll={vi.fn()}
                onSelectSession={vi.fn()}
                onNewSession={vi.fn()}
                onRenameSession={vi.fn()}
                onCloseSession={vi.fn()}
            />,
        );
        expect(screen.queryByText("researcher")).not.toBeInTheDocument();
    });

    it("filters sessions by name and toggles all rows", () => {
        const { onToggleAll } = renderTree({ filter: "Beta" });
        expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
        expect(screen.getByText("Beta")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Collapse or expand all" }));
        expect(onToggleAll).toHaveBeenCalledTimes(1);
    });
});

/* ------------------------------------------------------------------ */
/* Deep links: an unknown session must never borrow another session.  */
/* ------------------------------------------------------------------ */

const BOGUS = "ffffffffffffffffffffffff";
const TS = 1_733_234_400_000;

/** The chat page opens a socket on mount; a silent socket keeps it inert. */
function silentSocket(): void {
    class SilentSocket {
        readyState = 0;
        onopen: ((event: unknown) => void) | null = null;
        onmessage: ((event: { data: unknown }) => void) | null = null;
        onclose: ((event: { code?: number }) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        send(): void {}
        close(): void {
            this.readyState = 3;
        }
    }
    vi.stubGlobal("WebSocket", SilentSocket);
}

function workspaceBody() {
    return [
        {
            workspaceId: "W1",
            cwd: "/work/w1",
            name: "W1",
            trusted: true,
            exists: true,
            sessionCount: 2,
            liveCount: 0,
            lastActiveAt: 0,
            instance: null,
        },
    ];
}

function sessionsBody() {
    return {
        sessions: [
            { sessionId: "s1", name: "Alpha", workspaceId: "W1", cwd: "/work/w1", status: "idle" },
            { sessionId: "s2", name: "Beta", workspaceId: "W1", cwd: "/work/w1", status: "busy" },
        ],
    };
}

function entriesBody(text: string) {
    return {
        entries: [
            {
                type: "message",
                id: "u1",
                timestamp: new Date(TS).toISOString(),
                message: { role: "user", content: text, timestamp: TS },
            },
        ],
        cursor: { hasMore: false },
    };
}

function chatRoutes() {
    return [
        { path: "/chat/$sessionId", component: ChatPage },
        { path: "/chat", component: ChatPage },
        { path: "/workspaces", component: () => <div>Workspaces destination</div> },
    ];
}

function streamPane(): HTMLElement {
    const pane = document.querySelector(".stream-pane");
    if (!pane) throw new Error("the chat layout did not render a stream pane");
    return pane as HTMLElement;
}

function requestedUrls(fetchMock: ReturnType<typeof mockApi>): string[] {
    return fetchMock.mock.calls.map(([input]) => String(input));
}

describe("chat session deep link", () => {
    beforeEach(() => {
        useSessionsStore.getState().reset();
        useChatStore.setState({ history: {}, sending: null, preview: null });
        silentSocket();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("shows an error + retry for an unknown session instead of another session", async () => {
        const fetchMock = mockApi([
            { path: "/api/v1/workspaces", handler: () => ({ body: workspaceBody() }) },
            { path: "/api/v1/workspaces/W1/sessions", handler: () => ({ body: sessionsBody() }) },
            { path: "/api/v1/models", handler: () => ({ body: [] }) },
            { path: /^\/api\/v1\/sessions\/s1\/entries/, handler: () => ({ body: entriesBody("Alpha first message") }) },
        ]);

        await renderPage(chatRoutes(), `/chat/${BOGUS}?workspace=W1`);

        const error = await screen.findByTestId("session-not-found");
        expect(within(error).getByText("Session not found")).toBeInTheDocument();
        expect(within(error).getByRole("button", { name: /retry/i })).toBeInTheDocument();
        // A way back to the workspace list, so the dead end is not a dead end.
        expect(within(error).getByRole("link", { name: /back to workspaces/i })).toHaveAttribute(
            "href",
            "/workspaces",
        );

        // The main area never borrows the first session of the workspace.
        expect(within(streamPane()).queryByText("Alpha")).toBeNull();
        expect(within(streamPane()).queryByText("Alpha first message")).toBeNull();
        expect(streamPane().querySelector(".stream-name")?.textContent ?? "").not.toContain("Alpha");
        // ... and no composer for a session that does not exist.
        expect(within(streamPane()).queryByLabelText("Message input")).toBeNull();
        // No tree row claims to be the current session either.
        expect(document.querySelector('[data-session-id][aria-current="true"]')).toBeNull();
        // The unknown id is never used to fetch entries.
        expect(requestedUrls(fetchMock).some((url) => url.includes(BOGUS))).toBe(false);

        // Retry refetches the session list.
        const listCalls = () =>
            requestedUrls(fetchMock).filter((url) => url.includes("/api/v1/workspaces/W1/sessions")).length;
        const before = listCalls();
        fireEvent.click(within(error).getByTestId("session-not-found-retry"));
        await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
    });

    it("selects the deep-linked session and renders its own history", async () => {
        const fetchMock = mockApi([
            { path: "/api/v1/workspaces", handler: () => ({ body: workspaceBody() }) },
            { path: "/api/v1/workspaces/W1/sessions", handler: () => ({ body: sessionsBody() }) },
            { path: "/api/v1/models", handler: () => ({ body: [] }) },
            { path: /^\/api\/v1\/sessions\/s2\/entries/, handler: () => ({ body: entriesBody("Beta first message") }) },
        ]);

        await renderPage(chatRoutes(), "/chat/s2?workspace=W1");

        await waitFor(() => expect(document.querySelector('[data-session-id="s2"]')).not.toBeNull());
        expect(document.querySelector('[data-session-id="s2"]')).toHaveAttribute("aria-current", "true");
        expect(document.querySelector('[data-session-id="s1"]')).not.toHaveAttribute("aria-current", "true");

        expect(await screen.findByText("Beta first message")).toBeInTheDocument();
        expect(screen.queryByTestId("session-not-found")).toBeNull();
        expect(streamPane().querySelector(".stream-name")).toHaveTextContent("Beta");
        expect(requestedUrls(fetchMock)).toContainEqual(
            expect.stringContaining("/api/v1/sessions/s2/entries"),
        );
    });

    it("keeps the first-session fallback for the /chat index", async () => {
        mockApi([
            { path: "/api/v1/workspaces", handler: () => ({ body: workspaceBody() }) },
            { path: "/api/v1/workspaces/W1/sessions", handler: () => ({ body: sessionsBody() }) },
            { path: "/api/v1/models", handler: () => ({ body: [] }) },
            { path: /^\/api\/v1\/sessions\/s1\/entries/, handler: () => ({ body: entriesBody("Alpha first message") }) },
        ]);

        await renderPage(chatRoutes(), "/chat?workspace=W1");

        expect(await screen.findByText("Alpha first message")).toBeInTheDocument();
        expect(screen.queryByTestId("session-not-found")).toBeNull();
        expect(streamPane().querySelector(".stream-name")).toHaveTextContent("Alpha");
    });

    it("does not flash the error state while the first session fetch is in flight", async () => {
        let release = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        mockApi([
            { path: "/api/v1/workspaces", handler: () => ({ body: workspaceBody() }) },
            {
                path: "/api/v1/workspaces/W1/sessions",
                handler: async () => {
                    await gate;
                    return { body: sessionsBody() };
                },
            },
            { path: "/api/v1/models", handler: () => ({ body: [] }) },
            { path: /^\/api\/v1\/sessions\/s1\/entries/, handler: () => ({ body: entriesBody("Alpha first message") }) },
        ]);

        await renderPage(chatRoutes(), `/chat/${BOGUS}?workspace=W1`);

        // Still loading: no error surface and no borrowed session.
        expect(screen.queryByTestId("session-not-found")).toBeNull();
        expect(streamPane().querySelector(".stream-name")?.textContent ?? "").not.toContain("Alpha");

        release();
        expect(await screen.findByTestId("session-not-found")).toBeInTheDocument();
    });
});
