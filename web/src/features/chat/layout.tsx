import type { CSSProperties, ReactNode } from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export interface ChatLayoutProps {
    tree: ReactNode;
    stream: ReactNode;
    panel: ReactNode;
    treeOpen: boolean;
    panelOpen: boolean;
    treeCollapsed: boolean;
    treeWidth: number;
    panelWidth: number;
    onWidths: (widths: { treeWidth?: number; panelWidth?: number }) => void;
    onCloseDrawers: () => void;
    className?: string;
}

const TREE_MIN = 220;
const TREE_MAX = 460;
const PANEL_MIN = 260;
const PANEL_MAX = 520;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/**
 * Three-column chat grid with resizable dividers.
 * ≥840: tree | stream | panel; 600–839: tree | stream (panel drawer);
 * <600: single column with tree/panel drawers.
 */
export function ChatLayout({
    tree,
    stream,
    panel,
    treeOpen,
    panelOpen,
    treeCollapsed,
    treeWidth,
    panelWidth,
    onWidths,
    onCloseDrawers,
    className,
}: ChatLayoutProps) {
    const { t } = useTranslation();
    const startResize = useCallback(
        (which: "tree" | "panel", event: React.PointerEvent<HTMLDivElement>) => {
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = which === "tree" ? treeWidth : panelWidth;
            const move = (moveEvent: PointerEvent) => {
                const delta = which === "tree" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
                if (which === "tree") onWidths({ treeWidth: clamp(startWidth + delta, TREE_MIN, TREE_MAX) });
                else onWidths({ panelWidth: clamp(startWidth + delta, PANEL_MIN, PANEL_MAX) });
            };
            const up = () => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up, { once: true });
        },
        [onWidths, panelWidth, treeWidth],
    );

    const nudge = useCallback(
        (which: "tree" | "panel", delta: number) => {
            if (which === "tree") onWidths({ treeWidth: clamp(treeWidth + delta, TREE_MIN, TREE_MAX) });
            else onWidths({ panelWidth: clamp(panelWidth + delta, PANEL_MIN, PANEL_MAX) });
        },
        [onWidths, panelWidth, treeWidth],
    );

    const separator = (which: "tree" | "panel") => (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={which === "tree" ? t("chat.resizeTree") : t("chat.resizePanel")}
            tabIndex={0}
            className={cn("resize-handle", which === "tree" ? "resize-handle--tree" : "resize-handle--panel")}
            onPointerDown={(event) => startResize(which, event)}
            onDoubleClick={() => {
                if (which === "tree") onWidths({ treeWidth: 300 });
                else onWidths({ panelWidth: 340 });
            }}
            onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    nudge(which, -16);
                } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    nudge(which, 16);
                }
            }}
        />
    );

    const style = {
        "--tree-w": `${treeWidth}px`,
        "--panel-w": `${panelWidth}px`,
    } as CSSProperties;

    return (
        <div
            className={cn(
                "chat-page",
                treeOpen && "tree-open",
                panelOpen && "panel-open",
                treeCollapsed && "tree-collapsed",
                className,
            )}
            style={style}
        >
            <aside className="tree-pane">
                {tree}
            </aside>
            {separator("tree")}
            <section className="stream-pane">{stream}</section>
            {separator("panel")}
            <aside className="panel-pane">{panel}</aside>
            <button
                type="button"
                className="drawer-backdrop"
                aria-label={t("common.close")}
                tabIndex={treeOpen || panelOpen ? 0 : -1}
                onClick={onCloseDrawers}
            />
        </div>
    );
}
