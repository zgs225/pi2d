import type { SessionState } from "@protocol/types";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/components/icons";
import { cn } from "@/lib/utils";

/**
 * Session row actions popover (v0.1.1 Chat IA v3, CHG-2026-10-26-13 + -17).
 *
 * The popover is portalled to `document.body` and positioned `fixed`, so the
 * session tree's scroll container (`.pane-scroll`, `overflow-y: auto`) can
 * never clip it. It is right-aligned to the row's `…` trigger and flips above
 * the row when there is not enough room below.
 *
 * Menu contents are exactly the prototype's five actions:
 * `subagent filter` label + `活跃/全部` radios + `派发子代理` + `重命名` +
 * `关闭进程` (danger). Destructive actions are *not* executed here: the parent
 * routes them through its confirm dialog (second confirmation), matching
 * `confirmDialog(..., { danger: true })` in the prototype.
 */
export interface SessionRowMenuProps {
    session: SessionState;
    /** The row's `…` button: the popover aligns to it and gets focus back on Esc. */
    anchor: HTMLElement;
    /** IA lens state, drives the `menuitemradio` checks. */
    activeOnly: boolean;
    /** `restoreFocus` is true only for Esc/Tab (focus returns to the `…` button). */
    onClose: (restoreFocus: boolean) => void;
    onToggleActiveOnly: () => void;
    onDispatchSubagent: (sessionId: string) => void;
    onRenameSession: (session: SessionState) => void;
    /** The parent owns the danger confirmation for this one. */
    onCloseSession: (session: SessionState) => void;
}

/** Fallback metrics before the popover has been painted (jsdom reports 0). */
const FALLBACK_WIDTH = 184;
const FALLBACK_HEIGHT = 120;
const GAP = 6;
const MARGIN = 8;
const ITEM = "[data-menu-item]";

interface MenuItemProps {
    /** Stable hook for tests (`data-menu-action`), independent of the locale. */
    action: string;
    icon: IconName;
    label: string;
    onClick: () => void;
    danger?: boolean;
    /** `null` renders a plain `menuitem`; a boolean renders a `menuitemradio`. */
    checked?: boolean | null;
}

function MenuItem({ action, icon, label, onClick, danger = false, checked = null }: MenuItemProps) {
    const radio = checked !== null;
    return (
        <button
            type="button"
            className={cn("menu__item", danger && "is-danger", checked && "is-active")}
            role={radio ? "menuitemradio" : "menuitem"}
            aria-checked={radio ? checked : undefined}
            data-menu-item=""
            data-menu-action={action}
            onClick={onClick}
        >
            <Icon name={icon} />
            <span className="grow truncate">{label}</span>
            {checked ? (
                <span className="menu__check">
                    <Icon name="check" />
                </span>
            ) : null}
        </button>
    );
}

export function SessionRowMenu({
    session,
    anchor,
    activeOnly,
    onClose,
    onToggleActiveOnly,
    onDispatchSubagent,
    onRenameSession,
    onCloseSession,
}: SessionRowMenuProps) {
    const { t } = useTranslation();
    const menuRef = useRef<HTMLDivElement | null>(null);

    // Latest `onClose` for the document-level listeners (they subscribe once).
    const closeRef = useRef(onClose);
    useEffect(() => {
        closeRef.current = onClose;
    }, [onClose]);

    /** Right-align to the trigger, flip up when the space below is short. */
    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!menu) return;
        const rect = anchor.getBoundingClientRect();
        const width = menu.offsetWidth || FALLBACK_WIDTH;
        const height = menu.offsetHeight || FALLBACK_HEIGHT;
        const left = Math.max(MARGIN, Math.min(rect.right - width, window.innerWidth - width - MARGIN));
        let top = rect.bottom + GAP;
        if (top + height > window.innerHeight - MARGIN) top = Math.max(MARGIN, rect.top - height - GAP);
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;
    }, [anchor]);

    // Opening moves focus to the first item.
    useLayoutEffect(() => {
        menuRef.current?.querySelector<HTMLElement>(ITEM)?.focus({ preventScroll: true });
    }, []);

    // Outside click, tree/window scroll and window resize all close it. Clicks are
    // resolved with `composedPath()` because selecting an item re-renders the tree
    // and can detach the node that was actually pressed.
    useEffect(() => {
        const close = (): void => closeRef.current(false);
        const onPointerDown = (event: Event): void => {
            const path = typeof event.composedPath === "function" ? event.composedPath() : [];
            const menu = menuRef.current;
            if (menu && path.includes(menu)) return;
            // The trigger toggles the popover itself; let its onClick decide.
            if (path.includes(anchor)) return;
            close();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            window.removeEventListener("scroll", close, true);
            window.removeEventListener("resize", close);
        };
    }, [anchor]);

    const run = useCallback(
        (action: () => void) => {
            // Close first: the action may re-render or unmount the row.
            closeRef.current(false);
            action();
        },
        [],
    );

    const moveFocus = useCallback((key: string) => {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEM) ?? []);
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLElement);
        let next = current;
        if (key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
        else if (key === "ArrowUp") next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        else if (key === "Home") next = 0;
        else next = items.length - 1;
        items[next]?.focus({ preventScroll: true });
    }, []);

    return createPortal(
        <div
            ref={menuRef}
            className="menu tree-pop"
            role="menu"
            aria-label={t("common.manage")}
            data-testid="session-row-menu"
            data-menu-session={session.sessionId}
            onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Tab") {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose(true);
                    return;
                }
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                moveFocus(event.key);
            }}
        >
            <div className="menu__label">{t("chat.subagentFilter")}</div>
            <MenuItem
                action="active-only"
                icon="eye"
                label={t("chat.showActiveOnly")}
                checked={activeOnly}
                onClick={() => run(() => (activeOnly ? undefined : onToggleActiveOnly()))}
            />
            <MenuItem
                action="show-all"
                icon="todo"
                label={t("chat.showAllSubs")}
                checked={!activeOnly}
                onClick={() => run(() => (activeOnly ? onToggleActiveOnly() : undefined))}
            />
            <div className="menu__sep" />
            <MenuItem
                action="dispatch"
                icon="branch"
                label={t("chat.dispatchHere")}
                onClick={() => run(() => onDispatchSubagent(session.sessionId))}
            />
            <MenuItem action="rename" icon="edit" label={t("chat.rename")} onClick={() => run(() => onRenameSession(session))} />
            <div className="menu__sep" />
            <MenuItem
                action="close"
                icon="x"
                label={t("chat.closeProcess")}
                danger
                onClick={() => run(() => onCloseSession(session))}
            />
        </div>,
        document.body,
    );
}
