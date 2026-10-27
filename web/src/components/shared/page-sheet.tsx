import { Link } from "@tanstack/react-router";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { NAV, type NavKey, type PageName } from "@/components/shared/nav-list";
import { Modal } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspacesStore } from "@/stores/workspaces";

export interface PageSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    page: PageName;
    /** Closes the sheet, then opens the command palette (the <600 search entry). */
    onSearch: () => void;
    /** Element focused when the sheet closes — the page pill. */
    returnFocusTo?: RefObject<HTMLElement | null>;
}

/**
 * Page sheet (CHG-20): one dialog with two layouts — 26rem centered ≥600,
 * bottom sheet <600 (top radius 20px, starts at translateY(24px), padding-bottom
 * 20px + safe area). Five rows: three pages, a separator, search, connection.
 * The current row carries `aria-current="page"` + a check; the other page rows
 * show a live fact on the right.
 */
export function PageSheet({ open, onOpenChange, page, onSearch, returnFocusTo }: PageSheetProps) {
    const { t } = useTranslation();
    const workspaces = useWorkspacesStore((state) => state.items);
    const byWorkspace = useSessionsStore((state) => state.byWorkspace);
    const server = useConnectionStore((state) => state.server);
    const serverStatus = useConnectionStore((s) => s.serverStatus);

    const sessionCount = Object.values(byWorkspace).reduce((total, list) => total + list.length, 0);
    const status = serverStatus;
    const version = server?.pluginVersion || server?.version || "";

    function fact(key: NavKey): string {
        if (key === "workspaces") return t("shell.pageFactWorkspaces", { n: workspaces.length });
        if (key === "chat") return t("shell.pageFactChat", { n: sessionCount });
        return t("shell.pageFactStatus", { state: t(`state.${status}`), version });
    }

    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            title={t("shell.pages")}
            returnFocusTo={returnFocusTo}
        >
            <div className="sheet-list">
                {NAV.map((entry) => {
                    const current = entry.key === page;
                    return (
                        <Link
                            key={entry.to}
                            to={entry.to}
                            className={cn("sheet-row", current && "is-current")}
                            aria-current={current ? "page" : undefined}
                            onClick={() => onOpenChange(false)}
                        >
                            <Icon name={entry.icon} />
                            <span className="sheet-row__label">{t(entry.labelKey)}</span>
                            {current ? (
                                <span className="sheet-row__check">
                                    <Icon name="check" />
                                </span>
                            ) : (
                                <span className="sheet-row__fact">{fact(entry.key)}</span>
                            )}
                        </Link>
                    );
                })}
                <div className="sheet-sep" />
                <button
                    type="button"
                    className="sheet-row sheet-row--quiet"
                    onClick={() => {
                        onOpenChange(false);
                        onSearch();
                    }}
                >
                    <Icon name="search" />
                    <span className="sheet-row__label">{t("shell.searchAction")}</span>
                </button>
                <Link
                    to="/connect"
                    className="sheet-row sheet-row--quiet"
                    onClick={() => onOpenChange(false)}
                >
                    <Icon name="plug" />
                    <span className="sheet-row__label">{t("shell.connection")}</span>
                </Link>
            </div>
        </Modal>
    );
}
