import type { ContextUsage, Entry, SessionState, Subagent, UsageTotals } from "@protocol/types";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { StatusDot } from "@/components/ui/status-dot";
import { plural } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { formatDuration } from "./format";
import { subagentDot } from "./session-state";
import { synthesizeSubagentTimeline } from "./subagent-view";

import "@/styles/pages/chat-telemetry.css";

/** Inline ring geometry (the SVG is the only inline-sized element in the line). */
const RING_R = 9.5;
const RING_C = 2 * Math.PI * RING_R;
const RING_SIZE = 14;

/** Subagent status → tone class on `.sub-state` (design §3.1 mapping). */
const SUB_TONE: Record<Subagent["status"], string> = {
    active: "is-live",
    completed: "is-ok",
    failed: "is-err",
    interrupted: "is-warn",
    dormant: "is-idle",
};

export interface TelemetryCounts {
    /** `role === "user"` entries in the view's timeline. */
    turns: number;
    /** Tool blocks in the view's timeline (pi2d is a block model, not a flat message list). */
    tools: number;
}

/** Turns / tools of a timeline — the two facts the main line starts with. */
export function countTelemetry(entries: Entry[]): TelemetryCounts {
    let turns = 0;
    let tools = 0;
    for (const entry of entries) {
        if (entry.role === "user") turns += 1;
        for (const block of entry.blocks) if (block.type === "tool") tools += 1;
    }
    return { turns, tools };
}

/** Compact token counts (`840`, `1.2k`, `200k`, `1.1M`) for the mono status line. */
export function compactTokens(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0";
    if (value < 1_000) return String(Math.round(value));
    if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
    if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
    return `${(value / 1_000_000).toFixed(1)}M`;
}

function ringTone(percent: number): string {
    if (percent >= 90) return "is-err";
    if (percent >= 75) return "is-warn";
    return "";
}

/**
 * Context-usage ring: a 24×24 viewBox SVG rendered at 14px (design §3.2) with
 * `stroke-dasharray: c*pct/100 c` and `rotate(-90 12 12)`. The label doubles as
 * `role="img"` + `aria-label` and as the visible `上下文占用 …` text.
 */
function CtxRing({ usage }: { usage: ContextUsage }) {
    const { t } = useTranslation();
    const percent = Number.isFinite(usage.percent) ? Math.max(0, Math.min(100, usage.percent)) : 0;
    const used = compactTokens(usage.tokens);
    const window = compactTokens(usage.window);
    const label = t("chat.contextUsage", { used, window });
    return (
        <span className="telemetry__ctx" data-testid="telemetry-ctx">
            <svg
                className={cn("ctx-ring", ringTone(percent))}
                width={RING_SIZE}
                height={RING_SIZE}
                viewBox="0 0 24 24"
                role="img"
                aria-label={label}
            >
                <title>{label}</title>
                <circle className="ctx-ring__track" cx="12" cy="12" r={RING_R} fill="none" strokeWidth="2.4" />
                <circle
                    className="ctx-ring__fill"
                    cx="12"
                    cy="12"
                    r={RING_R}
                    fill="none"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    transform="rotate(-90 12 12)"
                    strokeDasharray={`${(RING_C * percent) / 100} ${RING_C}`}
                />
            </svg>
            <span className="telemetry__ctx-label">{label}</span>
        </span>
    );
}

/** Session usage → `输入 … · 输出 …`, omitted when the session has no usage yet. */
function usageFacts(usage: UsageTotals | null | undefined): { in: string; out: string } | null {
    if (!usage) return null;
    const input = compactTokens(usage.input);
    const output = compactTokens(usage.output);
    if (input === "0" && output === "0") return null;
    return { in: input, out: output };
}

function Tsep({ bar = false }: { bar?: boolean }) {
    return (
        <span className={cn("tsep", bar && "tsep--bar")} aria-hidden="true">
            {bar ? "|" : "·"}
        </span>
    );
}

/** `输入 … · 输出 …`, or nothing when the session has no usage yet. */
function Tokens({ usage }: { usage: UsageTotals | null | undefined }) {
    const { t } = useTranslation();
    const facts = usageFacts(usage);
    if (!facts) return null;
    return (
        <span className="telemetry__fact" data-testid="telemetry-tokens">
            {t("chat.telemetryTokens", facts)}
        </span>
    );
}

function hasTokens(usage: UsageTotals | null | undefined): boolean {
    return usageFacts(usage) !== null;
}

export interface TelemetryProps {
    session: SessionState | null;
    /** Set in the child view: switches to `.telemetry--sub` (CHG-2026-10-26-19). */
    subagent?: Subagent | null;
    /** The view's timeline: live+history entries for the session, the parent's for the child. */
    entries: Entry[];
    className?: string;
}

/**
 * The composer status line — the only place the context ring lives (design
 * §3). Two branches:
 *
 * - session: `轮 · 工具 | ctx 环 · token`
 * - child view: `状态 · 耗时 · 工具 · 轮 | ctx · token · model · thinking`
 *   (model / thinking last so narrow screens see state and cost first)
 *
 * The subagent has no own usage on the wire (`Subagent` carries no
 * `contextUsage`/`usage`), so the child branch shows the session-scope numbers
 * — never a fabricated per-subagent split. `createdAt`/`lastActiveAt` are the
 * only per-subagent timing facts, and the live case ticks once a second.
 */
export function Telemetry({ session, subagent, entries, className }: TelemetryProps) {
    const { t } = useTranslation();
    const ticking = Boolean(subagent && (subagent.live === true || subagent.status === "active"));
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!ticking) return;
        const timer = setInterval(() => setNow(Date.now()), 1_000);
        return () => clearInterval(timer);
    }, [ticking]);

    if (!session && !subagent) return null;

    if (subagent) {
        const timeline = synthesizeSubagentTimeline(subagent, entries);
        // The subagent view is the session you have open: its unread markers are
        // already consumed, so a failed child is steady red here.
        const dot = subagentDot(subagent, { viewed: true });
        const { turns, tools } = countTelemetry(timeline);
        const created = subagent.createdAt;
        const end = ticking ? now : (subagent.lastActiveAt ?? created);
        // `<1s` never renders `0.0s` (design §5.9); below that the elapsed fact is dropped.
        const elapsedMs =
            created !== undefined && Number.isFinite(created) && end !== undefined ? Math.max(0, end - created) : undefined;
        const elapsed = elapsedMs !== undefined && elapsedMs >= 1_000 ? formatDuration(elapsedMs) : null;
        const tone = SUB_TONE[subagent.status];
        return (
            <div
                className={cn("telemetry", "telemetry--sub", className)}
                role="status"
                aria-live="polite"
                data-testid="telemetry"
            >
                <span className={cn("telemetry__state", "sub-state", tone)} data-testid="telemetry-state">
                    <StatusDot status={dot.status} steady={dot.steady} />
                    {t(`state.${subagent.status}`)}
                </span>
                {elapsed ? (
                    <>
                        <Tsep />
                        <span className="sub-fact sub-fact--elapsed" data-testid="telemetry-elapsed">
                            {t(ticking ? "chat.subview.elapsed" : "chat.subview.duration", { dur: elapsed })}
                        </span>
                    </>
                ) : null}
                <Tsep />
                <span className="sub-fact" data-testid="telemetry-tools">
                    {plural("chat.telemetryTools", tools)}
                </span>
                <Tsep />
                <span className="sub-fact" data-testid="telemetry-turns">
                    {plural("chat.telemetryTurns", turns)}
                </span>
                {session?.contextUsage ? (
                    <>
                        <Tsep bar />
                        <CtxRing usage={session.contextUsage} />
                    </>
                ) : null}
                {hasTokens(session?.usage) ? (
                    <>
                        <Tsep />
                        <Tokens usage={session?.usage} />
                    </>
                ) : null}
                {subagent.model ? (
                    <>
                        <Tsep />
                        <span className="sub-fact sub-fact--model" data-testid="telemetry-model" title={subagent.model}>
                            {subagent.model}
                        </span>
                    </>
                ) : null}
                {subagent.thinking ? (
                    <>
                        <Tsep />
                        <span className="sub-fact sub-fact--think" data-testid="telemetry-thinking">
                            {subagent.thinking}
                        </span>
                    </>
                ) : null}
            </div>
        );
    }

    const counts = countTelemetry(entries);
    return (
        <div className={cn("telemetry", className)} role="status" aria-live="polite" data-testid="telemetry">
            <span className="telemetry__fact" data-testid="telemetry-turns">
                {plural("chat.telemetryTurns", counts.turns)}
            </span>
            <Tsep />
            <span className="telemetry__fact" data-testid="telemetry-tools">
                {plural("chat.telemetryTools", counts.tools)}
            </span>
            {session?.contextUsage ? (
                <>
                    <Tsep bar />
                    <CtxRing usage={session.contextUsage} />
                </>
            ) : null}
            {hasTokens(session?.usage) ? (
                <>
                    <Tsep />
                    <Tokens usage={session?.usage} />
                </>
            ) : null}
        </div>
    );
}
