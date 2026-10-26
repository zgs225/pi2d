/**
 * `shell` (bash / exec / shell) + `task` (task / tasks) — one family, one shape.
 *
 * Row: `verb target · background · exit N · N 行`. Body: `$ command` (≤3 lines,
 * copy), log (head 5 + tail 5 with a counted fold), and a footer that only exists
 * for failed / soft states (`task` adds the stop button).
 */
import "@/styles/tool-shell.css";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Square } from "lucide-react";

import { Button } from "@/components/ui/button";

import { capFacts, fact } from "../facts";
import { copyText, durShort, fileTarget, tpNum, tr } from "../format";
import { KIND_ICON } from "../kind";
import { isFailure, isRunning, isSoft, stateOf } from "../state";
import type { Fact, ToolBodyProps, ToolCtx, ToolSpec, ToolView } from "../types";

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cmdOf(tool: ToolView): string {
    return str(tool.input?.command) ?? "";
}

function exitCodeOf(tool: ToolView): number | null {
    const meta = num(tool.meta?.exitCode);
    if (meta != null) return meta;
    const result = num(tool.result?.exitCode);
    return result ?? null;
}

function lineCountOf(tool: ToolView): number | null {
    const total = num(tool.text?.totalLines);
    if (total != null) return total;
    const meta = num(tool.meta?.lines);
    if (meta != null) return meta;
    const lines = tool.text?.lines;
    if (Array.isArray(lines)) return lines.length;
    return num(tool.result?.lines) ?? null;
}

function taskIdOf(tool: ToolView): string | null {
    return str(tool.input?.taskId) ?? str(tool.result?.taskId) ?? str(tool.meta?.taskId) ?? null;
}

function isTruncated(tool: ToolView): boolean {
    return Boolean(tool.text?.truncated) || tool.result?.truncated === true;
}

/** Target = first non-empty command line (prototype `shell.js:52-58`). */
function targetOf(tool: ToolView): string {
    const command = cmdOf(tool);
    if (!command) return fileTarget(tool);
    const first = command
        .split("\n")
        .map((line) => line.trim())
        .find(Boolean);
    return first || fileTarget(tool);
}

/** Facts, in priority order: background · exit N · N 行 · truncated (≤3). */
function metaOf(tool: ToolView): Fact[] {
    const out: Fact[] = [];
    const exitCode = exitCodeOf(tool);
    const lines = lineCountOf(tool);
    if (tool.input?.background) out.push(fact(tr("chat.meta.background")));
    if (exitCode != null && exitCode !== 0) out.push(fact(tr("chat.meta.exit", { code: String(exitCode) })));
    if (lines != null) out.push(fact(tpNum("chat.meta.lines", lines)));
    if (isTruncated(tool)) out.push(fact(tr("chat.meta.truncated")));
    return capFacts(out);
}

/** Failure phrase: `result.error` → `result.stderr` → (hard failure only) first line. */
function errorOf(tool: ToolView): string | null {
    const first = tool.text?.lines?.[0] ?? null;
    const raw = tool.result?.error || tool.result?.stderr || (isFailure(stateOf(tool)) ? first : null);
    if (raw == null || raw === "") return null;
    return String(raw).split("\n")[0] ?? null;
}

function actionsOf(tool: ToolView, ctx: ToolCtx) {
    const actions: ReturnType<NonNullable<ToolSpec["actions"]>> = [];
    const command = cmdOf(tool);
    if (command) {
        actions.push({
            icon: Copy,
            labelKey: "chat.shell.copyCommand",
            onAction: () => copyText(command),
        });
    }
    const taskId = taskIdOf(tool);
    if (tool.input?.background && taskId && isRunning(stateOf(tool)) && ctx.onStopTask) {
        actions.push({
            icon: Square,
            labelKey: "chat.shell.stop",
            danger: true,
            onAction: () => ctx.onStopTask?.(taskId),
        });
    }
    return actions;
}

function CmdBlock({ command }: { command: string }) {
    const { t } = useTranslation();
    const all = command.split("\n");
    const shown = all.slice(0, 3).join("\n");
    const hidden = all.length - 3;
    return (
        <div className="shell__cmd">
            <span className="shell__prompt" aria-hidden="true">
                $
            </span>
            <div className="shell__cmd-main">
                <pre className="shell__cmd-text mono" title={command}>
                    {shown}
                </pre>
                {hidden > 0 ? (
                    <span className="shell__cmd-count">{t("chat.meta.shownOfTotal", { shown: 3, total: all.length })}</span>
                ) : null}
            </div>
            <Button
                variant="ghost"
                size="sm"
                className="shell__copy"
                aria-label={t("chat.shell.copyCommand")}
                title={t("chat.shell.copyCommand")}
                onClick={() => copyText(command)}
            >
                <Copy size={12} aria-hidden />
                <span className="shell__copy-label">{t("chat.shell.copyCommand")}</span>
            </Button>
        </div>
    );
}

function LogBlock({ tool }: { tool: ToolView }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const logRef = useRef<HTMLDivElement>(null);
    const all = tool.text?.lines ?? [];
    const truncated = tool.text?.truncated && typeof tool.text.truncated === "object" ? tool.text.truncated : null;
    const headCount = truncated ? (truncated.headLines ?? 5) : all.length;
    const tailCount = truncated ? (truncated.tailLines ?? 5) : 0;
    const total = truncated?.total ?? all.length;
    const head = all.slice(0, headCount);
    const tail = tailCount ? all.slice(Math.max(head.length, all.length - tailCount)) : [];
    const omitted = truncated ? Math.max(0, total - headCount - tailCount) : 0;
    const running = isRunning(stateOf(tool));

    // Running rows follow the tail; a manual scroll stops it because the fold is local state.
    useEffect(() => {
        const node = logRef.current;
        if (running && node && !expanded) node.scrollTop = node.scrollHeight;
    }, [running, all.length, expanded]);

    if (!all.length) return <div className="tool-empty">{t("chat.meta.noOutput")}</div>;

    const showAllLines = expanded || !truncated || omitted <= 0;
    const lines = showAllLines ? all : head;

    return (
        <div className="shell__log" ref={logRef}>
            {lines.map((line, index) => (
                <div className="shell__line mono" key={index}>
                    {line}
                </div>
            ))}
            {showAllLines ? null : (
                <>
                    <div className="shell__omitted">
                        <span className="shell__omitted-text">{tpNum("chat.meta.omitted", omitted)}</span>
                        <Button variant="ghost" size="sm" className="shell__show-all" onClick={() => setExpanded(true)}>
                            {t("chat.meta.showAll")}
                        </Button>
                    </div>
                    {tail.map((line, index) => (
                        <div className="shell__line mono" key={`tail-${index}`}>
                            {line}
                        </div>
                    ))}
                </>
            )}
        </div>
    );
}

function FootBlock({ tool, ctx, stop }: ToolBodyProps & { stop?: boolean }) {
    const { t } = useTranslation();
    const state = stateOf(tool);
    const exitCode = exitCodeOf(tool);
    const lines = lineCountOf(tool);
    const duration = tool.durationMs != null ? durShort(tool.durationMs) : null;

    const parts: string[] = [];
    if (exitCode != null) parts.push(tr("chat.meta.exit", { code: String(exitCode) }));
    if (duration) parts.push(duration);
    if (lines != null) parts.push(tpNum("chat.meta.lines", lines));

    const taskId = taskIdOf(tool);
    const canStop = Boolean(stop && taskId && (state === "running" || state === "queued") && ctx.onStopTask);
    // Success has no footer at all (§0.2); failures/soft states explain themselves.
    const showFacts = (isFailure(state) || isSoft(state)) && parts.length > 0;
    if (!showFacts && !canStop) return null;

    return (
        <div className="shell__foot">
            {showFacts
                ? parts.map((part, index) => (
                      <span key={part + index}>
                          {index ? (
                              <span className="tsep" aria-hidden="true">
                                  ·
                              </span>
                          ) : null}
                          <span className="shell__foot-item tabular">{part}</span>
                      </span>
                  ))
                : null}
            {canStop ? (
                <Button
                    variant="danger"
                    size="sm"
                    className="shell__stop"
                    onClick={() => {
                        if (taskId) ctx.onStopTask?.(taskId);
                    }}
                >
                    <Square size={12} aria-hidden />
                    <span>{t("chat.shell.stop")}</span>
                </Button>
            ) : null}
        </div>
    );
}

function ShellBody({ tool, ctx, stop }: ToolBodyProps & { stop?: boolean }) {
    const command = cmdOf(tool);
    return (
        <div className="shell__body">
            {command ? <CmdBlock command={command} /> : null}
            <LogBlock tool={tool} />
            <FootBlock tool={tool} ctx={ctx} stop={stop} />
        </div>
    );
}

export const shellSpec: ToolSpec = {
    id: "shell",
    icon: KIND_ICON.shell,
    verb: "shell",
    target: targetOf,
    meta: metaOf,
    error: errorOf,
    actions: actionsOf,
    Body: (props) => <ShellBody {...props} />,
};

/** Same shape as `shell`; only the verb, glyph and the footer stop button differ. */
export const taskSpec: ToolSpec = {
    ...shellSpec,
    id: "task",
    icon: KIND_ICON.task,
    verb: "task",
    Body: (props) => <ShellBody {...props} stop />,
};
