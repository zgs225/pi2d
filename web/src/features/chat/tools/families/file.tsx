/**
 * `read` (inline row, no body) + `write` (edit / write / patch / multi_edit).
 *
 * The write body is the unified-diff viewer: file accordion (first file open), hunk
 * folding (>40 lines → head 20 + tail 10, >3 hunks → "还有 N 段"), two-column line
 * numbers. `+`/`-` rows colour the row background and the gutter only; line numbers
 * use `--muted-foreground` (not `--faint`) so they stay ≥4.5:1.
 */
import "@/styles/tool-file.css";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

import { capFacts, defaultFacts, fact, statFact, tagFact } from "../facts";
import { copyText, fileTarget, fmtNum, tpNum, tr } from "../format";
import { KIND_ICON } from "../kind";
import { isFailure, stateOf } from "../state";
import type { DiffFile, DiffHunk, DiffLine, Fact, ToolBodyProps, ToolSpec, ToolView } from "../types";

const LINE_CAP = 40;
const HUNK_HEAD = 20;
const HUNK_TAIL = 10;
const HUNKS_SHOWN = 3;

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function toNumber(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function isCreate(tool: ToolView): boolean {
    return tool.name === "write" || tool.input?.mode === "create";
}

/** Failure phrase, appending `chat.diff.notFound` unless the message already says it. */
function writeError(tool: ToolView): string | null {
    const raw = String(tool.result?.error || tool.result?.stderr || "").split("\n")[0]?.trim() ?? "";
    const head = raw || (isFailure(stateOf(tool)) ? (tool.text?.lines?.[0]?.trim() ?? "") : "");
    if (isCreate(tool)) return head || null;
    const notFound = tr("chat.diff.notFound");
    if (head) {
        // The provider message often already names the reason — do not double-prefix it.
        if (head.toLowerCase().includes(notFound.toLowerCase())) return head;
        return `${notFound} · ${head}`;
    }
    return isFailure(stateOf(tool)) ? notFound : null;
}

function readError(tool: ToolView): string | null {
    const raw = String(tool.result?.error || tool.result?.stderr || "").split("\n")[0]?.trim() ?? "";
    const head = raw || (isFailure(stateOf(tool)) ? (tool.text?.lines?.[0]?.trim() ?? "") : "");
    return head || null;
}

function lineTotals(file: DiffFile): { added: number; removed: number } {
    const hunks = Array.isArray(file.hunks) ? file.hunks : [];
    let added = toNumber(file.added);
    let removed = toNumber(file.removed);
    if (added == null && removed == null) {
        added = 0;
        removed = 0;
        for (const hunk of hunks) {
            for (const line of hunk?.lines ?? []) {
                if (line?.t === "add") added += 1;
                else if (line?.t === "del") removed += 1;
            }
        }
    }
    return { added: added ?? 0, removed: removed ?? 0 };
}

/** Row totals: explicit meta → diff files → result (prototype `file.js:67-85`). */
function toolTotals(tool: ToolView): { added: number; removed: number } | null {
    if (tool.meta?.added != null || tool.meta?.removed != null) {
        return { added: toNumber(tool.meta.added) ?? 0, removed: toNumber(tool.meta.removed) ?? 0 };
    }
    const files = (tool.diff?.files ?? []).filter(Boolean);
    if (files.length) {
        return files.reduce<{ added: number; removed: number }>(
            (acc, file) => {
                const one = lineTotals(file);
                acc.added += one.added;
                acc.removed += one.removed;
                return acc;
            },
            { added: 0, removed: 0 },
        );
    }
    if (tool.result?.added != null || tool.result?.removed != null) {
        return { added: toNumber(tool.result.added) ?? 0, removed: toNumber(tool.result.removed) ?? 0 };
    }
    return null;
}

function readMeta(tool: ToolView): Fact[] {
    const out: Fact[] = [];
    const lines = toNumber(tool.meta?.lines) ?? toNumber(tool.result?.lines);
    if (lines != null) out.push(fact(tpNum("chat.meta.lines", lines)));
    if (tool.result?.truncated) out.push(fact(tr("chat.meta.truncated")));
    if (tool.agent) out.push(fact(tr("chat.meta.agent", { name: tool.agent })));
    return capFacts(out);
}

function writeMeta(tool: ToolView): Fact[] {
    const out: Fact[] = [];
    const totals = toolTotals(tool);
    if (totals && (totals.added || totals.removed)) out.push(statFact(totals.added, totals.removed));
    const addedFile = (tool.diff?.files ?? []).some((file) => file?.status === "added");
    if (tool.meta?.newFile || isCreate(tool) || addedFile) out.push(tagFact(tr("chat.meta.newFile")));
    if (tool.meta?.lines != null) out.push(fact(tpNum("chat.meta.lines", Number(tool.meta.lines))));
    if (tool.agent) out.push(fact(tr("chat.meta.agent", { name: tool.agent })));
    return capFacts(out);
}

function diffText(files: DiffFile[]): string {
    const out: string[] = [];
    for (const file of files) {
        const path = String(file.path ?? "");
        out.push(`diff --git a/${path} b/${path}`);
        if (file.status === "added") out.push("new file mode 100644");
        if (file.status === "deleted") out.push("deleted file mode 100644");
        out.push(file.status === "added" ? "--- /dev/null" : `--- a/${path}`);
        out.push(file.status === "deleted" ? "+++ /dev/null" : `+++ b/${path}`);
        for (const hunk of file.hunks ?? []) {
            if (!hunk) continue;
            out.push(String(hunk.header ?? `@@ -${hunk.oldStart ?? 0} +${hunk.newStart ?? 0} @@`));
            for (const line of hunk.lines ?? []) {
                if (!line) continue;
                const sign = line.t === "add" ? "+" : line.t === "del" ? "-" : " ";
                out.push(sign + String(line.text ?? ""));
            }
        }
    }
    return out.join("\n");
}

function EmptyDiff({ tool }: { tool: ToolView }) {
    const { t } = useTranslation();
    const path = str(tool.input?.path) ?? fileTarget(tool);
    return (
        <div className="diff__empty">
            <span className="diff__empty-text">{t("chat.diff.empty")}</span>
            {path ? (
                <span className="diff__empty-path mono truncate" title={path}>
                    {path}
                </span>
            ) : null}
        </div>
    );
}

function Sign({ kind }: { kind: "add" | "del" | "ctx" }) {
    return (
        <span className="diff__sign" aria-hidden="true">
            {kind === "add" ? "+" : kind === "del" ? "−" : " "}
        </span>
    );
}

function LineRow({ line }: { line: DiffLine }) {
    const kind: "add" | "del" | "ctx" = line.t === "add" ? "add" : line.t === "del" ? "del" : "ctx";
    return (
        <div className={`diff__line diff__line--${kind}`}>
            <span className="diff__num diff__num--old tabular">{line.old == null ? "" : String(line.old)}</span>
            <span className="diff__num diff__num--new tabular">{line.new == null ? "" : String(line.new)}</span>
            <span className="diff__code">
                <Sign kind={kind} />
                <span className="diff__text mono">{String(line.text ?? "")}</span>
            </span>
        </div>
    );
}

function Hunk({ hunk }: { hunk: DiffHunk }) {
    const [expanded, setExpanded] = useState(false);
    const lines = (hunk.lines ?? []).filter(Boolean);
    const header = String(hunk.header ?? `@@ -${hunk.oldStart ?? 0} +${hunk.newStart ?? 0} @@`);

    if (lines.length <= LINE_CAP || expanded) {
        return (
            <div className="diff__hunk">
                <div className="diff__hunkhead mono">{header}</div>
                {lines.map((line, index) => (
                    <LineRow line={line} key={index} />
                ))}
            </div>
        );
    }

    const head = lines.slice(0, HUNK_HEAD);
    const tail = lines.slice(lines.length - HUNK_TAIL);
    const omitted = lines.length - HUNK_HEAD - HUNK_TAIL;
    return (
        <div className="diff__hunk">
            <div className="diff__hunkhead mono">{header}</div>
            {head.map((line, index) => (
                <LineRow line={line} key={`h${index}`} />
            ))}
            <button className="diff__more" type="button" onClick={() => setExpanded(true)}>
                <span className="diff__more-count">{tpNum("chat.meta.omitted", omitted)}</span>
                <span className="diff__more-cta">{tpNum("chat.diff.showMore", omitted)}</span>
            </button>
            {tail.map((line, index) => (
                <LineRow line={line} key={`t${index}`} />
            ))}
        </div>
    );
}

function FileBlock({ file, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    const [showAllHunks, setShowAllHunks] = useState(false);
    const path = String(file.path ?? "");
    const totals = lineTotals(file);
    const hunks = (file.hunks ?? []).filter(Boolean);
    const tagKey = file.status === "added" ? "chat.meta.newFile" : file.status === "deleted" ? "chat.meta.deletedFile" : null;

    return (
        <div className={`diff__file${open ? " is-open" : ""}`}>
            <button className="diff__head" type="button" aria-expanded={open} onClick={onToggle}>
                <span className="diff__caret" aria-hidden="true">
                    <ChevronDown size={12} />
                </span>
                {tagKey ? <span className="diff__tag">{t(tagKey)}</span> : null}
                <span className="diff__path mono truncate" title={path}>
                    {path}
                </span>
                {totals.added || totals.removed ? (
                    <span className="diff__stat tabular">
                        <span className="is-add">{t("chat.meta.added", { n: fmtNum(totals.added) })}</span>
                        <span className="is-del">{t("chat.meta.removed", { n: fmtNum(totals.removed) })}</span>
                    </span>
                ) : null}
            </button>
            {open ? (
                <div className="diff__body">
                    {hunks.length === 0 ? (
                        <div className="diff__empty">
                            <span className="diff__empty-text">{t("chat.diff.empty")}</span>
                        </div>
                    ) : (
                        <>
                            {(showAllHunks ? hunks : hunks.slice(0, HUNKS_SHOWN)).map((hunk, index) => (
                                <Hunk hunk={hunk} key={index} />
                            ))}
                            {!showAllHunks && hunks.length > HUNKS_SHOWN ? (
                                <button className="diff__more" type="button" onClick={() => setShowAllHunks(true)}>
                                    {tpNum("chat.diff.moreHunks", hunks.length - HUNKS_SHOWN)}
                                </button>
                            ) : null}
                        </>
                    )}
                </div>
            ) : null}
        </div>
    );
}

function DiffBody({ tool }: ToolBodyProps) {
    const { t } = useTranslation();
    const files = (tool.diff?.files ?? []).filter(Boolean);
    const [open, setOpen] = useState<Record<number, boolean>>({ 0: true });

    if (!files.length) return <EmptyDiff tool={tool} />;

    const setAll = (next: boolean) => {
        setOpen(Object.fromEntries(files.map((_, index) => [index, next])));
    };

    return (
        <div className="diff">
            {files.length > 1 ? (
                <div className="diff__bar">
                    <span className="diff__bar-files tabular">{tpNum("chat.diff.files", files.length)}</span>
                    <Button variant="ghost" size="sm" className="diff__bar-btn" onClick={() => setAll(true)}>
                        {t("chat.meta.showAll")}
                    </Button>
                    <Button variant="ghost" size="sm" className="diff__bar-btn" onClick={() => setAll(false)}>
                        {t("chat.meta.collapse")}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="diff__bar-btn diff__bar-copy"
                        aria-label={t("chat.diff.copy")}
                        title={t("chat.diff.copy")}
                        onClick={() => copyText(diffText(files))}
                    >
                        <Copy size={12} aria-hidden />
                        <span>{t("chat.diff.copy")}</span>
                    </Button>
                </div>
            ) : null}
            <div className="diff__files">
                {files.map((file, index) => (
                    <FileBlock
                        file={file}
                        key={`${file.path ?? "file"}-${index}`}
                        open={Boolean(open[index])}
                        onToggle={() => setOpen((current) => ({ ...current, [index]: !current[index] }))}
                    />
                ))}
            </div>
        </div>
    );
}

/** `read` is inline: one row, no caret, no body (design §4.2). */
export const readSpec: ToolSpec = {
    id: "read",
    icon: KIND_ICON.read,
    inline: true,
    verb: "read",
    target: fileTarget,
    meta: readMeta,
    error: readError,
    actions: (tool) => [
        {
            icon: Copy,
            labelKey: "chat.meta.copyPath",
            onAction: () => copyText(str(tool.input?.path) ?? fileTarget(tool)),
        },
    ],
};

export const writeSpec: ToolSpec = {
    id: "write",
    icon: KIND_ICON.write,
    verb: (tool) => (isCreate(tool) ? "write.create" : "write"),
    target: fileTarget,
    meta: writeMeta,
    error: writeError,
    Body: (props) => <DiffBody {...props} />,
};

/** Read-only fallback for the generic family when it needs the shared defaults. */
export { defaultFacts };
