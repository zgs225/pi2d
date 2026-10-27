import type { Block, Entry, SessionState, Subagent } from "@protocol/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Empty } from "@/components/ui/empty";
import { StatusDot } from "@/components/ui/status-dot";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import { EntryBlock } from "./blocks";
import { Composer } from "./composer";
import type { ModelGroup } from "./data";
import { HeadChips } from "./head-chips";
import { subagentDot } from "./session-state";
import { subagentTitle } from "./session-title";
import type { TrayTab } from "./store";

import "@/styles/pages/chat-telemetry.css";

type ToolBlock = Extract<Block, { type: "tool" }>;

function str(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

/** Keys a tool call uses to name a subagent (`task`/`subagent` tools vary by provider). */
const AGENT_KEYS = ["agent", "subagent", "target", "name", "ref"] as const;

function firstNamed(record: Record<string, unknown> | undefined): string | undefined {
    if (!record) return undefined;
    for (const key of AGENT_KEYS) {
        const value = str(record[key]);
        if (value) return value;
    }
    return undefined;
}

/**
 * Name of the subagent a tool block spawned, if it names one.
 *
 * pi2d's tool DTO carries free-form `args`, so this mirrors the prototype's
 * `tool.agent === sa.name` check across the spellings providers use; the
 * tool result `details` is the fallback (it survives older payloads that only
 * keep the result).
 */
export function toolAgentName(block: ToolBlock): string | undefined {
    return firstNamed(rec(block.args)) ?? firstNamed(rec(block.output?.details));
}

function textOf(entry: Entry): string {
    return entry.blocks
        .map((block) => (block.type === "text" || block.type === "error" || block.type === "thinking" ? block.text : ""))
        .filter(Boolean)
        .join("\n");
}

/**
 * Synthetic **read-only** timeline for a subagent (design §4.3, CHG-26-18).
 *
 * pi2d keeps no per-subagent `entries` (`session.subagents` is manifest
 * metadata only), so nothing is filtered out of the parent transcript and no
 * conversation is invented:
 *
 * 1. `subagent.task` becomes the first `user` message (it *is* what was asked);
 * 2. parent entries whose tool blocks name this subagent are copied with only
 *    those tool blocks kept;
 * 3. `notice` entries (pi2d's sub-reports) that mention the subagent by name/id
 *    are copied verbatim;
 * 4. the result is sorted by `ts`.
 *
 * Everything else stays in the parent stream, so this never pretends to be a
 * complete transcript — the empty state says so when nothing matched.
 */
export function synthesizeSubagentTimeline(subagent: Subagent, entries: Entry[]): Entry[] {
    const name = subagent.name?.trim() || undefined;
    const task = subagent.task?.trim();
    const timeline: Entry[] = [];

    if (task) {
        timeline.push({
            id: `sub-task-${subagent.id}`,
            role: "user",
            ts: subagent.createdAt ?? 0,
            blocks: [{ type: "text", text: task }],
            done: true,
        });
    }

    const names = new Set([name, subagent.id].filter((value): value is string => Boolean(value)));
    if (!names.size) return timeline;

    const matches = (value: string | undefined) => Boolean(value && names.has(value));

    for (const entry of entries) {
        const toolBlocks = entry.blocks.filter(
            (block): block is ToolBlock => block.type === "tool" && matches(toolAgentName(block)),
        );
        if (toolBlocks.length) {
            timeline.push({ ...entry, blocks: toolBlocks });
            continue;
        }
        if (entry.role === "notice") {
            const text = textOf(entry);
            if (!text) continue;
            const mentions = [...names].some((value) => text.includes(value));
            if (mentions) timeline.push(entry);
        }
    }

    return timeline.sort((a, b) => a.ts - b.ts);
}

export interface SubagentViewChips {
    planDone: number;
    planTotal: number;
    /** Session-scope tasks (see the scope note in the view). */
    taskCount: number;
    runningTasks: number;
    trayTab: TrayTab;
    trayOpen: boolean;
    onToggle: (tab: TrayTab) => void;
    registerTrigger?: (tab: TrayTab, element: HTMLButtonElement | null) => void;
}

export interface SubagentViewProps {
    session: SessionState;
    subagent: Subagent;
    /** The parent session timeline the child timeline is synthesized from. */
    entries: Entry[];
    /** `← 父级` / menu: back to the session stream (page keeps Esc + focus restore). */
    onBack: () => void;
    /** Head chips + `…` menu open the workbench tray. */
    onOpenTray: () => void;
    /** Narrow viewports: the tree drawer trigger (page owns the drawer). */
    onOpenTree: () => void;
    /** steer send; the page owns the command layer (`subagent.steer`). */
    onSteer: (text: string) => void;
    chips: SubagentViewChips;
    composer: { models: ModelGroup[]; connected: boolean; paired: boolean };
    className?: string;
}

/**
 * In-place subagent child view (design §4, CHG-2026-10-26-18/19).
 *
 * Structure, top to bottom:
 * - `.stream-head--sub`: `← 父级` / status dot / name / head chips / `…`.
 *   **No** status text, model or elapsed time here — those live in the
 *   telemetry line under the composer (asserted by `chat.subview.test.tsx`).
 * - scope note: TODO/Tasks are session-scope in pi2d and are *not* filtered
 *   per subagent (no fabricated filtering, PLAN §1).
 * - the synthetic read-only timeline (reuses `EntryBlock`).
 * - steer composer + its note.
 *
 * Composer dependency: `Composer` has no `subagent` prop yet (that file is
 * outside this workstream), so the steer mode is reached with
 * `className="is-sub"` (CSS hides attach / model / thinking / queue / abort)
 * and a small effect that rewrites the textarea placeholder. When `Composer`
 * grows a first-class `subagent`/`placeholder` prop this effect goes away.
 * The `onSend` `mode` argument is ignored on purpose: every send is a steer.
 */
export function SubagentView({
    session,
    subagent,
    entries,
    onBack,
    onOpenTray,
    onOpenTree,
    onSteer,
    chips,
    composer,
    className,
}: SubagentViewProps) {
    const { t } = useTranslation();
    const name = subagentTitle(subagent, {
        unnamed: t("chat.sessionUnnamed"),
        subagentUnnamed: t("chat.subagentUnnamed"),
    }).text;
    const task = subagent.task?.trim() || "";
    // `live` is authoritative when present; the status is the fallback.
    const isLive = subagent.live === true || subagent.status === "active";
    const timeline = useMemo(() => synthesizeSubagentTimeline(subagent, entries), [entries, subagent]);

    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const moreRef = useRef<HTMLButtonElement | null>(null);
    const composerRef = useRef<HTMLDivElement | null>(null);

    // The steer composer must never offer the parent session's abort slot nor its
    // pending-queue bar, so it gets a neutralised view of the session: idle (the
    // single send slot stays a send) and an empty queue. Sends still go through
    // `onSteer` → `subagent.steer`, never `prompt.send`.
    const steerSession = useMemo<SessionState>(
        () => ({ ...session, status: "idle", queue: [] }),
        [session],
    );

    // Composer API gap (see the component note): steer copy lives here.
    useEffect(() => {
        const element = composerRef.current?.querySelector<HTMLTextAreaElement>("textarea.composer__ta");
        if (!element) return;
        element.placeholder = isLive ? t("chat.steerPlaceholder") : "";
        element.setAttribute("aria-label", t("chat.steer"));
    }, [isLive, t]);

    // `…` menu: Esc closes the menu (captured, so the page's child-view Esc
    // does not fire in the same keypress) and outside clicks dismiss it.
    useEffect(() => {
        if (!menuOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setMenuOpen(false);
            moreRef.current?.focus({ preventScroll: true });
        };
        const onPointerDown = (event: MouseEvent) => {
            if (menuRef.current?.contains(event.target as Node)) return;
            setMenuOpen(false);
        };
        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("mousedown", onPointerDown);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("mousedown", onPointerDown);
        };
    }, [menuOpen]);

    function copyId() {
        setMenuOpen(false);
        const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
        if (!clipboard?.writeText) return;
        void clipboard
            .writeText(subagent.id)
            .then(() => toast.success(t("chat.subview.copyId")))
            .catch(() => undefined);
    }

    // The child view is the session you are looking at, so its unread markers are
    // already consumed (`viewed: true`) — a failed child is steady red here.
    const dot = subagentDot(subagent, { viewed: true });

    return (
        <div
            className={cn("subagent-view", "subagent-view--child", className)}
            data-testid="subagent-view"
            data-sub-id={subagent.id}
            data-live={isLive ? "true" : "false"}
        >
            <div
                className="stream-head stream-head--sub"
                role="group"
                aria-label={t("chat.subview.statusAria", { name, state: t(`state.${subagent.status}`) })}
            >
                <button
                    type="button"
                    className="btn btn--sm btn--ghost stream-head__tree"
                    aria-label={t("chat.expandTree")}
                    title={t("chat.expandTree")}
                    onClick={onOpenTree}
                >
                    <Icon name="branch" />
                </button>
                <button
                    type="button"
                    className="sub-back"
                    title={t("chat.subview.backTo", { name })}
                    aria-label={t("chat.subview.backTo", { name })}
                    onClick={onBack}
                >
                    <Icon name="chevron-right" />
                    <span className="sub-back__label">{t("chat.subview.back")}</span>
                </button>
                <div className="stream-title">
                    <StatusDot
                        status={dot.status}
                        steady={dot.steady}
                        title={t(`state.${subagent.status}`)}
                    />
                    <h2 className="stream-name truncate" tabIndex={-1} title={task ? `${name} · ${task}` : name}>
                        {name}
                    </h2>
                </div>
                <div className="spacer" />
                <HeadChips
                    planDone={chips.planDone}
                    planTotal={chips.planTotal}
                    taskCount={chips.taskCount}
                    runningTasks={chips.runningTasks}
                    trayTab={chips.trayTab}
                    trayOpen={chips.trayOpen}
                    onToggle={chips.onToggle}
                    registerTrigger={chips.registerTrigger}
                />
                <div className="sub-menu" ref={menuRef}>
                    <button
                        ref={moreRef}
                        type="button"
                        className="btn btn--icon btn--ghost sub-more"
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        aria-label={t("chat.subview.menu")}
                        title={t("chat.subview.menu")}
                        onClick={() => setMenuOpen((open) => !open)}
                    >
                        <Icon name="more" />
                    </button>
                    {menuOpen ? (
                        <div className="sub-pop" role="menu" aria-label={t("chat.subview.menu")}>
                            <button
                                type="button"
                                role="menuitem"
                                className="sub-pop__item"
                                onClick={() => {
                                    setMenuOpen(false);
                                    onOpenTray();
                                }}
                            >
                                <Icon name="terminal" />
                                {t("chat.subview.openTray")}
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                className="sub-pop__item sub-pop__item--back"
                                onClick={onBack}
                            >
                                <Icon name="chevron-right" />
                                {t("chat.backToParent")}
                            </button>
                            <button type="button" role="menuitem" className="sub-pop__item" onClick={copyId}>
                                <Icon name="copy" />
                                {t("chat.subview.copyId")}
                            </button>
                        </div>
                    ) : null}
                </div>
            </div>

            <p className="sub-scope faint" data-testid="sub-scope">
                <Icon name="todo" />
                {t("chat.subview.scopeNote")}
            </p>

            <div className="stream-body stream-body--sub">
                <div
                    className="stream-scroll stream-scroll--sub"
                    role="log"
                    aria-live="polite"
                    aria-readonly="true"
                    aria-label={t("chat.subview.timelineAria", { name })}
                    data-testid="sub-timeline"
                >
                    {timeline.length ? (
                        <div className="stream-list">
                            {timeline.map((entry, index) => {
                                const previous = index > 0 ? timeline[index - 1] : undefined;
                                const turnStart = index === 0 || entry.role === "user" || previous?.role === "user";
                                return (
                                    <div
                                        key={entry.id}
                                        className={cn("stream-item", turnStart && "turn-start")}
                                        data-entry-id={entry.id}
                                    >
                                        <EntryBlock entry={entry} turnStart={turnStart} />
                                    </div>
                                );
                            })}
                            <div className="stream-end" />
                        </div>
                    ) : (
                        <Empty
                            className="stream-empty sub-empty"
                            icon={<Icon name="branch" />}
                            title={t("chat.subview.emptyTitle")}
                            description={t("chat.subview.emptyText")}
                        />
                    )}
                </div>
            </div>

            <div className="sub-composer" ref={composerRef}>
                <div
                    className={cn("sub-note", isLive ? "is-live" : "is-ended")}
                    role="note"
                    data-testid="sub-note"
                >
                    <Icon name={isLive ? "branch" : "revoke"} />
                    {t(isLive ? "chat.subview.steerNote" : "chat.subview.endedNote")}
                </div>
                <Composer
                    session={steerSession}
                    models={composer.models}
                    connected={composer.connected}
                    paired={composer.paired}
                    sending={null}
                    queuedCount={0}
                    onSend={(text) => onSteer(text)}
                    onAbort={() => undefined}
                    onRemoveQueue={() => undefined}
                    onSetSteer={() => undefined}
                    onSetModel={() => undefined}
                    onSetThinking={() => undefined}
                    disabled={!isLive}
                    className="is-sub"
                />
            </div>
        </div>
    );
}
