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

const workspaceFixture = () => ({
    workspaceId: "W1",
    cwd: "/work/w1",
    name: "W1",
    trusted: true,
    exists: true,
    sessionCount: 2,
    liveCount: 0,
    lastActiveAt: 0,
    instance: null,
});

const defaultSessions = () => [
    sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [subagentFixture()] }),
    sessionFixture({ sessionId: "s2", name: "Beta", subagents: [] }),
];

/** The tree element with inert handlers, so a test can rerender with new props. */
function treeElement(overrides: Partial<ComponentProps<typeof SessionTree>> = {}) {
    return (
        <SessionTree
            sessions={defaultSessions()}
            workspaces={[workspaceFixture()]}
            activeWorkspaceId="W1"
            selectedId="s1"
            activeSubagentId={null}
            filter=""
            collapsed={{}}
            activeOnly={false}
            showHidden={false}
            connected
            creating={false}
            onFilter={vi.fn()}
            onToggleCollapse={vi.fn()}
            onToggleAll={vi.fn()}
            onToggleActiveOnly={vi.fn()}
            onToggleShowHidden={vi.fn()}
            onSelectSession={vi.fn()}
            onSelectWorkspace={vi.fn()}
            onSelectSubagent={vi.fn()}
            onNewSession={vi.fn()}
            onRenameSession={vi.fn()}
            onCloseSession={vi.fn()}
            onDispatchSubagent={vi.fn()}
            onRenameSubagent={vi.fn()}
            {...overrides}
        />
    );
}

function renderTree(overrides: Partial<ComponentProps<typeof SessionTree>> = {}) {
    const spies = {
        onSelectSession: vi.fn(),
        onSelectSubagent: vi.fn(),
        onToggleCollapse: vi.fn(),
        onToggleAll: vi.fn(),
        onToggleActiveOnly: vi.fn(),
        onToggleShowHidden: vi.fn(),
        onRenameSession: vi.fn(),
        onCloseSession: vi.fn(),
        onDispatchSubagent: vi.fn(),
        onFilter: vi.fn(),
    };
    const sessions = overrides.sessions ?? defaultSessions();
    const utils = render(treeElement({ ...spies, sessions, ...overrides }));
    return { ...utils, sessions, ...spies };
}

/** `SessionState` for a sub-session row (`parentId` set, `visible` defaults true). */
function childSession(overrides: Parameters<typeof sessionFixture>[0] = {}) {
    return sessionFixture({ sessionId: "c1", name: "Child session", parentId: "s1", ...overrides });
}

function row(sessionId: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
    if (!element) throw new Error(`no tree row for ${sessionId}`);
    return element;
}

function rowMain(sessionId: string): HTMLElement {
    const element = row(sessionId).querySelector<HTMLElement>(".tree-row__main");
    if (!element) throw new Error(`no main button in row ${sessionId}`);
    return element;
}

function moreButton(sessionId: string): HTMLElement {
    const element = row(sessionId).querySelector<HTMLElement>(".t-more");
    if (!element) throw new Error(`no … button in row ${sessionId}`);
    return element;
}

function menu(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-testid="session-row-menu"]');
}

function menuItem(action: string): HTMLElement {
    const element = menu()?.querySelector<HTMLElement>(`[data-menu-action="${action}"]`);
    if (!element) throw new Error(`no menu item ${action}`);
    return element;
}

function menuItems(): HTMLElement[] {
    return Array.from(menu()?.querySelectorAll<HTMLElement>("[data-menu-item]") ?? []);
}

describe("session tree rows", () => {
    it("renders every session row as a single line: dot + name + attention", () => {
        renderTree({
            sessions: [
                sessionFixture({
                    sessionId: "s1",
                    name: "Alpha",
                    subagents: [],
                    attention: [
                        { requestId: "r1", method: "ask", createdAt: 1, receivedAt: 2 },
                        { requestId: "r2", method: "ask", createdAt: 3, receivedAt: 4 },
                    ],
                }),
                sessionFixture({ sessionId: "s2", name: "Beta", subagents: [] }),
            ],
            selectedId: "s1",
        });

        const main = rowMain("s1");
        // Single line: dot + name + `!N` only.
        expect(main.querySelector(".dot")).not.toBeNull();
        expect(main.querySelector(".t-name")).toHaveTextContent("Alpha");
        expect(main.querySelector(".t-attn")).toHaveTextContent("!2");
        // No second line, no child count, no inline row actions.
        expect(main.querySelector(".t-sub")).toBeNull();
        expect(main.querySelector(".t-meta")).toBeNull();
        expect(row("s1").querySelector(".t-actions")).toBeNull();
        expect(row("s1").querySelector(".badge")).toBeNull();
        // model · thinking moved into the tooltip.
        expect(main.textContent ?? "").not.toContain("claude-sonnet-4-5");
        expect(main.getAttribute("title")).toContain("claude-sonnet-4-5");

        // The row is toggle + main + `…`, nothing else.
        const rowChildren = Array.from(row("s1").children);
        expect(rowChildren).toHaveLength(3);
        expect(rowChildren[0]).toHaveClass("tree-toggle");
        expect(rowChildren[1]).toHaveClass("tree-row__main");
        expect(rowChildren[2]).toHaveClass("t-more");

        // A row without attention keeps no badge at all.
        expect(rowMain("s2").querySelector(".t-attn")).toBeNull();
    });

    it("draws child rows as a single line without a child-count badge", () => {
        renderTree({
            sessions: [sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [] }), childSession()],
        });

        const childRow = row("c1");
        expect(childRow).toHaveClass("tree-row", "tree-row--sub", "sub-d1");
        expect(within(childRow).getByText("Child session")).toBeInTheDocument();
        expect(childRow.querySelector(".t-sub")).toBeNull();
        expect(childRow.querySelector(".t-meta")).toBeNull();
        // The old "(1)" child-count badge is gone; the toggle reads as fold/unfold.
        expect(screen.queryByText("(1)")).toBeNull();
    });

    it("selects a session, a child session and a subagent", () => {
        const { onSelectSession, onSelectSubagent } = renderTree();

        fireEvent.click(rowMain("s2"));
        expect(onSelectSession).toHaveBeenCalledWith("s2");

        // Manifest subagent row navigates to the in-place child view.
        const subRow = document.querySelector<HTMLElement>('[data-subagent-id="sa1"]');
        fireEvent.click((subRow as HTMLElement).querySelector(".tree-row__main") as HTMLElement);
        expect(onSelectSubagent).toHaveBeenCalledWith("s1", "sa1");
    });

    it("folds a parent without drawing vertical guides", () => {
        const { onToggleCollapse, rerender, sessions } = renderTree();
        fireEvent.click(within(row("s1")).getByLabelText("Collapse"));
        expect(onToggleCollapse).toHaveBeenCalledWith("s1");

        rerender(treeElement({ sessions, collapsed: { s1: true } }));
        expect(screen.queryByText("researcher")).not.toBeInTheDocument();
    });

    it("filters sessions by name and toggles all rows", () => {
        const { onToggleAll } = renderTree({
            filter: "Beta",
            // No children: a parent with a rendered child is kept as the match's
            // ancestor, which is a different (tree) rule than the name filter.
            sessions: [
                sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [] }),
                sessionFixture({ sessionId: "s2", name: "Beta", subagents: [] }),
            ],
        });
        expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
        expect(screen.getByText("Beta")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Collapse or expand all" }));
        expect(onToggleAll).toHaveBeenCalledTimes(1);
    });

    it("nests a child session under its parent and opens its own transcript", () => {
        const { onSelectSession } = renderTree({
            sessions: [sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [] }), childSession()],
        });

        const childRow = row("c1");
        expect(row("s1").closest("li")).toContainElement(childRow);
        expect(row("s1").parentElement?.querySelector("ul")).toContainElement(childRow);

        fireEvent.click(rowMain("c1"));
        expect(onSelectSession).toHaveBeenCalledWith("c1");
    });

    it("keeps the routed child row visible under a folded parent", () => {
        renderTree({
            sessions: [sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [] }), childSession()],
            collapsed: { s1: true },
            selectedId: "c1",
        });

        // A fold must never hide the row the route points at.
        expect(row("c1")).not.toBeNull();
        expect(rowMain("c1")).toHaveAttribute("aria-current", "true");
    });

    it("renders a sub-session once when the manifest lists it too", () => {
        renderTree({
            sessions: [
                sessionFixture({
                    sessionId: "s1",
                    name: "Alpha",
                    subagents: [subagentFixture({ id: "c1" })],
                }),
                childSession(),
            ],
        });

        expect(document.querySelectorAll('[data-session-id="c1"]')).toHaveLength(1);
        expect(document.querySelectorAll("[data-subagent-id]")).toHaveLength(0);
    });
});

describe("session tree IA filters", () => {
    /** One live root, one finished root, one root whose only child is policy-hidden. */
    const lensSessions = () => [
        sessionFixture({ sessionId: "s1", name: "Alpha", subagents: [] }),
        sessionFixture({ sessionId: "s2", name: "Beta", status: "exited", subagents: [] }),
        childSession({ visible: false }),
    ];

    it("keeps activeOnly and showHidden independent", () => {
        const sessions = lensSessions();
        const { rerender } = renderTree({ sessions, activeOnly: true, showHidden: false, selectedId: null });

        // activeOnly drops the finished session, showHidden keeps the policy-hidden child out.
        expect(document.querySelector('[data-session-id="s1"]')).not.toBeNull();
        expect(document.querySelector('[data-session-id="s2"]')).toBeNull();
        expect(document.querySelector('[data-session-id="c1"]')).toBeNull();
        expect(screen.getByTestId("tree-hidden-sessions")).toBeInTheDocument();
        expect(screen.getByTestId("tree-hidden-policy")).toBeInTheDocument();

        // Turning the IA lens off must not reveal policy-hidden rows.
        rerender(treeElement({ sessions, activeOnly: false, showHidden: false, selectedId: null }));
        expect(document.querySelector('[data-session-id="s2"]')).not.toBeNull();
        expect(document.querySelector('[data-session-id="c1"]')).toBeNull();
        expect(screen.queryByTestId("tree-hidden-sessions")).toBeNull();
        expect(screen.getByTestId("tree-hidden-policy")).toBeInTheDocument();

        // Turning showHidden on must not resurrect the IA-filtered session.
        rerender(treeElement({ sessions, activeOnly: true, showHidden: true, selectedId: null }));
        expect(document.querySelector('[data-session-id="s2"]')).toBeNull();
        const child = document.querySelector<HTMLElement>('[data-session-id="c1"]');
        expect(child).not.toBeNull();
        expect(child).toHaveAttribute("data-hidden", "true");
        expect(screen.getByTestId("tree-hidden-sessions")).toBeInTheDocument();
        expect(screen.queryByTestId("tree-hidden-policy")).toBeNull();
    });

    it("exposes the two filters through the hidden-count affordances", () => {
        const sessions = lensSessions();
        const { onToggleActiveOnly, onToggleShowHidden } = renderTree({
            sessions,
            activeOnly: true,
            showHidden: false,
            selectedId: null,
        });

        fireEvent.click(screen.getByTestId("tree-hidden-sessions"));
        expect(onToggleActiveOnly).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByTestId("tree-hidden-policy"));
        expect(onToggleShowHidden).toHaveBeenCalledTimes(1);
    });

    it("offers a way out when the active lens hides every session", () => {
        const { onToggleActiveOnly } = renderTree({
            sessions: [sessionFixture({ sessionId: "s2", name: "Beta", status: "exited" })],
            activeOnly: true,
            selectedId: null,
        });

        expect(document.querySelector("[data-session-id]")).toBeNull();
        const empty = document.querySelector<HTMLElement>(".pane-scroll .empty");
        expect(empty).not.toBeNull();
        fireEvent.click(within(empty as HTMLElement).getByRole("button"));
        expect(onToggleActiveOnly).toHaveBeenCalledTimes(1);
    });

    it("offers the show-hidden toggle when the policy hides every session", () => {
        const { onToggleShowHidden } = renderTree({
            sessions: [childSession({ parentId: null, visible: false })],
            activeOnly: false,
            selectedId: null,
        });

        expect(document.querySelector("[data-session-id]")).toBeNull();
        const empty = document.querySelector<HTMLElement>(".pane-scroll .empty");
        expect(empty).not.toBeNull();
        fireEvent.click(within(empty as HTMLElement).getByRole("button"));
        expect(onToggleShowHidden).toHaveBeenCalledTimes(1);
    });

    it("keeps the search empty state separate from the filter empty state", () => {
        renderTree({
            filter: "zzz",
            sessions: [sessionFixture({ sessionId: "s2", name: "Beta", subagents: [] })],
        });
        const empty = document.querySelector<HTMLElement>(".pane-scroll .empty");
        expect(empty).not.toBeNull();
        // No action button: a bad keyword is not a lens problem.
        expect(within(empty as HTMLElement).queryByRole("button")).toBeNull();
    });
});

describe("session row actions popover", () => {
    it("is portalled to the body, anchored to the row, with radio checks", () => {
        renderTree({ activeOnly: false });

        fireEvent.click(moreButton("s1"));

        const pop = menu();
        expect(pop).not.toBeNull();
        // Body-level: never clipped by the tree's scroll container.
        expect(pop?.parentElement).toBe(document.body);
        expect(row("s1").contains(pop as HTMLElement)).toBe(false);
        expect(pop).toHaveAttribute("role", "menu");
        expect(pop).toHaveAttribute("aria-label", "Manage");
        // position: fixed with an inline left/top computed from the anchor.
        expect(pop?.className).toContain("tree-pop");
        expect((pop as HTMLElement).style.left).toMatch(/px$/);
        expect((pop as HTMLElement).style.top).toMatch(/px$/);

        // Row state: is-menu + aria-expanded on the trigger.
        expect(row("s1")).toHaveClass("is-menu");
        expect(moreButton("s1")).toHaveAttribute("aria-expanded", "true");

        // Five items; the two filter entries are radios, exactly one is checked.
        expect(menuItems()).toHaveLength(5);
        const radios = pop?.querySelectorAll('[role="menuitemradio"]') ?? [];
        expect(radios).toHaveLength(2);
        expect(radios[0]).toHaveAttribute("aria-checked", "false");
        expect(radios[1]).toHaveAttribute("aria-checked", "true");
        expect(pop?.querySelectorAll('[role="menuitem"]')).toHaveLength(3);

        // Clicking the trigger again closes it.
        fireEvent.click(moreButton("s1"));
        expect(menu()).toBeNull();
        expect(moreButton("s1")).toHaveAttribute("aria-expanded", "false");
    });

    it("focuses the first item and wraps with ↑/↓/Home/End", () => {
        renderTree();
        fireEvent.click(moreButton("s1"));

        const pop = menu() as HTMLElement;
        expect(document.activeElement).toBe(menuItems()[0]);

        fireEvent.keyDown(pop, { key: "ArrowDown" });
        expect(document.activeElement).toBe(menuItems()[1]);
        fireEvent.keyDown(pop, { key: "End" });
        expect(document.activeElement).toBe(menuItems()[4]);
        fireEvent.keyDown(pop, { key: "ArrowDown" });
        expect(document.activeElement).toBe(menuItems()[0]);
        fireEvent.keyDown(pop, { key: "ArrowUp" });
        expect(document.activeElement).toBe(menuItems()[4]);
        fireEvent.keyDown(pop, { key: "Home" });
        expect(document.activeElement).toBe(menuItems()[0]);
    });

    it("closes on Esc and hands focus back to the … button", () => {
        renderTree();
        fireEvent.click(moreButton("s1"));

        fireEvent.keyDown(menu() as HTMLElement, { key: "Escape" });

        expect(menu()).toBeNull();
        expect(moreButton("s1")).toHaveAttribute("aria-expanded", "false");
        expect(row("s1")).not.toHaveClass("is-menu");
        expect(document.activeElement).toBe(moreButton("s1"));
    });

    it("closes on Tab (focus returns to the trigger) and on an outside click", () => {
        renderTree();
        fireEvent.click(moreButton("s1"));
        fireEvent.keyDown(menu() as HTMLElement, { key: "Tab" });
        expect(menu()).toBeNull();
        expect(document.activeElement).toBe(moreButton("s1"));

        fireEvent.click(moreButton("s1"));
        fireEvent.pointerDown(document.body);
        expect(menu()).toBeNull();
    });

    it("closes when the tree scrolls or the window resizes", () => {
        renderTree();
        fireEvent.click(moreButton("s1"));
        fireEvent.scroll(window);
        expect(menu()).toBeNull();

        fireEvent.click(moreButton("s1"));
        fireEvent(window, new Event("resize"));
        expect(menu()).toBeNull();
    });

    it("runs the filter radios through onToggleActiveOnly", () => {
        const { onToggleActiveOnly } = renderTree({ activeOnly: false });
        fireEvent.click(moreButton("s1"));

        // "Active only" is unchecked → choosing it flips the lens.
        fireEvent.click(menuItem("active-only"));
        expect(onToggleActiveOnly).toHaveBeenCalledTimes(1);
        expect(menu()).toBeNull();
    });

    it("dispatches, renames and closes through the host callbacks", () => {
        const { onDispatchSubagent, onRenameSession, onCloseSession, sessions } = renderTree();
        const alpha = sessions[0] as (typeof sessions)[number];

        fireEvent.click(moreButton("s1"));
        fireEvent.click(menuItem("dispatch"));
        expect(onDispatchSubagent).toHaveBeenCalledWith("s1");
        expect(menu()).toBeNull();

        fireEvent.click(moreButton("s1"));
        fireEvent.click(menuItem("rename"));
        expect(onRenameSession).toHaveBeenCalledWith(alpha);
        expect(menu()).toBeNull();

        // `关闭进程` is danger-styled and delegates the second confirmation to the
        // host's confirm dialog (never kills the process from the menu itself).
        fireEvent.click(moreButton("s1"));
        expect(menuItem("close").className).toContain("is-danger");
        fireEvent.click(menuItem("close"));
        expect(onCloseSession).toHaveBeenCalledWith(alpha);
        expect(menu()).toBeNull();
    });

    it("moves the popover to whichever row opened it", () => {
        renderTree();
        fireEvent.click(moreButton("s1"));
        expect(menu()).toHaveAttribute("data-menu-session", "s1");

        fireEvent.click(moreButton("s2"));
        expect(menu()).toHaveAttribute("data-menu-session", "s2");
        expect(document.querySelectorAll('[data-testid="session-row-menu"]')).toHaveLength(1);
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
    return [workspaceFixture()];
}

function sessionsBody() {
    return {
        sessions: [
            { sessionId: "s1", name: "Alpha", workspaceId: "W1", cwd: "/work/w1", status: "idle" },
            { sessionId: "s2", name: "Beta", workspaceId: "W1", cwd: "/work/w1", status: "busy" },
        ],
    };
}

function subSessionBody() {
    // The child row arrives first and carries the sub-session metadata.
    return {
        sessions: [
            {
                sessionId: "c1",
                name: "Child session",
                workspaceId: "W1",
                cwd: "/work/w1",
                status: "busy",
                parentId: "s1",
                visible: false,
            },
            { sessionId: "s1", name: "Alpha", workspaceId: "W1", cwd: "/work/w1", status: "idle", visible: true },
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
        expect(document.querySelector('.tree-row__main[aria-current="true"]')).toBeNull();
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
        expect(rowMain("s2")).toHaveAttribute("aria-current", "true");
        expect(rowMain("s1")).not.toHaveAttribute("aria-current", "true");

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

    it("renders a deep-linked hidden sub-session and offers the way back to its parent", async () => {
        mockApi([
            { path: "/api/v1/workspaces", handler: () => ({ body: workspaceBody() }) },
            { path: "/api/v1/workspaces/W1/sessions", handler: () => ({ body: subSessionBody() }) },
            { path: "/api/v1/models", handler: () => ({ body: [] }) },
            { path: /^\/api\/v1\/sessions\/c1\/entries/, handler: () => ({ body: entriesBody("Child first message") }) },
            { path: /^\/api\/v1\/sessions\/s1\/entries/, handler: () => ({ body: entriesBody("Parent first message") }) },
        ]);

        await renderPage(chatRoutes(), "/chat/c1?workspace=W1");

        await waitFor(() => {
            expect(rowMain("c1")).toHaveAttribute("aria-current", "true");
        });
        // Hidden by the plugin policy, but the routed row still renders (muted).
        expect(row("c1")).toHaveAttribute("data-hidden", "true");
        expect(await screen.findByText("Child first message")).toBeInTheDocument();
        expect(streamPane().querySelector(".stream-name")).toHaveTextContent("Child session");

        fireEvent.click(screen.getByRole("button", { name: "Back to parent" }));
        expect(await screen.findByText("Parent first message")).toBeInTheDocument();
        expect(streamPane().querySelector(".stream-name")).toHaveTextContent("Alpha");
        await waitFor(() => {
            expect(rowMain("s1")).toHaveAttribute("aria-current", "true");
        });
    }, 15_000);

    it("prefers a root session for the /chat index when a child row comes first", async () => {
        mockApi([
            { path: "/api/v1/workspaces", handler: () => ({ body: workspaceBody() }) },
            { path: "/api/v1/workspaces/W1/sessions", handler: () => ({ body: subSessionBody() }) },
            { path: "/api/v1/models", handler: () => ({ body: [] }) },
            { path: /^\/api\/v1\/sessions\/s1\/entries/, handler: () => ({ body: entriesBody("Parent first message") }) },
        ]);

        await renderPage(chatRoutes(), "/chat?workspace=W1");

        expect(await screen.findByText("Parent first message")).toBeInTheDocument();
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
