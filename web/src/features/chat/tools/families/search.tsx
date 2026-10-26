/**
 * `search` (grep / search) + `find` (find / glob / ls / list_dir).
 *
 * Row: `搜索 “pattern” · path | N 个文件 · M 处`. Bodies: hits grouped by file with
 * pattern highlighting and a three-level fold budget (6 hits/file, 60 hits, 12 files);
 * `find` is a flat, one-level-directory-grouped list folded at 15 items. Every fold
 * reports how many items are hidden (`chat.meta.more`).
 */
import "@/styles/tool-search.css";

import { Fragment, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, File, Folder } from "lucide-react";

import { capFacts, fact } from "../facts";
import { copyText, fileTarget, fmtNum, tpNum, tr } from "../format";
import { KIND_ICON, humanName } from "../kind";
import type { Fact, FsEntry, SearchMatch, ToolBodyProps, ToolSpec, ToolView } from "../types";

/* Fold budgets (contract §4.4 / §4.5). */
const MAX_HITS_PER_FILE = 6;
const MAX_HITS = 60;
const MAX_FILES = 12;
const MAX_FIND_ITEMS = 15;
/** Highlight loop guard against pathological patterns (`search.js:17`). */
const MARK_GUARD = 400;

function str(value: unknown): string | undefined {
    return typeof value === "string" && value !== "" ? value : undefined;
}

function numOf(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function cmpStr(a: unknown, b: unknown): number {
    const x = String(a);
    const y = String(b);
    return x < y ? -1 : x > y ? 1 : 0;
}

function splitPath(path: unknown): { parts: string[]; name: string } {
    const parts = String(path ?? "")
        .split("/")
        .filter(Boolean);
    const name = parts.length ? (parts[parts.length - 1] ?? "") : String(path ?? "");
    return { parts, name };
}

/* ------------------------------------------------------------------ highlight */

interface Piece {
    text: string;
    mark?: boolean;
}

function patternRegex(pattern: string): RegExp | null {
    if (!pattern) return null;
    try {
        return new RegExp(pattern, "gi");
    } catch {
        return null;
    }
}

function literalPieces(src: string, needle: string): Piece[] {
    const out: Piece[] = [];
    const hay = src.toLowerCase();
    const low = needle.toLowerCase();
    let from = 0;
    let guard = 0;
    let idx = hay.indexOf(low, from);
    while (idx !== -1 && guard < MARK_GUARD) {
        guard += 1;
        if (idx > from) out.push({ text: src.slice(from, idx) });
        out.push({ text: src.slice(idx, idx + needle.length), mark: true });
        from = idx + needle.length;
        idx = hay.indexOf(low, from);
    }
    if (from < src.length) out.push({ text: src.slice(from) });
    return out.length ? out : [{ text: src }];
}

function regexPieces(src: string, re: RegExp): Piece[] | null {
    const out: Piece[] = [];
    let from = 0;
    let guard = 0;
    let match = re.exec(src);
    while (match !== null && guard < MARK_GUARD) {
        guard += 1;
        const at = match.index;
        if (!match[0]) {
            // Zero-width match: skip one char so the loop always advances.
            re.lastIndex += 1;
        } else {
            if (at > from) out.push({ text: src.slice(from, at) });
            out.push({ text: match[0], mark: true });
            from = at + match[0].length;
            if (re.lastIndex <= at) re.lastIndex = from;
        }
        match = re.exec(src);
    }
    if (!out.length) return null;
    if (from < src.length) out.push({ text: src.slice(from) });
    return out;
}

function highlight(text: unknown, pattern: unknown): ReactNode {
    const src = text == null ? "" : String(text);
    const needle = pattern == null ? "" : String(pattern);
    if (!src || !needle) return src;
    const re = patternRegex(needle);
    const pieces = (re && regexPieces(src, re)) || literalPieces(src, needle);
    return pieces.map((piece, index) =>
        piece.mark ? (
            <mark className="search__mark" key={index}>
                {piece.text}
            </mark>
        ) : (
            <Fragment key={index}>{piece.text}</Fragment>
        ),
    );
}

/* ------------------------------------------------------------------- helpers */

function TextLines({ lines }: { lines: string[] }) {
    return (
        <div className="tool-lines">
            {lines.map((line, index) => (
                <div className="tool-line" key={index}>
                    <span className="tool-line__txt mono">{line}</span>
                </div>
            ))}
        </div>
    );
}

function EmptyOutput() {
    return <div className="tool-empty">{tr("chat.meta.noOutput")}</div>;
}

function matchesOf(tool: ToolView): SearchMatch[] {
    return (Array.isArray(tool.matches) ? tool.matches : []).filter((m) => m && m.path != null && String(m.path) !== "");
}

function uniquePaths(list: SearchMatch[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const match of list) {
        const path = String(match.path);
        if (!seen.has(path)) {
            seen.add(path);
            out.push(path);
        }
    }
    return out.sort(cmpStr);
}

interface HitGroup {
    path: string;
    hits: SearchMatch[];
}

function groupHits(list: SearchMatch[]): HitGroup[] {
    const map = new Map<string, SearchMatch[]>();
    for (const match of list) {
        const path = String(match.path);
        const bucket = map.get(path);
        if (bucket) bucket.push(match);
        else map.set(path, [match]);
    }
    const groups: HitGroup[] = [...map.entries()].map(([path, hits]) => ({
        path,
        hits: [...hits].sort((a, b) => numOf(a.line) - numOf(b.line) || numOf(a.col) - numOf(b.col)),
    }));
    groups.sort((a, b) => cmpStr(a.path, b.path));
    return groups;
}

/* -------------------------------------------------------------------- search */

interface HitRow {
    hit: SearchMatch;
    hidden: boolean;
    overGroup: boolean;
    overGlobal: boolean;
}

function SearchBody({ tool }: ToolBodyProps) {
    const { t } = useTranslation();
    const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
    const [allOpen, setAllOpen] = useState(false);
    const matches = matchesOf(tool);

    if (!matches.length) {
        const lines = Array.isArray(tool.text?.lines) ? tool.text.lines : null;
        if (lines?.length) return <TextLines lines={lines} />;
        return (
            <div className="search__empty">
                <span className="search__empty-title">{t("chat.meta.noMatches")}</span>
                <span className="search__empty-hint">{t("chat.search.noMatchesHint")}</span>
            </div>
        );
    }

    const pattern = str(tool.input?.pattern) ?? "";
    const groups = groupHits(matches);

    // Budget accounting, exactly in prototype order: per-file first, then global.
    let shownFiles = 0;
    let shownHits = 0;
    let hiddenHits = 0;
    let globalOverflow = false;
    const blocks = groups.map((group) => {
        const globalOk = shownFiles < MAX_FILES && shownHits < MAX_HITS;
        const rows: HitRow[] = [];
        group.hits.forEach((hit, index) => {
            const overGroup = index >= MAX_HITS_PER_FILE;
            const overGlobal = !globalOk || shownHits >= MAX_HITS;
            if (overGroup || overGlobal) {
                hiddenHits += 1;
                if (overGlobal) globalOverflow = true;
            } else {
                shownHits += 1;
            }
            rows.push({ hit, hidden: overGroup || overGlobal, overGroup, overGlobal });
        });
        if (!globalOk) globalOverflow = true;
        else shownFiles += 1;
        return { group, globalOk, rows };
    });

    const groupMore = (path: string) => {
        if (allOpen) return false;
        const block = blocks.find((b) => b.group.path === path);
        return Boolean(block && block.globalOk && block.rows.some((row) => row.overGroup));
    };

    const rowHidden = (path: string, row: HitRow): boolean => {
        if (allOpen) return false;
        if (!row.hidden) return false;
        return !(openGroups[path] && row.overGroup);
    };

    return (
        <div className="search">
            {blocks.map(({ group, globalOk, rows }) => {
                const hidden = !globalOk && !allOpen;
                const hiddenCount = rows.filter((row) => row.overGroup).length;
                return (
                    <div className="search__group" hidden={hidden} key={group.path}>
                        <div className="search__file">
                            <span className="search__ico" aria-hidden="true">
                                <File size={12} />
                            </span>
                            <span className="search__path mono truncate" title={group.path}>
                                {group.path}
                            </span>
                            <span className="badge badge--outline badge--sm tabular">{fmtNum(group.hits.length)}</span>
                        </div>
                        <div className="search__hits">
                            {rows.map((row, index) => (
                                <div className="search__hit" hidden={rowHidden(group.path, row)} key={index}>
                                    <span className="search__ln tabular" aria-hidden="true">
                                        {row.hit.line == null ? "" : String(row.hit.line)}
                                    </span>
                                    <span className="search__code mono">{highlight(row.hit.text, pattern)}</span>
                                </div>
                            ))}
                        </div>
                        {groupMore(group.path) ? (
                            <div className="search__foot">
                                <button
                                    className="search__more search__more--group"
                                    type="button"
                                    onClick={() =>
                                        setOpenGroups((current) => ({ ...current, [group.path]: true }))
                                    }
                                >
                                    {t("chat.meta.more", { n: fmtNum(hiddenCount) })}
                                </button>
                            </div>
                        ) : null}
                    </div>
                );
            })}
            {hiddenHits > 0 && globalOverflow && !allOpen ? (
                <div className="search__foot search__foot--all">
                    <button className="search__more" type="button" onClick={() => setAllOpen(true)}>
                        {t("chat.meta.more", { n: fmtNum(hiddenHits) })}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

/* ---------------------------------------------------------------------- find */

interface FindItem {
    key: string;
    title: string;
    dir: string;
    name: string;
    type: "file" | "dir";
    size?: number | null;
}

interface FindGroup {
    key: string;
    label: string;
    items: FindItem[];
}

function filesGroups(tool: ToolView, files: string[]): FindGroup[] {
    const map = new Map<string, FindItem[]>();
    for (const path of [...files].sort(cmpStr)) {
        const { parts } = splitPath(path);
        const key =
            parts.length > 1 ? String(parts[0]) : (str(tool.input?.path) ?? humanName(tool.name));
        const rest = parts.length > 1 ? parts.slice(1) : parts;
        const name = rest.length ? String(rest[rest.length - 1]) : String(path);
        const item: FindItem = {
            key: `${key}\u0000${path}`,
            title: path,
            dir: rest.slice(0, -1).join("/"),
            name,
            type: "file",
        };
        const bucket = map.get(key);
        if (bucket) bucket.push(item);
        else map.set(key, [item]);
    }
    return [...map.entries()]
        .sort((a, b) => cmpStr(a[0], b[0]))
        .map(([key, items]) => ({
            key,
            label: key,
            items: items.sort((a, b) => cmpStr(a.name, b.name)),
        }));
}

function entriesGroups(tool: ToolView, entries: FsEntry[]): FindGroup[] {
    const label = str(tool.input?.path) ?? humanName(tool.name);
    const items = [...entries]
        .sort((a, b) => cmpStr(a?.name, b?.name))
        .map<FindItem>((entry, index) => {
            const isDir = entry?.type === "dir" || entry?.type === "directory";
            const name = String(entry?.name ?? "");
            return {
                key: `entry-${index}-${name}`,
                title: name,
                dir: "",
                name,
                type: isDir ? "dir" : "file",
                size: entry?.size ?? null,
            };
        });
    return [{ key: label, label, items }];
}

function FindBody({ tool }: ToolBodyProps) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);

    const entries = Array.isArray(tool.entries) ? tool.entries : null;
    const files = (Array.isArray(tool.files) ? tool.files : []).map(String).filter(Boolean);
    let groups: FindGroup[] | null = null;
    if (entries?.length) groups = entriesGroups(tool, entries);
    else if (files.length) groups = filesGroups(tool, files);
    if (!groups) {
        const lines = Array.isArray(tool.text?.lines) ? tool.text.lines : null;
        return lines?.length ? <TextLines lines={lines} /> : <EmptyOutput />;
    }

    let shown = 0;
    let hiddenTotal = 0;
    const budgeted = groups.map((group) => {
        const items = group.items.map((item) => {
            if (!expanded && shown >= MAX_FIND_ITEMS) {
                hiddenTotal += 1;
                return { item, hidden: true };
            }
            shown += 1;
            return { item, hidden: false };
        });
        return { ...group, items };
    });

    return (
        <div className="find">
            {budgeted.map((group) => {
                const visible = group.items.some((entry) => !entry.hidden);
                return (
                    <div className="find__group-box" hidden={!visible} key={group.key}>
                        <div className="find__group mono truncate" title={group.label}>
                            {group.label}
                        </div>
                        <div className="find__list">
                            {group.items.map(({ item, hidden }) => (
                                <div className="find__item" hidden={hidden} title={item.title} key={item.key}>
                                    <span className="find__ico" aria-hidden="true">
                                        {item.type === "dir" ? <Folder size={12} /> : <File size={12} />}
                                    </span>
                                    <span className="find__path mono">
                                        {item.dir ? <span className="find__dir">{item.dir}/</span> : null}
                                        <span className="find__name">{item.name}</span>
                                    </span>
                                    {item.size != null ? (
                                        <span className="find__size tabular" aria-hidden="true">
                                            {fmtNum(item.size)}
                                        </span>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    </div>
                );
            })}
            {hiddenTotal > 0 && !expanded ? (
                <div className="find__foot">
                    <button className="find__more" type="button" onClick={() => setExpanded(true)}>
                        {t("chat.meta.more", { n: fmtNum(hiddenTotal) })}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

/* ---------------------------------------------------------------------- specs */

function targetOf(tool: ToolView): string {
    const input = tool.input ?? {};
    const pattern = str(input.pattern);
    const path = str(input.path);
    if (pattern && path) return `“${pattern}” · ${path}`;
    if (pattern) return `“${pattern}”`;
    return fileTarget(tool);
}

function searchMeta(tool: ToolView): Fact[] {
    const matches = matchesOf(tool);
    const total = matches.length || Number(tool.meta?.matches ?? 0);
    const files = matches.length ? uniquePaths(matches).length : Number(tool.meta?.files ?? 0);
    const out: Fact[] = [];
    // 0 hits stay quiet: only `0 处`, never "0 个文件" and never an error.
    if (files && total) out.push(fact(tpNum("chat.meta.files", files)));
    out.push(fact(tpNum("chat.meta.matches", total)));
    if (tool.result?.truncated) out.push(fact(tr("chat.meta.truncated")));
    return capFacts(out);
}

function errorOf(tool: ToolView): string | null {
    const raw = tool.result?.error || tool.result?.stderr;
    if (!raw) return null;
    return String(raw).split("\n")[0]?.trim() || null;
}

function findTarget(tool: ToolView): string {
    const input = tool.input ?? {};
    const name = String(tool.name ?? "").toLowerCase();
    if (name === "ls" || name === "list_dir") return str(input.path) ?? humanName(tool.name);
    if (str(input.pattern)) return `“${String(input.pattern)}”`;
    if (str(input.path)) return String(input.path);
    return humanName(tool.name);
}

function findMeta(tool: ToolView): Fact[] {
    const out: Fact[] = [];
    const entries = Array.isArray(tool.entries) ? tool.entries : null;
    const files = (Array.isArray(tool.files) ? tool.files : []).map(String).filter(Boolean);
    if (entries) out.push(fact(tpNum("chat.meta.entries", entries.length)));
    else if (files.length || tool.meta?.files != null) {
        out.push(fact(tpNum("chat.meta.files", files.length || Number(tool.meta?.files ?? 0))));
    }
    if (tool.result?.truncated) out.push(fact(tr("chat.meta.truncated")));
    return capFacts(out);
}

const FIND_VERB: Record<string, string> = { ls: "find.list", list_dir: "find.list" };

export const searchSpec: ToolSpec = {
    id: "search",
    icon: KIND_ICON.search,
    verb: "search",
    target: targetOf,
    meta: searchMeta,
    error: errorOf,
    actions: () => [],
    Body: (props) => <SearchBody {...props} />,
};

export const findSpec: ToolSpec = {
    id: "find",
    icon: KIND_ICON.find,
    verb: (tool) => FIND_VERB[String(tool.name ?? "").toLowerCase()] ?? "find",
    target: findTarget,
    meta: findMeta,
    error: errorOf,
    actions: (tool) => {
        const files = (Array.isArray(tool.files) ? tool.files : []).map(String).filter(Boolean);
        if (!files.length) return [];
        return [
            {
                icon: Copy,
                labelKey: "chat.meta.copyPath",
                onAction: () => copyText(files.join("\n")),
            },
        ];
    },
    Body: (props) => <FindBody {...props} />,
};
