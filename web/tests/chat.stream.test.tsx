import type { QueueItem } from "@protocol/types";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { setLanguage } from "@/lib/i18n";
import {
    buildStreamItems,
    MessageStream,
    type MessageStreamProps,
    SENDING_QUEUE_ID,
    steerAllOf,
} from "@/features/chat/message-stream";
import { fullStreamSession, sessionFixture } from "./chat-fixtures";

beforeAll(async () => {
    await setLanguage("en");
});

function queueFixture(): QueueItem[] {
    return [
        { id: "q:steer:0", text: "interrupt: check the callers first", steer: true },
        { id: "q:follow:0", text: "then run the suite", steer: false },
    ];
}

function sessionWithQueue(queue: QueueItem[] = queueFixture()) {
    const session = fullStreamSession();
    session.queue = queue;
    return session;
}

function renderStream(props: Partial<MessageStreamProps> = {}) {
    const session = props.session ?? fullStreamSession();
    const utils = render(
        <MessageStream
            session={session}
            entries={session.entries}
            hasMore={false}
            loadingOlder={false}
            error={null}
            sending={null}
            onLoadOlder={vi.fn()}
            onRetry={vi.fn()}
            onOpenSubagent={vi.fn()}
            {...props}
        />,
    );
    return { ...utils, session };
}

describe("chat message stream", () => {
    it("renders user, assistant, thinking, tool, todo, batch and error blocks from a snapshot", () => {
        const { container } = renderStream();

        expect(screen.getByText("Fix the auth bug")).toBeInTheDocument();
        expect(screen.getByText("Fix the auth bug").closest("article")).toHaveClass("msg--user");
        expect(screen.getByText("Looking at the auth path now.")).toBeInTheDocument();
        expect(screen.getByText("Check every caller before editing")).toBeInTheDocument();
        // Tool rows belong to the tool-family renderer (`tools/index.ts`); assert on
        // its stable `data-tool` hook instead of on the verb wording.
        expect(container.querySelector('[data-tool="bash"]')).not.toBeNull();
        expect(container.querySelector('[data-tool="edit"]')).not.toBeNull();

        expect(screen.getByText("Todo · 1/3")).toBeInTheDocument();
        expect(screen.getByText("Applying the fix")).toBeInTheDocument();
        expect(screen.getByText("Apply fix")).toBeInTheDocument();
        expect(screen.getByText("Batch dispatch · 2/3")).toBeInTheDocument();
        expect(screen.getByText("writer")).toBeInTheDocument();

        expect(screen.getByText("agent aborted")).toBeInTheDocument();
        expect(screen.getByText("agent aborted").closest(".msg__error")).not.toBeNull();
    });

    it("exposes data-entry-id / data-role on every message", () => {
        renderStream();
        const user = screen.getByText("Fix the auth bug").closest("article");
        expect(user).toHaveAttribute("data-entry-id", "u1");
        expect(user).toHaveAttribute("data-role", "user");

        const assistant = screen.getByText("Looking at the auth path now.").closest("article");
        expect(assistant).toHaveAttribute("data-entry-id", "a1");
        expect(assistant).toHaveAttribute("data-role", "assistant");
    });

    it("exposes the load-older selector only while older pages exist", () => {
        const session = fullStreamSession();
        const props = {
            session,
            entries: session.entries,
            loadingOlder: false,
            error: null,
            onLoadOlder: vi.fn(),
            onRetry: vi.fn(),
            onOpenSubagent: vi.fn(),
        };
        const { rerender } = render(<MessageStream {...props} hasMore />);
        const button = screen.getByTestId("load-older");
        fireEvent.click(button);
        expect(props.onLoadOlder).toHaveBeenCalledTimes(1);

        rerender(<MessageStream {...props} hasMore={false} />);
        expect(screen.queryByTestId("load-older")).not.toBeInTheDocument();
    });

    it("expands a tool card to show its body and the edit diff", () => {
        const { container } = renderStream();

        const bash = container.querySelector('[data-tool="bash"]');
        const bashHead = bash?.querySelector(".tool__head");
        expect(bashHead).not.toBeNull();
        fireEvent.click(bashHead!);
        expect(bashHead).toHaveAttribute("aria-expanded", "true");
        const bashBody = bash!.querySelector(".tool__body");
        expect(bashBody).not.toBeNull();
        expect(bashBody).not.toHaveAttribute("hidden");
        expect(bashBody!.textContent?.trim().length).toBeGreaterThan(0);

        const edit = container.querySelector('[data-tool="edit"]');
        const editHead = edit?.querySelector(".tool__head");
        expect(editHead).not.toBeNull();
        fireEvent.click(editHead!);
        expect(editHead).toHaveAttribute("aria-expanded", "true");
        expect(screen.getAllByText(/src\/auth\.ts/).length).toBeGreaterThan(0);
    });

    it("shows a streaming caret only for an unfinished assistant entry", () => {
        const session = fullStreamSession();
        session.entries = [
            {
                id: "a-live",
                role: "assistant",
                ts: Date.now(),
                done: false,
                blocks: [{ type: "text", text: "partial answer" }],
            },
        ];
        render(
            <MessageStream
                session={session}
                entries={session.entries}
                hasMore={false}
                loadingOlder={false}
                error={null}
                onLoadOlder={vi.fn()}
                onRetry={vi.fn()}
                onOpenSubagent={vi.fn()}
            />,
        );
        expect(screen.getByText("partial answer")).toHaveClass("streaming");
    });
});

describe("chat message stream — pending (queued) prompts", () => {
    it("appends one queued item per session.queue entry, after entries/todos/batches", () => {
        const session = sessionFixture({ queue: queueFixture() });
        const items = buildStreamItems(session, session.entries, null);
        const kinds = items.map((item) => item.kind);
        const firstQueued = kinds.indexOf("queued");

        expect(firstQueued).toBe(items.length - session.queue.length);
        expect(kinds.lastIndexOf("batch")).toBeLessThan(firstQueued);
        expect(kinds.lastIndexOf("todo")).toBeLessThan(firstQueued);
        expect(items.slice(firstQueued)).toEqual([
            { kind: "queued", key: "queued:q:steer:0", item: queueFixture()[0] },
            { kind: "queued", key: "queued:q:follow:0", item: queueFixture()[1] },
        ]);
    });

    it("folds the optimistic sending prompt in as the first queued variant", () => {
        const session = sessionFixture({ queue: queueFixture() });
        const items = buildStreamItems(session, session.entries, { text: "just sent this" });
        const queued = items.filter((item) => item.kind === "queued");

        expect(queued).toHaveLength(3);
        expect(queued[0]).toEqual({
            kind: "queued",
            key: `queued:${SENDING_QUEUE_ID}`,
            item: { id: SENDING_QUEUE_ID, text: "just sent this", steer: false },
            sending: true,
        });
    });

    it("detects the session-wide steer mode from the queue projection", () => {
        expect(steerAllOf([])).toBe(false);
        expect(steerAllOf(queueFixture())).toBe(false);
        expect(steerAllOf(queueFixture().map((item) => ({ ...item, steer: true })))).toBe(true);
    });

    it("renders every pending prompt exactly once, as a .msg--user.msg--queued entity", () => {
        const { container } = renderStream({
            session: sessionWithQueue(),
            onRecallQueued: vi.fn(),
            onRemoveQueued: vi.fn(),
            onSetSteerAll: vi.fn(),
        });

        // The stream is the single body entity: each queued text appears once.
        expect(screen.getAllByText("interrupt: check the callers first")).toHaveLength(1);
        expect(screen.getAllByText("then run the suite")).toHaveLength(1);

        const entities = container.querySelectorAll(".msg--queued");
        expect(entities).toHaveLength(2);
        for (const entity of entities) {
            expect(entity).toHaveClass("msg");
            expect(entity).toHaveClass("msg--user");
            expect(entity.querySelector(".msg__text")).not.toBeNull();
            expect(entity.querySelector(".msg__queue-foot")).not.toBeNull();
            expect(entity.querySelectorAll(".msg__queue-btn").length).toBe(3);
        }

        // Queued entities sit at the tail of the stream, after the entry list.
        const groups = container.querySelectorAll(".stream-scroll .stream-list");
        expect(groups[groups.length - 1]).toBe(screen.getByTestId("stream-queued"));
    });

    it("wires recall / session-wide steer / remove from the queue footer", () => {
        const onRecallQueued = vi.fn();
        const onRemoveQueued = vi.fn();
        const onSetSteerAll = vi.fn();
        const { container } = renderStream({
            session: sessionWithQueue(),
            onRecallQueued,
            onRemoveQueued,
            onSetSteerAll,
        });

        const first = container.querySelector('[data-queue-id="q:steer:0"]');
        expect(first).not.toBeNull();
        const foot = within(first as HTMLElement);

        const recall = (first as HTMLElement).querySelector<HTMLButtonElement>('[data-queue-action="recall"]');
        expect(recall).not.toBeNull();
        fireEvent.click(recall!);
        expect(onRecallQueued).toHaveBeenCalledWith("q:steer:0");

        fireEvent.click(foot.getByLabelText("Remove queued message"));
        expect(onRemoveQueued).toHaveBeenCalledWith("q:steer:0");

        // The steer control is a session-wide mode toggle, not a per-message flag.
        const steer = foot.getAllByRole("button").find((node) => node.dataset.queueAction === "steer");
        expect(steer).toBeDefined();
        expect(steer).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(steer!);
        expect(onSetSteerAll).toHaveBeenCalledWith(true);
    });

    it("marks a fully steering queue as pressed and offers no per-message toggle", () => {
        const queue = queueFixture().map((item) => ({ ...item, steer: true }));
        const onSetSteerAll = vi.fn();
        const { container } = renderStream({
            session: sessionWithQueue(queue),
            onSetSteerAll,
        });

        const toggles = container.querySelectorAll<HTMLButtonElement>('[data-queue-action="steer"]');
        expect(toggles).toHaveLength(2);
        for (const toggle of toggles) {
            expect(toggle).toHaveAttribute("aria-pressed", "true");
        }
        fireEvent.click(toggles[0]!);
        expect(onSetSteerAll).toHaveBeenCalledWith(false);
        // One session-wide mode: no per-message checkbox anywhere in the foot.
        expect(container.querySelectorAll('.msg__queue-foot input[type="checkbox"]')).toHaveLength(0);
    });

    it("renders the queue outside the virtual window when the stream is virtualized", () => {
        const session = fullStreamSession();
        session.entries = Array.from({ length: 40 }, (_, index) => ({
            id: `e${index}`,
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            ts: Date.now() + index,
            done: true,
            blocks: [{ type: "text" as const, text: `line ${index}` }],
        }));
        session.queue = queueFixture();
        const { container } = renderStream({ session });

        expect(container.querySelector(".stream-list--virtual")).not.toBeNull();
        expect(container.querySelectorAll(".msg--queued")).toHaveLength(2);
        expect(container.querySelector(".stream-list--virtual .msg--queued")).toBeNull();
    });
});

describe("chat message stream — layout contract", () => {
    it("keeps a single floating button: back to latest", () => {
        const { container } = renderStream();
        const buttons = container.querySelectorAll(".stream-fab > button");

        expect(buttons).toHaveLength(1);
        expect(buttons[0]).toHaveClass("fab--latest");
        expect(container.querySelector(".fab--top")).toBeNull();
        expect(buttons[0]).toHaveAttribute("aria-label", "Back to latest");
    });

    it("marks turn starts and user messages for the 18/28 spacing rhythm", () => {
        const { container } = renderStream({
            session: sessionWithQueue(),
            onRecallQueued: vi.fn(),
            onRemoveQueued: vi.fn(),
            onSetSteerAll: vi.fn(),
        });

        const items = Array.from(container.querySelectorAll<HTMLElement>(".stream-item"));
        const userItem = items.find((item) => item.textContent?.includes("Fix the auth bug"));
        expect(userItem).toBeDefined();
        expect(userItem).toHaveClass("turn-start");
        expect(userItem).toHaveClass("user-start");

        const assistantItem = items.find((item) => item.textContent?.includes("Looking at the auth path now."));
        expect(assistantItem).toBeDefined();
        expect(assistantItem).toHaveClass("turn-start");
        expect(assistantItem).not.toHaveClass("user-start");

        const queuedItem = items.find((item) => item.querySelector(".msg--queued"));
        expect(queuedItem).toHaveClass("user-start");
        expect(queuedItem).toHaveClass("stream-item--queued");
    });

    it("pins the reading column, spacing and queued styles in chat-stream.css", () => {
        const css = readFileSync(path.resolve(import.meta.dirname, "../src/styles/pages/chat-stream.css"), "utf8");

        // 52rem reading column, centred.
        expect(css).toMatch(/\.stream-body \.stream-inner \{[^}]*width: min\(100%, var\(--reading-max\)\)/);
        expect(css).toMatch(/\.stream-body \.stream-inner \{[^}]*margin-inline: auto/);
        // 18px between items, 28px at a turn/user start — in both branches.
        expect(css).toMatch(/\.stream-item \+ \.stream-item \{\s*margin-top: 18px/);
        expect(css).toMatch(/\.stream-item\.turn-start \{\s*margin-top: 28px/);
        expect(css).toMatch(/\.stream-item\.user-start \{\s*margin-top: 28px/);
        expect(css).toMatch(/\.stream-list--virtual > \.stream-item \{\s*padding-bottom: 18px/);
        expect(css).toMatch(/\.stream-list--virtual > \.stream-item\.turn-start,[\s\S]*?\.user-start \{\s*padding-bottom: 28px/);
        // Queued entity: dashed rail from tokens only, no background block.
        expect(css).toMatch(/\.msg\.msg--queued \{\s*border-style: dashed/);
        expect(css).toMatch(/\.msg__queue-foot \{/);
        // <600 hit targets and reduced motion.
        expect(css).toMatch(/@media \(max-width: 599px\) \{[\s\S]*?min-height: 44px/);
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    });
});

/* ------------------------------------------------------------------ */
/* Auto-follow: content growth must never look like a user scroll.     */
/* ------------------------------------------------------------------ */

describe("chat message stream — auto-follow", () => {
    /**
     * jsdom has no layout: give the scroll container a fake viewport so the
     * distance heuristic can be exercised (2000px of content, 600px visible).
     */
    function renderWithViewport(props: Partial<MessageStreamProps> = {}) {
        const utils = renderStream(props);
        const scroll = utils.container.querySelector<HTMLElement>(".stream-scroll");
        if (!scroll) throw new Error("the chat layout did not render a stream scroll");
        const box = { top: 0, height: 2000, client: 600 };
        Object.defineProperty(scroll, "scrollHeight", { configurable: true, get: () => box.height });
        Object.defineProperty(scroll, "clientHeight", { configurable: true, get: () => box.client });
        Object.defineProperty(scroll, "scrollTop", {
            configurable: true,
            get: () => box.top,
            set: (value: number) => {
                box.top = value;
            },
        });
        const scrollTo = vi.fn((options?: ScrollToOptions) => {
            box.top = Number(options?.top ?? box.height);
        });
        (scroll as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
        const latest = () => utils.container.querySelector(".fab--latest.is-visible");
        return { ...utils, scroll, box, scrollTo, latest };
    }

    it("keeps following when the stream grew under the viewport (no user input)", () => {
        const { scroll, box, latest } = renderWithViewport();

        // The virtualizer measured taller items after the pin: the scroll
        // position is now far from the bottom, but nobody scrolled.
        box.top = 900;
        fireEvent.scroll(scroll);
        expect(latest()).toBeNull();

        // An explicit wheel up that moves the view up does stop following.
        fireEvent.wheel(scroll, { deltaY: -120 });
        box.top = 800;
        fireEvent.scroll(scroll);
        expect(latest()).not.toBeNull();

        // Returning to the bottom (by wheel) re-arms it.
        fireEvent.wheel(scroll, { deltaY: 4000 });
        box.top = box.height - box.client;
        fireEvent.scroll(scroll);
        expect(latest()).toBeNull();
    });

    it("re-pins to the newest item on every content resize while following", () => {
        const observed: (() => void)[] = [];
        const original = globalThis.ResizeObserver;
        class RecordingObserver {
            constructor(callback: () => void) {
                observed.push(callback);
            }
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        }
        globalThis.ResizeObserver = RecordingObserver as unknown as typeof ResizeObserver;
        try {
            const { box, scrollTo } = renderWithViewport();
            expect(observed.length).toBeGreaterThan(0);

            box.height = 3200;
            for (const callback of observed) callback();
            expect(scrollTo).toHaveBeenCalled();
            expect(box.top).toBe(3200);
        } finally {
            globalThis.ResizeObserver = original;
        }
    });

    it("stops re-pinning once the user scrolled away", () => {
        const observed: (() => void)[] = [];
        const original = globalThis.ResizeObserver;
        class RecordingObserver {
            constructor(callback: () => void) {
                observed.push(callback);
            }
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        }
        globalThis.ResizeObserver = RecordingObserver as unknown as typeof ResizeObserver;
        try {
            const { scroll, box, scrollTo, latest } = renderWithViewport();

            fireEvent.wheel(scroll, { deltaY: -200 });
            box.top = 400;
            fireEvent.scroll(scroll);
            expect(latest()).not.toBeNull();

            scrollTo.mockClear();
            box.height = 3600;
            for (const callback of observed) callback();
            expect(scrollTo).not.toHaveBeenCalled();
        } finally {
            globalThis.ResizeObserver = original;
        }
    });
});
