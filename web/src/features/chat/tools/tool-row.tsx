/**
 * One tool call = one row.
 *
 * Anatomy (design/CHAT-TOOL-RENDER.md §2): `.tool > .tool__row > .tool__head`
 * with state glyph + family icon + verb + target + ≤3 facts + duration + caret, then
 * an optional `.tool__error`, then the lazy `.tool__body`.
 *
 * Expansion is *local* state: opening one row re-renders that row only, never the
 * message stream, and the body is mounted on the first expand and kept afterwards.
 */
import "@/styles/tool-core.css";

import { Fragment, useId, useState } from "react";
import { ArrowUp, Ban, ChevronDown, Circle, CircleCheck, CircleStop, Clock, TriangleAlert } from "lucide-react";

import { capFacts, defaultFacts, normalizeTool } from "./facts";
import { durShort, fileTarget, fmtNum, tr } from "./format";
import { KIND_ICON, humanName, kindOf } from "./kind";
import { specFor } from "./registry";
import { STATE_KEY, isFailure, isRunning, isSoft, stateOf } from "./state";
import { ToolBody, ToolError, ToolOps } from "./tool-body";
import { useElapsed } from "./use-elapsed";
import type { Fact, ToolIconComponent, ToolRowProps, ToolSpec, ToolState, ToolView } from "./types";

interface Glyph {
    icon: ToolIconComponent;
    className: string;
}

/** One glyph per canonical state; `running` renders the spinner instead (§3). */
const STATE_GLYPH: Record<Exclude<ToolState, "running">, Glyph> = {
    done: { icon: CircleCheck, className: "" },
    queued: { icon: Circle, className: "is-queued" },
    failed: { icon: TriangleAlert, className: "is-err" },
    timeout: { icon: Clock, className: "is-err" },
    interrupted: { icon: ArrowUp, className: "is-warn" },
    rejected: { icon: Ban, className: "is-warn" },
    cancelled: { icon: CircleStop, className: "is-muted" },
};

function StateGlyph({ state }: { state: ToolState }) {
    if (state === "running") {
        return (
            <span className="tool__state" aria-hidden="true">
                <span className="spinner" />
            </span>
        );
    }
    const glyph = STATE_GLYPH[state];
    const GlyphIcon = glyph.icon;
    const className = glyph.className ? `tool__state-ico ${glyph.className}` : "tool__state-ico";
    return (
        <span className="tool__state" aria-hidden="true">
            <GlyphIcon size={13} strokeWidth={2} className={className} />
        </span>
    );
}

function FactNode({ fact }: { fact: Fact }) {
    if (fact.kind === "stat") {
        return (
            <span className="tool__stat">
                <span className="is-add">{tr("chat.meta.added", { n: fmtNum(fact.added) })}</span>
                <span className="is-del">{tr("chat.meta.removed", { n: fmtNum(fact.removed) })}</span>
            </span>
        );
    }
    if (fact.kind === "tag") return <span className="badge badge--outline">{fact.label}</span>;
    return <span className="tool__fact">{fact.text}</span>;
}

/** `spec.verb` → `chat.tv.<base>.<running|done|failed>` (queued uses the done tense). */
function verbOf(tool: ToolView, spec: ToolSpec, state: ToolState): string {
    const raw = typeof spec.verb === "function" ? spec.verb(tool) : spec.verb || kindOf(tool.name);
    const bucket = state === "failed" ? "failed" : isRunning(state) ? "running" : "done";
    return tr(`chat.tv.${raw}.${bucket}`);
}

/** Hard failures always explain themselves; soft states only with an explicit reason. */
function errorTextOf(tool: ToolView, spec: ToolSpec, state: ToolState): string | null {
    if (!isFailure(state) && !isSoft(state)) return null;
    const explicit = tool.result?.error || tool.result?.stderr || null;
    const fromSpec = spec.error ? spec.error(tool) : null;
    if (explicit) return fromSpec || String(explicit);
    if (isFailure(state)) return fromSpec || tool.text?.lines?.[0] || tr(STATE_KEY[state]);
    return null;
}

export function ToolRow({ tool: rawTool, ctx = {}, defaultOpen = false }: ToolRowProps) {
    const tool = normalizeTool(rawTool);
    const kind = tool.kind ?? kindOf(tool.name);
    const spec = specFor(kind);
    const state = stateOf(tool);
    const running = isRunning(state);
    const inline = spec.inline === true || tool.inline === true;

    const [open, setOpen] = useState(Boolean(defaultOpen));
    const [mounted, setMounted] = useState(Boolean(defaultOpen));
    const bodyId = `tb-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

    const verb = verbOf(tool, spec, state);
    const target = String((spec.target ? spec.target(tool) : fileTarget(tool)) || "");
    const facts = capFacts(spec.meta ? spec.meta(tool) : defaultFacts(tool));
    const elapsed = useElapsed(tool.startedAt, running);
    const duration =
        running && elapsed
            ? elapsed
            : tool.durationMs != null && tool.durationMs >= 1000
              ? durShort(tool.durationMs)
              : "";

    const stateLabel = tr(STATE_KEY[state]);
    const factText = facts
        .map((fact) => (fact.kind === "text" ? fact.text : fact.kind === "tag" ? fact.label : ""))
        .filter(Boolean)
        .join(" ");
    const targetLabel = target || humanName(tool.name);
    const baseLabel = tr("chat.meta.ariaTool", {
        verb,
        target: targetLabel,
        state: stateLabel,
        meta: factText,
    })
        .replace(/\s+/g, " ")
        .trim();
    const ariaLabel = open
        ? `${baseLabel} ${tr("chat.meta.ariaCollapse")}`.replace(/\s+/g, " ").trim()
        : baseLabel;

    const FamilyIcon = spec.icon ?? KIND_ICON[kind];
    const errorText = errorTextOf(tool, spec, state);
    const toggle = () => {
        if (!open) setMounted(true);
        setOpen((value) => !value);
    };

    const inner = (
        <>
            <StateGlyph state={state} />
            <span className="tool__icon" aria-hidden="true">
                <FamilyIcon size={13} strokeWidth={1.75} />
            </span>
            <span className={isFailure(state) ? "tool__verb is-err" : "tool__verb"} title={verb}>
                {verb}
            </span>
            <span className="tool__target mono truncate" title={target}>
                {target}
            </span>
            <span className="tool__meta tabular">
                {facts.map((fact, index) => (
                    <Fragment key={index}>
                        {index ? (
                            <span className="tsep" aria-hidden="true">
                                ·
                            </span>
                        ) : null}
                        <FactNode fact={fact} />
                    </Fragment>
                ))}
            </span>
            <span className="tool__dur tabular">{duration}</span>
            {inline ? null : (
                <span className="tool__caret" aria-hidden="true">
                    <ChevronDown size={12} strokeWidth={2} />
                </span>
            )}
        </>
    );

    return (
        <div
            className={`tool tool--${kind} tool--${state}${inline ? " is-inline" : ""}${open ? " is-open" : ""}`}
            data-tool={tool.name || "tool"}
            data-kind={kind}
            data-state={state}
            data-msg={tool.messageId}
        >
            <div className="tool__row">
                {inline ? (
                    <div className="tool__head" aria-label={ariaLabel}>
                        {inner}
                    </div>
                ) : (
                    <button
                        className="tool__head"
                        type="button"
                        aria-expanded={open}
                        aria-controls={bodyId}
                        aria-label={ariaLabel}
                        onClick={toggle}
                    >
                        {inner}
                    </button>
                )}
                <ToolOps tool={tool} ctx={ctx} spec={spec} />
            </div>
            {errorText ? <ToolError text={errorText} /> : null}
            {inline ? null : (
                <ToolBody tool={tool} ctx={ctx} spec={spec} id={bodyId} hidden={!open} mounted={mounted} />
            )}
        </div>
    );
}
