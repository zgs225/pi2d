import type { Batch, Entry, SessionState, Subagent, TodoItem } from "@protocol/types";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { ProjectedEntry } from "@/lib/entry-projection";
import { cn } from "@/lib/utils";
import { BatchBlock, EntryBlock, TodoBlock } from "./blocks";
import { findSubagent } from "./session-state";

/** Below this many items the DOM list is cheaper than virtualizer bookkeeping. */
export const VIRTUALIZE_THRESHOLD = 30;

export type StreamItem =
    | { kind: "entry"; key: string; entry: Entry; turnStart: boolean }
    | { kind: "todo"; key: string; todos: TodoItem[] }
    | { kind: "batch"; key: string; batch: Batch };

/**
 * Combine entry-backed messages with the session-level panels (todo, batches)
 * into one ordered stream. Historical `pi2-todo` checkpoints stay inline; when
 * history has none, the current todo list is appended as a live block.
 */
export function buildStreamItems(session: SessionState, entries: Entry[]): StreamItem[] {
    const items: StreamItem[] = [];
    let hasTodoEntry = false;
    entries.forEach((entry, index) => {
        const projectedTodo = (entry as ProjectedEntry).todo;
        if (projectedTodo) {
            hasTodoEntry = true;
            items.push({ kind: "todo", key: `todo:${entry.id}`, todos: projectedTodo.items });
            return;
        }
        const previous = index > 0 ? entries[index - 1] : undefined;
        const turnStart = index === 0 || entry.role === "user" || previous?.role === "user";
        items.push({ kind: "entry", key: `entry:${entry.id}`, entry, turnStart });
    });
    if (!hasTodoEntry && session.todos.length) {
        items.push({ kind: "todo", key: `todo:${session.sessionId}`, todos: session.todos });
    }
    for (const batch of session.batches) {
        items.push({ kind: "batch", key: `batch:${batch.batchId}`, batch });
    }
    return items;
}

export interface MessageStreamProps {
    session: SessionState;
    entries: Entry[];
    hasMore: boolean;
    loadingOlder: boolean;
    error: string | null;
    onLoadOlder: () => void;
    onRetry: () => void;
    onOpenSubagent: (subagent: Subagent) => void;
    className?: string;
}

export function MessageStream({
    session,
    entries,
    hasMore,
    loadingOlder,
    error,
    onLoadOlder,
    onRetry,
    onOpenSubagent,
    className,
}: MessageStreamProps) {
    const { t } = useTranslation();
    const items = buildStreamItems(session, entries);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [following, setFollowing] = useState(true);
    const followingRef = useRef(true);
    const [showTop, setShowTop] = useState(false);
    const pendingPrepend = useRef<number | null>(null);
    const loadRequested = useRef(false);
    const rafRef = useRef<number | null>(null);

    const setFollow = useCallback((value: boolean) => {
        followingRef.current = value;
        setFollowing(value);
    }, []);

    const virtualize = items.length >= VIRTUALIZE_THRESHOLD;
    const virtualizer = useVirtualizer({
        count: items.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 120,
        overscan: 8,
        getItemKey: (index) => items[index]?.key ?? index,
    });

    const scrollToBottom = useCallback((smooth = false) => {
        const element = scrollRef.current;
        if (!element) return;
        if (typeof element.scrollTo === "function") {
            element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
        } else {
            element.scrollTop = element.scrollHeight;
        }
    }, []);

    // Streaming keeps the DOM height changing; stay pinned while following.
    useLayoutEffect(() => {
        if (!followingRef.current) return;
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                if (followingRef.current) scrollToBottom(false);
            });
        });
    });

    useLayoutEffect(() => {
        const element = scrollRef.current;
        const previous = pendingPrepend.current;
        if (previous != null && element) {
            element.scrollTop += element.scrollHeight - previous;
            pendingPrepend.current = null;
        }
        if (!loadingOlder) loadRequested.current = false;
    }, [items.length, loadingOlder]);

    const handleScroll = useCallback(() => {
        const element = scrollRef.current;
        if (!element) return;
        const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
        setFollow(distance < 80);
        setShowTop(element.scrollTop > 400);
        if (element.scrollTop < 120 && hasMore && !loadingOlder && !loadRequested.current) {
            loadRequested.current = true;
            pendingPrepend.current = element.scrollHeight;
            onLoadOlder();
        }
    }, [hasMore, loadingOlder, onLoadOlder, setFollow]);

    const openByName = useCallback(
        (name: string) => {
            const subagent = findSubagent(session.subagents, (candidate) => candidate.name === name);
            if (subagent) onOpenSubagent(subagent);
        },
        [onOpenSubagent, session.subagents],
    );

    const canOpen = useCallback(
        (name: string) => Boolean(findSubagent(session.subagents, (candidate) => candidate.name === name)),
        [session.subagents],
    );

    const renderItem = useCallback(
        (item: StreamItem) => {
            switch (item.kind) {
                case "entry":
                    return <EntryBlock entry={item.entry} turnStart={item.turnStart} />;
                case "todo":
                    return <TodoBlock items={item.todos} />;
                case "batch":
                    return <BatchBlock batch={item.batch} onOpenSubagent={openByName} canOpen={canOpen} />;
            }
        },
        [canOpen, openByName],
    );

    const status = (
        <div className="stream-status-row">
            {loadingOlder ? (
                <span className="muted stream-status">
                    <Spinner /> {t("chat.loadingOlder")}
                </span>
            ) : hasMore ? (
                <button type="button" className="stream-older muted" onClick={onLoadOlder}>
                    {t("chat.loadOlder")}
                </button>
            ) : null}
            {error ? (
                <span className="stream-status stream-status--err">
                    <span>{t("chat.historyError")}</span>
                    <Button size="sm" onClick={onRetry}>
                        {t("common.retry")}
                    </Button>
                </span>
            ) : null}
        </div>
    );

    const body = items.length ? (
        virtualize ? (
            <div
                className="stream-list stream-list--virtual"
                style={{ height: `${virtualizer.getTotalSize()}px` }}
            >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                    const item = items[virtualItem.index];
                    if (!item) return null;
                    return (
                        <div
                            key={item.key}
                            data-index={virtualItem.index}
                            ref={(node) => {
                                virtualizer.measureElement(node);
                            }}
                            className={cn("stream-item", item.kind === "entry" && item.turnStart && "turn-start")}
                            style={{ transform: `translateY(${virtualItem.start}px)` }}
                        >
                            {renderItem(item)}
                        </div>
                    );
                })}
            </div>
        ) : (
            <div className="stream-list">
                {items.map((item) => (
                    <div
                        className={cn("stream-item", item.kind === "entry" && item.turnStart && "turn-start")}
                        key={item.key}
                    >
                        {renderItem(item)}
                    </div>
                ))}
                <div className="stream-end" />
            </div>
        )
    ) : (
        <Empty
            className="stream-empty"
            icon={<Icon name="chat" />}
            title={t("chat.emptyTitle")}
            description={t("chat.emptyText")}
        />
    );

    return (
        <div className={cn("stream-body", className)}>
            <div
                ref={scrollRef}
                className="stream-scroll"
                role="log"
                aria-live="polite"
                aria-label={t("chat.streamAria")}
                onScroll={handleScroll}
            >
                {status}
                {body}
            </div>
            <div className="stream-fab">
                <button
                    type="button"
                    className={cn("fab fab--top", showTop && "is-visible")}
                    title={t("chat.toTop")}
                    onClick={() => {
                        scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                        setFollow(false);
                        setShowTop(false);
                    }}
                >
                    {t("chat.top")}
                </button>
                <button
                    type="button"
                    className={cn("fab fab--latest", !following && "is-visible")}
                    title={t("chat.backToLatest")}
                    onClick={() => {
                        setFollow(true);
                        scrollToBottom(true);
                    }}
                >
                    {t("chat.latest")}
                </button>
            </div>
        </div>
    );
}
