import type { Entry, SessionState, Subagent } from "@protocol/types";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { formatDuration } from "@/features/chat/format";
import { emptySessionState } from "@/features/chat/session-state";
import { Telemetry, compactTokens, countTelemetry } from "@/features/chat/telemetry";
import i18n, { plural, setLanguage } from "@/lib/i18n";

import { entryFixture, subagentFixture } from "./chat-fixtures";

// jsdom + a full child view is heavy; keep the suite resilient under load.
vi.setConfig({ testTimeout: 20_000 });

beforeAll(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.useRealTimers();
});

/** i18n-agnostic expectation: the same lookup the component performs (works before/after the catalog merge). */
const elapsedText = (dur: string) => i18n.t("chat.subview.elapsed", { dur });
const durationText = (dur: string) => i18n.t("chat.subview.duration", { dur });
const turnsText = (n: number) => plural("chat.telemetryTurns", n);

function toolEntry(id: string, ts: number): Entry {
    return entryFixture({
        id,
        role: "assistant",
        ts,
        blocks: [
            { type: "tool", toolCallId: `${id}-1`, name: "bash", state: "done", args: { command: "ls" } },
            { type: "tool", toolCallId: `${id}-2`, name: "read", state: "done", args: { path: "a.ts" } },
        ],
    });
}

/** Two user turns + three tool blocks, with a 60% context ring. */
function telemetrySession(overrides: Partial<SessionState> = {}): { session: SessionState; entries: Entry[] } {
    const entries: Entry[] = [
        entryFixture({ id: "u1", role: "user", ts: 1_000, blocks: [{ type: "text", text: "first" }] }),
        toolEntry("a1", 2_000),
        entryFixture({ id: "u2", role: "user", ts: 3_000, blocks: [{ type: "text", text: "second" }] }),
        entryFixture({
            id: "a2",
            role: "assistant",
            ts: 4_000,
            blocks: [{ type: "tool", toolCallId: "c3", name: "edit", state: "done", args: { path: "b.ts" } }],
        }),
    ];
    const session = {
        ...emptySessionState({ sessionId: "s1", workspaceId: "w1" }),
        usage: { input: 1_200, output: 340, cacheRead: 0, cacheWrite: 0, cost: 0 },
        contextUsage: { tokens: 120_000, window: 200_000, percent: 60 },
        ...overrides,
    } as SessionState;
    return { session, entries };
}

/** Direct children of `.telemetry` in DOM order: `data-testid` when present, else the separator glyph. */
function marks(container: HTMLElement): string[] {
    const line = container.querySelector(".telemetry");
    if (!line) throw new Error("no .telemetry");
    return [...line.children].map((child) => child.getAttribute("data-testid") ?? (child.textContent ?? ""));
}

describe("chat telemetry counts", () => {
    it("counts turns as user entries and tools as tool blocks", () => {
        const { entries } = telemetrySession();
        expect(countTelemetry(entries)).toEqual({ turns: 2, tools: 3 });
        expect(countTelemetry([])).toEqual({ turns: 0, tools: 0 });
    });

    it("compacts token counts", () => {
        expect(compactTokens(0)).toBe("0");
        expect(compactTokens(840)).toBe("840");
        expect(compactTokens(1_200)).toBe("1.2k");
        expect(compactTokens(200_000)).toBe("200k");
        expect(compactTokens(1_100_000)).toBe("1.1M");
    });
});

describe("session telemetry line", () => {
    it("renders `turns · tools | ctx ring · tokens` in that exact order", () => {
        const { session, entries } = telemetrySession();
        const { container } = render(<Telemetry session={session} entries={entries} />);

        expect(container.querySelector(".telemetry")).not.toHaveClass("telemetry--sub");
        expect(marks(container)).toEqual([
            "telemetry-turns",
            "·",
            "telemetry-tools",
            "|",
            "telemetry-ctx",
            "·",
            "telemetry-tokens",
        ]);
    });

    it("exposes role=status + aria-live=polite", () => {
        const { session, entries } = telemetrySession();
        render(<Telemetry session={session} entries={entries} />);
        const line = screen.getByRole("status");
        expect(line).toHaveClass("telemetry");
        expect(line).toHaveAttribute("aria-live", "polite");
    });

    it("draws the context ring from the session usage and omits the whole segment without data", () => {
        const { session, entries } = telemetrySession();
        const { container, unmount } = render(<Telemetry session={session} entries={entries} />);

        const ring = container.querySelector(".ctx-ring");
        expect(ring).not.toBeNull();
        expect(ring).toHaveAttribute("viewBox", "0 0 24 24");
        expect(container.querySelector(".ctx-ring__fill")).toHaveAttribute(
            "stroke-dasharray",
            expect.stringContaining("35.81"),
        );
        unmount();

        const bare = telemetrySession({ contextUsage: null });
        const view = render(<Telemetry session={bare.session} entries={bare.entries} />);
        expect(view.container.querySelector(".ctx-ring")).toBeNull();
        // The `|` separator belongs to the ctx segment and disappears with it.
        expect(marks(view.container)).toEqual(["telemetry-turns", "·", "telemetry-tools", "·", "telemetry-tokens"]);
    });

    it("renders nothing without a session or a subagent", () => {
        const { container } = render(<Telemetry session={null} entries={[]} />);
        expect(container.querySelector(".telemetry")).toBeNull();
    });
});

describe("subagent telemetry line", () => {
    function renderSub(subagent: Partial<Subagent> = {}) {
        const { session, entries } = telemetrySession();
        const agent = subagentFixture({ createdAt: Date.now() - 65_000, lastActiveAt: Date.now(), ...subagent });
        const view = render(<Telemetry session={session} subagent={agent} entries={entries} />);
        return { ...view, session, entries, agent };
    }

    it("renders `state · elapsed · tools · turns | ctx · tokens · model · thinking` in that order", () => {
        const { container } = renderSub();

        expect(container.querySelector(".telemetry")).toHaveClass("telemetry--sub");
        expect(marks(container)).toEqual([
            "telemetry-state",
            "·",
            "telemetry-elapsed",
            "·",
            "telemetry-tools",
            "·",
            "telemetry-turns",
            "|",
            "telemetry-ctx",
            "·",
            "telemetry-tokens",
            "·",
            "telemetry-model",
            "·",
            "telemetry-thinking",
        ]);
    });

    it("shows one readable state fact with its dot, and model / thinking last", () => {
        renderSub();
        const state = screen.getByTestId("telemetry-state");
        expect(state).toHaveClass("sub-state", "is-live");
        expect(state).toHaveTextContent(/Running/i);
        expect(state.querySelector(".dot")).not.toBeNull();

        expect(screen.getByTestId("telemetry-model")).toHaveTextContent("claude-sonnet-4-5");
        expect(screen.getByTestId("telemetry-thinking")).toHaveTextContent("low");
        expect(screen.getByTestId("telemetry-elapsed")).toHaveTextContent(elapsedText(formatDuration(65_000)));
    });

    it("ticks the elapsed fact once per second while the subagent is live, and stops when it ends", () => {
        vi.useFakeTimers();
        const createdAt = Date.now() - 5_000;
        const { session, entries } = telemetrySession();
        const live = subagentFixture({ status: "active", live: true, createdAt, lastActiveAt: undefined });
        const { unmount } = render(<Telemetry session={session} subagent={live} entries={entries} />);

        expect(screen.getByTestId("telemetry-elapsed")).toHaveTextContent(elapsedText(formatDuration(5_000)));
        act(() => {
            vi.advanceTimersByTime(2_000);
        });
        expect(screen.getByTestId("telemetry-elapsed")).toHaveTextContent(elapsedText(formatDuration(7_000)));
        unmount();

        // A finished subagent stops at `lastActiveAt` and uses the 耗时 wording.
        const done = subagentFixture({
            status: "completed",
            live: false,
            createdAt,
            lastActiveAt: createdAt + 9_000,
        });
        render(<Telemetry session={session} subagent={done} entries={entries} />);
        expect(screen.getByTestId("telemetry-elapsed")).toHaveTextContent(durationText(formatDuration(9_000)));
        act(() => {
            vi.advanceTimersByTime(5_000);
        });
        expect(screen.getByTestId("telemetry-elapsed")).toHaveTextContent(durationText(formatDuration(9_000)));
        expect(screen.getByTestId("telemetry-state")).toHaveClass("is-ok");
    });

    it("counts the synthesized child timeline, not the whole parent transcript", () => {
        const { entries } = telemetrySession();
        // No parent entry names this subagent → the task is the only message.
        renderSub({ task: "Research the auth flow" });
        expect(screen.getByTestId("telemetry-turns")).toHaveTextContent(turnsText(1));
        expect(entries.length).toBe(4);
    });
});
