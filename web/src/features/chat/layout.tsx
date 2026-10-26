import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

export interface ChatLayoutProps {
    tree: ReactNode;
    stream: ReactNode;
    /** Narrow-viewport tree drawer (≥1000px the tree is a fixed column). */
    treeOpen: boolean;
    onCloseDrawers: () => void;
    className?: string;
}

/**
 * Chat shell, v0.1.1 Chat IA v3: **two columns, no right panel**
 * (the Todo/Tasks surfaces are the anchored `SessionTray`, not a third pane).
 *
 * - ≥1100: tree 280px + stream
 * - 1000–1099: tree 240px + stream
 * - <1000: single column, the tree becomes a left drawer (`.tree-open`)
 *
 * The tree is fixed and non-collapsible on desktop: there is no rail, no
 * resize handle and no keyboard nudge — collapsing is a per-node concern.
 * Structural CSS lives in `styles/pages/chat-tray.css`
 * (`.chat-page--v3`), visual tokens in `styles/pages/chat.css`.
 */
export function ChatLayout({ tree, stream, treeOpen, onCloseDrawers, className }: ChatLayoutProps) {
    const { t } = useTranslation();
    return (
        <div
            className={cn("chat-page", "chat-page--v3", treeOpen && "tree-open", className)}
            data-testid="chat-layout"
            data-tree-open={treeOpen ? "true" : "false"}
        >
            <aside className="tree-pane" data-testid="chat-tree-pane">
                {tree}
            </aside>
            <section className="stream-pane" data-testid="chat-stream-pane">
                {stream}
            </section>
            <button
                type="button"
                className="drawer-backdrop"
                data-testid="drawer-backdrop"
                aria-label={t("common.close")}
                tabIndex={treeOpen ? 0 : -1}
                onClick={onCloseDrawers}
            />
        </div>
    );
}
