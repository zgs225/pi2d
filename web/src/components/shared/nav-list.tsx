import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/components/icons";
import { SidebarItem } from "@/components/ui/sidebar-item";
import { serverDotClass } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connection";

/** `NAV` is the single source of truth for the icon strip, the page sheet and the palette. */
export type PageName = "workspaces" | "chat" | "status" | "connect";
export type NavKey = "workspaces" | "chat" | "status";

export interface NavEntry {
    key: NavKey;
    to: "/workspaces" | "/chat" | "/status";
    labelKey: string;
    icon: IconName;
    match: (pathname: string) => boolean;
}

export const NAV: NavEntry[] = [
    {
        key: "workspaces",
        to: "/workspaces",
        labelKey: "nav.workspaces",
        icon: "folder",
        match: (p) => p === "/workspaces" || p.startsWith("/workspace/"),
    },
    { key: "chat", to: "/chat", labelKey: "nav.chat", icon: "chat", match: (p) => p.startsWith("/chat") },
    { key: "status", to: "/status", labelKey: "nav.status", icon: "status", match: (p) => p.startsWith("/status") },
];

/** Resolve the current top-level page; detail routes fall back to their section. */
export function pageName(pathname: string): PageName {
    if (pathname.startsWith("/connect")) return "connect";
    if (pathname.startsWith("/status")) return "status";
    if (pathname.startsWith("/chat")) return "chat";
    return "workspaces";
}

export function navEntryFor(page: PageName): NavEntry {
    return NAV.find((entry) => entry.key === page) ?? NAV[0]!;
}

export interface NavListProps {
    /** Sidebar (≥840) and rail (600–839) render the same component; CSS decides visibility. */
    variant: "sidebar" | "rail";
    page: PageName;
}

/**
 * 56px compact icon strip: three 44×44 nav rows (icon only, tooltip carries the
 * label) plus the shared footer (server status → /status, pairing → /connect).
 * Both variants render the footer — the design contract explicitly requires it.
 */
export function NavList({ variant, page }: NavListProps) {
    const { t } = useTranslation();
    const server = useConnectionStore((state) => state.server);

    const status = server?.status ?? "offline";
    const name = server?.name ?? "pi2.nvim";
    const version = server?.pluginVersion ?? server?.version ?? "";
    const serverTip = t("shell.railServerTip", { name, status: t(`state.${status}`), version });
    const connectTip = t("shell.connection");

    return (
        <aside className={variant} aria-label={t("shell.navLabel")}>
            {NAV.map((entry) => (
                <SidebarItem
                    key={entry.to}
                    active={entry.key === page}
                    compact
                    tip={t(entry.labelKey)}
                    asChild
                >
                    <Link to={entry.to}>
                        <Icon name={entry.icon} />
                    </Link>
                </SidebarItem>
            ))}
            <div className="sidebar__foot">
                <Link
                    to="/status"
                    className="rail-foot__link has-tip"
                    data-tip={serverTip}
                    aria-label={serverTip}
                >
                    <Icon name="server" />
                    <span
                        className={cn("rail-foot__dot dot dot--lg", serverDotClass(status))}
                        aria-hidden="true"
                    />
                </Link>
                <Link
                    to="/connect"
                    className="rail-foot__link has-tip"
                    data-tip={connectTip}
                    aria-label={connectTip}
                >
                    <Icon name="plug" />
                </Link>
            </div>
        </aside>
    );
}
