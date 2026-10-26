import { useNavigate } from "@tanstack/react-router";
import { useTheme } from "next-themes";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/components/icons";
import { NAV } from "@/components/shared/nav-list";
import { cn } from "@/lib/utils";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspacesStore } from "@/stores/workspaces";

interface PaletteItem {
    id: string;
    group: string;
    icon: IconName;
    label: string;
    hint?: string;
    keywords?: string;
    href?: string;
    action?: () => void;
}

export interface CommandPaletteProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

/**
 * ⌘K / Ctrl-K command palette (CHG-08). Groups: pages, connection, sessions,
 * workspaces, theme. The input autofocuses, ↑↓/Home/End move `aria-selected`,
 * Enter runs, Escape closes, Tab stays inside the dialog, and closing returns
 * focus to whatever had it before the palette opened.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { resolvedTheme, setTheme } = useTheme();
    const workspaces = useWorkspacesStore((state) => state.items);
    const byWorkspace = useSessionsStore((state) => state.byWorkspace);

    const [query, setQuery] = useState("");
    const [index, setIndex] = useState(0);
    const [visible, setVisible] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);

    const groupPages = t("shell.palettePages");
    const groupConnection = t("shell.connection");
    const groupSessions = t("shell.paletteSessions");
    const groupWorkspaces = t("shell.paletteWorkspaces");
    const groupActions = t("shell.paletteActions");

    const all: PaletteItem[] = [];
    for (const entry of NAV) {
        all.push({
            id: `page-${entry.key}`,
            group: groupPages,
            icon: entry.icon,
            label: t(entry.labelKey),
            keywords: `${entry.key} ${entry.to}`,
            href: entry.to,
        });
    }
    all.push({
        id: "page-connect",
        group: groupConnection,
        icon: "plug",
        label: t("shell.openConnection"),
        keywords: "connect pairing pair",
        href: "/connect",
    });
    for (const session of Object.values(byWorkspace).flat()) {
        all.push({
            id: `session-${session.sessionId}`,
            group: groupSessions,
            icon: "chat",
            label: session.name ?? session.sessionId,
            hint: t(`state.${session.status}`),
            keywords: `${session.sessionId} ${session.model?.id ?? ""} ${session.cwd}`,
            href: `/chat/${encodeURIComponent(session.sessionId)}`,
        });
    }
    for (const workspace of workspaces) {
        const name = workspace.name || workspace.cwd;
        all.push({
            id: `workspace-${workspace.workspaceId}`,
            group: groupWorkspaces,
            icon: "folder",
            label: name,
            hint: workspace.cwd,
            keywords: `${workspace.name} ${workspace.cwd}`,
            href: `/chat?workspace=${encodeURIComponent(workspace.workspaceId)}`,
        });
    }
    all.push({
        id: "action-theme",
        group: groupActions,
        icon: resolvedTheme === "dark" ? "sun" : "moon",
        label: t("shell.toggleTheme"),
        keywords: "theme dark light appearance",
        action: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
    });

    const needle = query.trim().toLowerCase();
    const filtered = needle
        ? all.filter((item) =>
              `${item.label} ${item.keywords ?? ""} ${item.hint ?? ""}`.toLowerCase().includes(needle),
          )
        : all;

    // Open: remember focus, fade in on the next frame, focus the input.
    // Close/unmount: hand focus back to the previous element.
    useEffect(() => {
        if (!open) {
            setVisible(false);
            return;
        }
        previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const frame = requestAnimationFrame(() => {
            setVisible(true);
            inputRef.current?.focus();
        });
        return () => {
            cancelAnimationFrame(frame);
            const target = previousFocusRef.current;
            previousFocusRef.current = null;
            target?.focus();
        };
    }, [open]);

    useEffect(() => {
        if (!open) {
            setQuery("");
            setIndex(0);
        }
    }, [open]);

    // Keep the selected row scrolled into view.
    useEffect(() => {
        if (!open) return;
        listRef.current
            ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
            ?.scrollIntoView({ block: "nearest" });
    }, [index, open, needle]);

    if (!open) return null;

    const selected = filtered[Math.min(index, Math.max(0, filtered.length - 1))];

    function run(item: PaletteItem) {
        onOpenChange(false);
        if (item.href) void navigate({ href: item.href });
        else item.action?.();
    }

    function move(delta: number) {
        if (!filtered.length) return;
        setIndex((current) => (current + delta + filtered.length) % filtered.length);
    }

    function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        switch (event.key) {
            case "Escape":
                event.preventDefault();
                event.stopPropagation();
                onOpenChange(false);
                break;
            case "ArrowDown":
                event.preventDefault();
                move(1);
                break;
            case "ArrowUp":
                event.preventDefault();
                move(-1);
                break;
            case "Home":
                event.preventDefault();
                setIndex(0);
                break;
            case "End":
                event.preventDefault();
                setIndex(Math.max(0, filtered.length - 1));
                break;
            case "Enter":
                event.preventDefault();
                if (selected) run(selected);
                break;
            case "Tab": {
                // aria-modal dialog: keep Tab inside the palette (input + rows).
                const options = Array.from(
                    panelRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
                );
                const focusables = inputRef.current ? [inputRef.current, ...options] : options;
                if (!focusables.length) break;
                const first = focusables[0]!;
                const last = focusables[focusables.length - 1]!;
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
                break;
            }
            default:
                break;
        }
    }

    return (
        <div
            className={cn("palette-backdrop", visible && "open")}
            onClick={(event) => {
                if (event.target === event.currentTarget) onOpenChange(false);
            }}
        >
            <div
                ref={panelRef}
                className="palette"
                role="dialog"
                aria-modal="true"
                aria-label={t("shell.search")}
                onKeyDown={onKeyDown}
            >
                <div className="palette__input">
                    <Icon name="search" />
                    <input
                        ref={inputRef}
                        type="text"
                        role="combobox"
                        aria-expanded="true"
                        aria-controls="palette-list"
                        aria-autocomplete="list"
                        aria-label={t("shell.search")}
                        placeholder={t("shell.search")}
                        autoComplete="off"
                        spellCheck={false}
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setIndex(0);
                        }}
                    />
                    <span className="kbd">esc</span>
                </div>
                <div ref={listRef} className="palette__list" id="palette-list" role="listbox" aria-label={t("shell.search")}>
                    {filtered.length === 0 ? (
                        <div className="palette__empty">{t("shell.paletteEmpty")}</div>
                    ) : (
                        filtered.map((item, position) => (
                            <Fragment key={item.id}>
                                {item.group !== filtered[position - 1]?.group ? (
                                    <div className="palette__group">{item.group}</div>
                                ) : null}
                                <button
                                    type="button"
                                    role="option"
                                    aria-selected={position === index}
                                    className="palette__item"
                                    onMouseEnter={() => setIndex(position)}
                                    onClick={() => run(item)}
                                >
                                    <Icon name={item.icon} />
                                    <span className="grow truncate">{item.label}</span>
                                    {item.hint ? <span className="palette__hint truncate">{item.hint}</span> : null}
                                </button>
                            </Fragment>
                        ))
                    )}
                </div>
                <div className="palette__foot">
                    <span>
                        <span className="kbd">↑↓</span>
                        {t("shell.paletteMove")}
                    </span>
                    <span>
                        <span className="kbd">↵</span>
                        {t("shell.paletteOpen")}
                    </span>
                    <span>
                        <span className="kbd">esc</span>
                        {t("shell.paletteClose")}
                    </span>
                </div>
            </div>
        </div>
    );
}
