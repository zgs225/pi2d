import type { WorkspaceInfo } from "@protocol/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { readWorkspaceRecency, searchWorkspaces, sortByRecentUse, workspaceLabel } from "./workspace-order";

export interface WorkspaceSwitchProps {
    /** Every workspace the daemon knows about (the menu lists all of them). */
    workspaces: WorkspaceInfo[];
    activeWorkspaceId?: string | null;
    /** Session rows in the *active* workspace (live count beats the disk count). */
    sessionCount: number;
    /** Menu visibility — owned by the store so the page-wide Esc chain can close it. */
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (workspaceId: string) => void;
    className?: string;
}

/**
 * `.ws-switch` + `.ws-menu` (v0.1.1 Chat IA v3).
 *
 * The tree pane carries exactly ONE workspace, so the workspace picker is a
 * button with a popover instead of a native `<select>`: it shows the name, the
 * session count and a chevron that rotates while open.
 *
 * The menu is a filterable listbox: rows are ordered by **recent use** (see
 * `./workspace-order`), the search field at the top filters by name, alias, path
 * or id, and each row is an `option` with the current workspace selected.
 */
export function WorkspaceSwitch({
    workspaces,
    activeWorkspaceId,
    sessionCount,
    open,
    onOpenChange,
    onSelect,
    className,
}: WorkspaceSwitchProps) {
    const { t } = useTranslation();
    const rootRef = useRef<HTMLDivElement | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);

    const [query, setQuery] = useState("");
    // Snapshot of "which workspace did I open last" taken when the menu opens,
    // so a fresh pick is reflected the next time the user looks.
    const [recency, setRecency] = useState(() => readWorkspaceRecency());

    const active = workspaces.find((workspace) => workspace.workspaceId === activeWorkspaceId);
    const label = active ? workspaceLabel(active) : t("chat.noWorkspace");

    const ordered = useMemo(() => sortByRecentUse(workspaces, recency), [workspaces, recency]);
    const rows = useMemo(() => searchWorkspaces(ordered, query), [ordered, query]);
    const filtering = query.trim().length > 0;

    // Click outside closes the menu. `composedPath()` (not `contains`) because a
    // menu item selection re-renders and detaches the clicked node first.
    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: Event) => {
            const path = typeof event.composedPath === "function" ? event.composedPath() : [];
            if (rootRef.current && path.includes(rootRef.current)) return;
            onOpenChange(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [open, onOpenChange]);

    // Opening: refresh the recency snapshot, clear the last query, focus the
    // search field (there is always something to type in a searchable picker).
    useEffect(() => {
        if (!open) {
            setQuery("");
            return;
        }
        setRecency(readWorkspaceRecency());
        const frame = requestAnimationFrame(() => {
            inputRef.current?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
    }, [open]);

    function close(refocus = true) {
        onOpenChange(false);
        if (!refocus) return;
        requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
    }

    function options(): HTMLElement[] {
        return Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-workspace-id]") ?? []);
    }

    function moveFocus(move: 1 | -1 | "home" | "end") {
        const items = options();
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLElement);
        let next = current;
        if (move === "home") next = 0;
        else if (move === "end") next = items.length - 1;
        else if (move === 1) next = current < 0 ? 0 : (current + 1) % items.length;
        else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
    }

    function choose(workspaceId: string) {
        onOpenChange(false);
        onSelect(workspaceId);
    }

    return (
        <div className={cn("ws-switch-row", className)} ref={rootRef}>
            <button
                ref={buttonRef}
                type="button"
                className="ws-switch"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-label={t("chat.workspaceSwitchAria", { name: label })}
                title={active?.cwd ?? label}
                data-testid="ws-switch"
                disabled={!workspaces.length}
                onClick={() => onOpenChange(!open)}
            >
                <Icon name="folder" />
                <span className="ws-switch__name truncate">{label}</span>
                <span className="ws-switch__count tabular">{sessionCount}</span>
                <span className="ws-switch__caret">
                    <Icon name="chevron-down" />
                </span>
            </button>
            <div
                ref={menuRef}
                className="ws-menu"
                data-testid="ws-menu"
                hidden={!open}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
                        // Arrow keys walk either the search field or the rows.
                        event.preventDefault();
                        moveFocus(
                            event.key === "ArrowDown"
                                ? 1
                                : event.key === "ArrowUp"
                                  ? -1
                                  : event.key === "Home"
                                    ? "home"
                                    : "end",
                        );
                        return;
                    }
                    if (
                        event.key === "Enter" &&
                        (event.target === inputRef.current || document.activeElement === inputRef.current)
                    ) {
                        // Enter in the search field takes the best (first) match.
                        const first = rows[0];
                        if (!first) return;
                        event.preventDefault();
                        choose(first.workspaceId);
                        return;
                    }
                    if (event.key === "Escape" || event.key === "Tab") {
                        event.preventDefault();
                        event.stopPropagation();
                        close();
                    }
                }}
            >
                <div className="ws-menu__search">
                    <Icon name="search" />
                    <input
                        ref={inputRef}
                        type="search"
                        className="ws-menu__input"
                        value={query}
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={t("chat.workspaceSearchAria")}
                        aria-controls="ws-menu-list"
                        placeholder={t("chat.workspaceSearch")}
                        data-testid="ws-menu-search"
                        onChange={(event) => setQuery(event.target.value)}
                    />
                    {query ? (
                        <button
                            type="button"
                            className="ws-menu__clear"
                            aria-label={t("chat.workspaceSearchClear")}
                            onClick={() => {
                                setQuery("");
                                inputRef.current?.focus({ preventScroll: true });
                            }}
                        >
                            <Icon name="x" />
                        </button>
                    ) : null}
                </div>
                <div
                    ref={listRef}
                    id="ws-menu-list"
                    className="ws-menu__list"
                    role="listbox"
                    aria-label={t("chat.workspaceSwitch")}
                >
                    {rows.map((workspace) => {
                        const checked = workspace.workspaceId === activeWorkspaceId;
                        const count = checked ? sessionCount : workspace.sessionCount;
                        return (
                            <button
                                key={workspace.workspaceId}
                                type="button"
                                role="option"
                                aria-selected={checked}
                                className={cn("ws-menu__item", checked && "is-active")}
                                data-workspace-id={workspace.workspaceId}
                                title={workspace.cwd}
                                tabIndex={-1}
                                onClick={() => {
                                    if (checked) {
                                        close();
                                        return;
                                    }
                                    choose(workspace.workspaceId);
                                }}
                            >
                                <Icon name={checked ? "check" : "folder"} />
                                <span className="ws-menu__name truncate">{workspaceLabel(workspace)}</span>
                                <span className="ws-menu__count tabular">{count}</span>
                            </button>
                        );
                    })}
                    {rows.length ? null : (
                        <div className="ws-menu__empty" data-testid="ws-menu-empty">
                            {filtering
                                ? t("chat.workspaceSearchNoMatch", { query: query.trim() })
                                : t("chat.noWorkspace")}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
