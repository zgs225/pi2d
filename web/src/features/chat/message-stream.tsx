import type { Batch, Entry, QueueItem, SessionState, Subagent, TodoItem } from "@protocol/types";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import type { ProjectedEntry } from "@/lib/entry-projection";
import { cn } from "@/lib/utils";
import "@/styles/pages/chat-stream.css";
import { BatchBlock, EntryBlock, TodoBlock } from "./blocks";
import { QueuedMessage, type QueuedMessageActions } from "./queued-messages";
import { findSubagent } from "./session-state";

/** Below this many items the DOM list is cheaper than virtualizer bookkeeping. */
export const VIRTUALIZE_THRESHOLD = 30;

/** Synthesised id for the optimistic prompt the daemon has not echoed as an entry yet. */
export const SENDING_QUEUE_ID = "__sending__";

export type StreamItem =
    | { kind: "entry"; key: string; entry: Entry; turnStart: boolean }
    | { kind: "todo"; key: string; todos: TodoItem[] }
    | { kind: "batch"; key: string; batch: Batch }
    /**
     * A pending prompt. `session.queue` is not part of `entries` in pi2d (it is a
     * `queue_update` projection with no `ts`), so it is appended as one
     * synthetic entity per item — the stream is the only place a pending prompt
     * is shown as text. `sending` is the optimistic prompt, folded in as one
     * more queued variant.
     */
    | { kind: "queued"; key: string; item: QueueItem; sending?: boolean };

/**
 * Combine entry-backed messages with the session-level panels (todo, batches)
 * and the pending queue into one ordered stream. Historical `pi2-todo`
 * checkpoints stay inline; when history has none, the current todo list is
 * appended as a live block. Queued entities always go last, in queue order
 * (`queue_update` sends steering items before follow-ups), with the optimistic
 * `sending` prompt ahead of them.
 */
export function buildStreamItems(
    session: SessionState,
    entries: Entry[],
    sending?: { text: string } | null,
): StreamItem[] {
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
    if (sending) {
        items.push({
            kind: "queued",
            key: `queued:${SENDING_QUEUE_ID}`,
            item: { id: SENDING_QUEUE_ID, text: sending.text, steer: false },
            sending: true,
        });
    }
    for (const item of session.queue) {
        items.push({ kind: "queued", key: `queued:${item.id}`, item });
    }
    return items;
}

/** `queue.setSteer` is a session-wide mode: it is on when every queued item steers. */
export function steerAllOf(queue: QueueItem[]): boolean {
    return queue.length > 0 && queue.every((item) => item.steer);
}

export interface MessageStreamProps extends QueuedMessageActions {
    session: SessionState;
    entries: Entry[];
    hasMore: boolean;
    loadingOlder: boolean;
    error: string | null;
    /** Optimistic prompt already handed to the plugin (rendered as a queued variant). */
    sending?: { text: string } | null;
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
    sending = null,
    onLoadOlder,
    onRetry,
    onOpenSubagent,
    onRecallQueued,
    onRemoveQueued,
    onSetSteerAll,
    className,
}: MessageStreamProps) {
    const { t } = useTranslation();
    const allItems = buildStreamItems(session, entries, sending);
    // Queued entities always live at the tail, so they are rendered outside the
    // virtual window (absolute positioning) as a plain flex column.
    const items = allItems.filter((item) => item.kind !== "queued");
    const queued = allItems.filter((item) => item.kind === "queued");
    const steerAll = steerAllOf(session.queue);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const [following, setFollowing] = useState(true);
    const followingRef = useRef(true);
    const pendingPrepend = useRef<number | null>(null);
    const loadRequested = useRef(false);
    const rafRef = useRef<number | null>(null);
    /** Last observed `scrollTop`, so only an *upward* move counts as "stop following". */
    const lastTopRef = useRef<number | null>(null);
    /** Explicit scroll input (wheel / touch / keys / pointer drag) is the only way to stop following. */
    const userInputRef = useRef(false);
    const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    /** A smooth FAB scroll is in flight; instant pins would fight it. */
    const smoothUntilRef = useRef(0);

    const setFollow = useCallback((value: boolean) => {
        followingRef.current = value;
        setFollowing(value);
    }, []);

    /**
     * Mark an explicit user scroll. `following` must never be cleared by content
     * growth: the virtualizer measures real item heights after its estimated
     * pass, so `scrollHeight` jumps while the view sits still — treating that
     * as a user scroll froze the stream one or more screens above the newest
     * entry (the stream then looked stuck at an old message).
     */
    const markScrollInput = useCallback(() => {
        userInputRef.current = true;
        if (inputTimerRef.current) clearTimeout(inputTimerRef.current);
        inputTimerRef.current = setTimeout(() => {
            inputTimerRef.current = null;
            userInputRef.current = false;
        }, 500);
    }, []);

    useEffect(
        () => () => {
            if (inputTimerRef.current) clearTimeout(inputTimerRef.current);
        },
        [],
    );

    const virtualize = items.length >= VIRTUALIZE_THRESHOLD;
    const hasItems = items.length > 0;
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
        if (!followingRef.current || Date.now() < smoothUntilRef.current) return;
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = requestAnimationFrame(() => {
                rafRef.current = null;
                if (followingRef.current) scrollToBottom(false);
            });
        });
    });

    // A one-shot rAF after render lands short of the end: the virtualizer reports
    // real heights only after its estimated pass, and images/tool output load
    // later still. Observe the list so every real height change re-pins while
    // the user is following.
    useEffect(() => {
        const list = listRef.current;
        if (!list || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
            if (followingRef.current && Date.now() >= smoothUntilRef.current) scrollToBottom(false);
        });
        observer.observe(list);
        return () => observer.disconnect();
    }, [scrollToBottom, virtualize, hasItems]);

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
        const top = element.scrollTop;
        const previous = lastTopRef.current;
        lastTopRef.current = top;
        const distance = element.scrollHeight - top - element.clientHeight;
        // Re-arm at the bottom. Only explicit input that actually moved the view
        // *up* may stop following — growth-driven scroll positions (virtualizer
        // measurements, streamed text, late images) must never freeze the pin.
        if (distance < 80) setFollow(true);
        else if (userInputRef.current && (previous === null || top < previous - 2)) setFollow(false);
        if (top < 120 && hasMore && !loadingOlder && !loadRequested.current) {
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
                case "queued":
                    return (
                        <QueuedMessage
                            item={item.item}
                            sending={item.sending}
                            steerAll={steerAll}
                            onRecallQueued={onRecallQueued}
                            onRemoveQueued={onRemoveQueued}
                            onSetSteerAll={onSetSteerAll}
                        />
                    );
            }
        },
        [canOpen, onRecallQueued, onRemoveQueued, onSetSteerAll, openByName, steerAll],
    );

    const itemClassName = useCallback(
        (item: StreamItem) =>
            cn(
                "stream-item",
                // A turn spans its user message + everything until the next user
                // message: 28px before it, 18px inside it.
                item.kind === "entry" && item.turnStart && "turn-start",
                item.kind === "queued" && "user-start stream-item--queued",
                item.kind === "entry" && item.entry.role === "user" && "user-start",
            ),
        [],
    );

    const status = (
        <div className="stream-status-row">
            {loadingOlder ? (
                <span className="muted stream-status">
                    <Spinner /> {t("chat.loadingOlder")}
                </span>
            ) : hasMore ? (
                <button
                    type="button"
                    className="stream-older muted"
                    data-testid="load-older"
                    onClick={onLoadOlder}
                >
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

    const body = items.length || queued.length ? (
        <>
            {items.length ? (
                virtualize ? (
                    <div
                        ref={listRef}
                        className="stream-list stream-inner stream-list--virtual"
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
                                    className={itemClassName(item)}
                                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                                >
                                    {renderItem(item)}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div ref={listRef} className="stream-list stream-inner">
                        {items.map((item) => (
                            <div className={itemClassName(item)} key={item.key}>
                                {renderItem(item)}
                            </div>
                        ))}
                        {queued.length ? null : <div className="stream-end" />}
                    </div>
                )
            ) : null}
            {queued.length ? (
                <div className="stream-list stream-inner stream-list--queued" data-testid="stream-queued">
                    {queued.map((item) => (
                        <div className={itemClassName(item)} key={item.key}>
                            {renderItem(item)}
                        </div>
                    ))}
                    <div className="stream-end" />
                </div>
            ) : null}
        </>
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
                onWheel={markScrollInput}
                onTouchMove={markScrollInput}
                onKeyDown={markScrollInput}
                onPointerDown={markScrollInput}
            >
                {status}
                {body}
            </div>
            {/* Exactly one floating button: back to latest. Top is End/Home. */}
            <div className="stream-fab">
                <button
                    type="button"
                    className={cn("fab fab--latest", !following && "is-visible")}
                    aria-label={t("chat.backToLatest")}
                    title={t("chat.backToLatest")}
                    onClick={() => {
                        setFollow(true);
                        smoothUntilRef.current = Date.now() + 700;
                        scrollToBottom(true);
                    }}
                >
                    <Icon name="chevron-down" size={14} />
                    <span>{t("chat.latest")}</span>
                </button>
            </div>
        </div>
    );
}
