import type { WorkspaceInfo } from "@protocol/types";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { cn } from "@/lib/utils";

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

function workspaceLabel(workspace: WorkspaceInfo): string {
    return workspace.name?.trim() || workspace.cwd || workspace.workspaceId;
}

/**
 * `.ws-switch` + `.ws-menu` (v0.1.1 Chat IA v3).
 *
 * The tree pane carries exactly ONE workspace, so the workspace picker is a
 * button with a menu instead of a native `<select>`: it shows the name, the
 * session count and a chevron that rotates while open, and each menu row is a
 * `menuitemradio` with a check mark for the current workspace.
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

    const active = workspaces.find((workspace) => workspace.workspaceId === activeWorkspaceId);
    const label = active ? workspaceLabel(active) : t("chat.noWorkspace");

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

    // Opening moves focus into the menu (the checked row), like a real picker.
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => {
            const target =
                menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]') ??
                menuRef.current?.querySelector<HTMLElement>("[data-workspace-id]");
            target?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
    }, [open]);

    function moveFocus(delta: 1 | -1 | "home" | "end") {
        const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-workspace-id]") ?? []);
        if (!items.length) return;
        const current = items.indexOf(document.activeElement as HTMLElement);
        let next = current;
        if (delta === "home") next = 0;
        else if (delta === "end") next = items.length - 1;
        else if (delta === 1) next = current < 0 ? 0 : (current + 1) % items.length;
        else next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
        items[next]?.focus({ preventScroll: true });
    }

    return (
        <div className={cn("ws-switch-row", className)} ref={rootRef}>
            <button
                ref={buttonRef}
                type="button"
                className="ws-switch"
                aria-haspopup="menu"
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
                role="menu"
                aria-label={t("chat.workspaceSwitch")}
                data-testid="ws-menu"
                hidden={!open}
                onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
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
                    if (event.key === "Escape" || event.key === "Tab") {
                        event.preventDefault();
                        event.stopPropagation();
                        onOpenChange(false);
                        requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
                    }
                }}
            >
                <div className="ws-menu__label">{t("chat.workspaceSwitch")}</div>
                {workspaces.map((workspace) => {
                    const checked = workspace.workspaceId === activeWorkspaceId;
                    const count = checked ? sessionCount : workspace.sessionCount;
                    return (
                        <button
                            key={workspace.workspaceId}
                            type="button"
                            role="menuitemradio"
                            aria-checked={checked}
                            className={cn("ws-menu__item", checked && "is-active")}
                            data-workspace-id={workspace.workspaceId}
                            title={workspace.cwd}
                            onClick={() => {
                                onOpenChange(false);
                                if (!checked) onSelect(workspace.workspaceId);
                                else requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }));
                            }}
                        >
                            <Icon name={checked ? "check" : "folder"} />
                            <span className="ws-menu__name truncate">{workspaceLabel(workspace)}</span>
                            <span className="ws-menu__count tabular">{count}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
