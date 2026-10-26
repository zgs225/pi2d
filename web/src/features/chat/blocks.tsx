import type { Batch, Entry, TodoItem } from "@protocol/types";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import "@/styles/pages/chat-msg.css";
import { formatClock } from "./format";
import { fromPi2Block, ToolRow } from "./tools";
import type { ToolCtx } from "./tools";

/**
 * `notice` entries report on a subagent; the projection may carry its name so the
 * meta row can link into the subagent view (prototype `.who--agent.sub-report__link`).
 */
type NoticeEntry = Entry & { subagentName?: string; subagent?: string | { name?: string } };

function noticeSubagentName(entry: Entry): string | undefined {
    const notice = entry as NoticeEntry;
    if (notice.subagentName) return notice.subagentName;
    const subagent = notice.subagent;
    if (typeof subagent === "string") return subagent || undefined;
    if (subagent && typeof subagent === "object") return subagent.name || undefined;
    return undefined;
}

export interface EntryBlockProps {
    entry: Entry;
    turnStart?: boolean;
    /** `false` on same-turn follow-ups: only the turn's first message repeats the meta row. */
    showMeta?: boolean;
    /** Opens the subagent view from a `notice` (sub-report) meta link. */
    onOpenSubagent?: (name: string) => void;
}

function MessageMeta({ entry, onOpenSubagent }: { entry: Entry; onOpenSubagent?: (name: string) => void }) {
    const { t } = useTranslation();
    const user = entry.role === "user";
    const notice = entry.role === "notice";
    const subagent = notice ? noticeSubagentName(entry) : undefined;
    const label = user ? t("chat.you") : notice ? t("chat.subReport") : "pi2";
    return (
        <div className="msg__meta">
            {subagent && onOpenSubagent ? (
                <button
                    type="button"
                    className="who who--agent sub-report__link"
                    title={t("chat.viewSubagent", { name: subagent })}
                    onClick={() => onOpenSubagent(subagent)}
                >
                    <Icon name="branch" />
                    {label}
                </button>
            ) : (
                <span className={cn("who", user ? "who--user" : "who--agent")}>
                    {notice ? <Icon name="branch" /> : null}
                    {label}
                </span>
            )}
            {user ? (
                <RelativeTime ts={entry.ts} className="muted msg__time" />
            ) : (
                <span className="muted msg__time">{formatClock(entry.ts)}</span>
            )}
        </div>
    );
}

function ThinkingBlock({ text }: { text: string }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    return (
        <button
            type="button"
            className={cn("thinking", open && "open")}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
        >
            <span className="thinking__tag">
                <Icon name="clock" />
                {t("chat.thinking")}
            </span>
            <span className="thinking__text">{text}</span>
        </button>
    );
}

function TodoRow({ item }: { item: TodoItem }) {
    const completed = item.status === "completed";
    const active = item.status === "in_progress";
    return (
        <div className={cn("todo__row", active && "is-active", completed && "is-done")}>
            <span
                className={cn(
                    "todo__ico",
                    completed && "todo__ico--done",
                    active && "todo__ico--progress",
                    !completed && !active && "todo__ico--pending",
                )}
                aria-hidden="true"
            >
                {completed ? "✓" : active ? "◐" : "○"}
            </span>
            <span className="todo__txt">
                <span className="todo__content">{item.content}</span>
                {active && item.activeForm ? <span className="todo__active">{item.activeForm}</span> : null}
            </span>
        </div>
    );
}

export interface TodoListProps {
    items: TodoItem[];
    limit?: number;
    idPrefix: string;
}

export function TodoList({ items, limit = 5, idPrefix }: TodoListProps) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const shown = expanded ? items : items.slice(0, limit);
    return (
        <div className="todo__list">
            {shown.map((item, index) => (
                <TodoRow key={`${idPrefix}-${index}`} item={item} />
            ))}
            {items.length > limit ? (
                <button
                    type="button"
                    className="btn btn--sm btn--ghost todo__more"
                    onClick={() => setExpanded((value) => !value)}
                >
                    {expanded ? t("chat.collapse") : t("chat.moreItems", { n: items.length - limit })}
                </button>
            ) : null}
        </div>
    );
}

export function TodoBlock({ items }: { items: TodoItem[] }) {
    const { t } = useTranslation();
    const completed = items.filter((item) => item.status === "completed").length;
    return (
        <div className="todo card">
            <div className="todo__head">
                <Icon name="todo" />
                <span>{`${t("chat.tabTodo")} · ${completed}/${items.length}`}</span>
                <div className="spacer" />
                <span className="muted todo__readonly">{t("common.readonly")}</span>
            </div>
            <Progress value={completed} max={items.length || 1} />
            <TodoList items={items} idPrefix="stream-todo" />
        </div>
    );
}

const BATCH_GLYPH: Record<string, [string, string]> = {
    ok: ["✓", "batch__ico--ok"],
    failed: ["✗", "batch__ico--err"],
    cancelled: ["⊘", "batch__ico--muted"],
    running: ["◐", "batch__ico--warn"],
    spawning: ["◐", "batch__ico--warn"],
    queued: ["·", "batch__ico--muted"],
};

function batchSummary(batch: Batch) {
    const items = batch.items ?? [];
    if (batch.summary) return batch.summary;
    const counts = { total: items.length, done: 0, ok: 0, failed: 0, cancelled: 0, running: 0 };
    for (const item of items) {
        if (item.status === "ok") {
            counts.ok += 1;
            counts.done += 1;
        } else if (item.status === "failed") {
            counts.failed += 1;
            counts.done += 1;
        } else if (item.status === "cancelled") {
            counts.cancelled += 1;
            counts.done += 1;
        } else {
            counts.running += 1;
        }
    }
    return counts;
}

export interface BatchBlockProps {
    batch: Batch;
    onOpenSubagent?: (name: string) => void;
    canOpen?: (name: string) => boolean;
}

export function BatchBlock({ batch, onOpenSubagent, canOpen }: BatchBlockProps) {
    const { t } = useTranslation();
    const summary = batchSummary(batch);
    const items = batch.items ?? [];
    return (
        <div className="batch card">
            <div className="batch__head row">
                <Icon name="branch" />
                <span>{t("chat.batchDispatch", { done: summary.done, total: summary.total })}</span>
                <div className="spacer" />
                {summary.running ? <Badge tone="info">{t("chat.batchRunning", { n: summary.running })}</Badge> : null}
                {summary.failed ? <Badge tone="err">{t("chat.batchFailed", { n: summary.failed })}</Badge> : null}
            </div>
            <div className="batch__list">
                {items.map((item, index) => {
                    const name = item.name ?? item.ref ?? String(index);
                    const target = Boolean(canOpen?.(name));
                    const [glyph, cls] = BATCH_GLYPH[item.status] ?? ["·", "batch__ico--muted"];
                    return (
                        <div
                            key={`${item.ref}-${index}`}
                            className={cn("batch__row", target && "is-link")}
                            role={target ? "button" : undefined}
                            tabIndex={target ? 0 : undefined}
                            title={target ? t("chat.viewSubagent", { name }) : undefined}
                            onClick={() => {
                                if (target) onOpenSubagent?.(name);
                            }}
                            onKeyDown={(event) => {
                                if (target && (event.key === "Enter" || event.key === " ")) {
                                    event.preventDefault();
                                    onOpenSubagent?.(name);
                                }
                            }}
                        >
                            <span className="batch__tree muted">├─</span>
                            <span className={cn("batch__ico", cls)}>{glyph}</span>
                            <span className="batch__name truncate">{name}</span>
                            {item.error ? <span className="muted truncate">{item.error}</span> : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function ErrorBlock({ text }: { text: string }) {
    const { t } = useTranslation();
    return (
        <div className="msg__error">
            <div className="msg__error-meta">
                <span className="who who--err">
                    <Icon name="alert" />
                    {t("chat.error")}
                </span>
            </div>
            <div className="msg__text">{text}</div>
        </div>
    );
}

export function EntryBlock({ entry, turnStart, showMeta, onOpenSubagent }: EntryBlockProps) {
    const lastTextIndex = entry.blocks.reduce(
        (last, block, index) => (block.type === "text" ? index : last),
        -1,
    );
    // `user` / `notice` are standalone messages and always carry meta; `system` is a
    // fallback row (text only, no invented rail); only `assistant` collapses its meta
    // when it merely continues the current turn (`renderMessage(m, turnStart, showMeta)`).
    const withMeta =
        entry.role === "system" ? false : entry.role === "assistant" ? (showMeta ?? turnStart ?? true) : true;
    const toolCtx: ToolCtx = onOpenSubagent ? { onOpenSubagent } : {};
    return (
        <article
            className={cn("msg", `msg--${entry.role}`, turnStart && "turn-start")}
            data-entry-id={entry.id}
            data-role={entry.role}
        >
            {withMeta ? <MessageMeta entry={entry} onOpenSubagent={onOpenSubagent} /> : null}
            {entry.blocks.map((block, index) => {
                if (block.type === "text") {
                    return (
                        <div
                            key={`${entry.id}-t-${index}`}
                            className={cn("msg__text", !entry.done && index === lastTextIndex && "streaming")}
                        >
                            {block.text}
                        </div>
                    );
                }
                if (block.type === "thinking") {
                    return <ThinkingBlock key={`${entry.id}-k-${index}`} text={block.text} />;
                }
                if (block.type === "tool") {
                    // One tool call = one family row (tools/index.ts exit contract).
                    return (
                        <ToolRow
                            key={`${entry.id}-x-${index}`}
                            tool={fromPi2Block(block, entry.id, { ts: entry.ts })}
                            ctx={toolCtx}
                        />
                    );
                }
                return <ErrorBlock key={`${entry.id}-e-${index}`} text={block.text} />;
            })}
            {entry.images?.length ? (
                <div className="msg__images">
                    {entry.images.map((image, index) => (
                        <img
                            key={`${entry.id}-img-${index}`}
                            className="msg__img"
                            src={`data:${image.mimeType};base64,${image.data}`}
                            alt=""
                        />
                    ))}
                </div>
            ) : null}
        </article>
    );
}
