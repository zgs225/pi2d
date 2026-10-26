/**
 * Row facts (`.tool__meta`) — at most 3 per row, "宁少不多" (design §1).
 * Also home of `normalizeTool()`, the legacy-DTO degradation the prototype does
 * in `core.js:177-183` (old `details` string → `text.lines`).
 */
import { fileTarget, tpNum, tr } from "./format";
import { isFailure, stateOf } from "./state";
import type { Fact, ToolView } from "./types";

/** §1: facts are capped at 3; everything past it is dropped, never summarized. */
export const MAX_FACTS = 3;

export function fact(text: string): Fact {
    return { kind: "text", text };
}

export function statFact(added: number, removed: number): Fact {
    return { kind: "stat", added, removed };
}

export function tagFact(label: string): Fact {
    return { kind: "tag", label };
}

export function capFacts(facts: Fact[] | null | undefined, max = MAX_FACTS): Fact[] {
    return (facts ?? []).filter(Boolean).slice(0, max);
}

/**
 * Legacy DTO compatibility: an old `{details: "text"}` tool has no `text.lines`,
 * so degrade `details` into lines. Never mutates the caller's object.
 */
export function normalizeTool(tool: ToolView): ToolView {
    const hasLines = Array.isArray(tool.text?.lines) && (tool.text?.lines?.length ?? 0) > 0;
    if (hasLines || tool.details == null || tool.details === "") return tool;
    return { ...tool, text: { ...(tool.text ?? {}), lines: String(tool.details).split("\n") } };
}

/** Generic facts for families without a `meta()` override (`core.js:196-217`). */
export function defaultFacts(tool: ToolView): Fact[] {
    const meta = tool.meta ?? {};
    const state = stateOf(tool);
    const out: Fact[] = [];
    const hasRange = Array.isArray(meta.range) && Boolean(tool.input?.path);

    if (meta.lines != null && !hasRange) out.push(fact(tpNum("chat.meta.lines", Number(meta.lines))));
    if (meta.matches != null) out.push(fact(tpNum("chat.meta.matches", Number(meta.matches))));
    if (meta.files != null) out.push(fact(tpNum("chat.meta.files", Number(meta.files))));
    if (meta.entries != null) out.push(fact(tpNum("chat.meta.entries", Number(meta.entries))));
    if (meta.images != null) out.push(fact(tpNum("chat.meta.images", Number(meta.images))));
    if (meta.added != null || meta.removed != null) {
        out.push(statFact(Number(meta.added) || 0, Number(meta.removed) || 0));
    }
    if (meta.newFile) out.push(tagFact(tr("chat.meta.newFile")));
    if (tool.input?.background) out.push(fact(tr("chat.meta.background")));
    if (isFailure(state) && meta.exitCode != null) {
        out.push(fact(tr("chat.meta.exit", { code: String(meta.exitCode) })));
    }
    if (tool.result?.truncated) out.push(fact(tr("chat.meta.truncated")));
    if (tool.agent) out.push(fact(tr("chat.meta.agent", { name: tool.agent })));

    return capFacts(out);
}

/** Facts for a row: the family's own list, or the generic default. */
export function factsFor(tool: ToolView, provided: Fact[] | null | undefined): Fact[] {
    return capFacts(provided && provided.length ? provided : defaultFacts(tool));
}

/** Target fallback shared by every spec that does not override it. */
export function targetFor(tool: ToolView, provided?: (tool: ToolView) => string): string {
    if (!provided) return fileTarget(tool);
    const value = provided(tool);
    return value == null || value === "" ? fileTarget(tool) : value;
}
