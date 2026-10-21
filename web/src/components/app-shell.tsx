import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "@/components/icons";
import { LangMenu } from "@/components/shared/lang-menu";
import { ServerChip } from "@/components/shared/server-chip";
import { ThemeMenu } from "@/components/shared/theme-menu";
import { SidebarItem } from "@/components/ui/sidebar-item";
import { clearPairMeta } from "@/features/connect/pairing";
import { api, getDeviceToken, onUnauthorized } from "@/lib/api";
import { CONNECT_PATH, safeNext } from "@/lib/routing";
import { defaultWsUrl, PiWsClient, type WsConnectionState } from "@/lib/ws";
import { useConnectionStore } from "@/stores/connection";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

interface NavItem {
    to: "/workspaces" | "/chat" | "/status";
    labelKey: string;
    icon: IconName;
    match: (pathname: string) => boolean;
}

const NAV: NavItem[] = [
    {
        to: "/workspaces",
        labelKey: "nav.workspaces",
        icon: "folder",
        match: (p) => p === "/workspaces" || p.startsWith("/workspace/"),
    },
    { to: "/chat", labelKey: "nav.chat", icon: "chat", match: (p) => p.startsWith("/chat") },
    { to: "/status", labelKey: "nav.status", icon: "status", match: (p) => p.startsWith("/status") },
];

function pageName(pathname: string): string {
    if (pathname.startsWith("/connect")) return "connect";
    if (pathname.startsWith("/status")) return "status";
    if (pathname.startsWith("/chat")) return "chat";
    return "workspaces";
}

function RouteTitle({ pathname }: { pathname: string }) {
    const { t } = useTranslation();
    const server = useConnectionStore((state) => state.server);
    const workspaces = useWorkspacesStore((state) => state.items);
    const selectedSession = useSessionsStore((state) =>
        pathname.startsWith("/chat/") ? state.getSession(decodeURIComponent(pathname.slice("/chat/".length))) : undefined,
    );

    const workspaceId = pathname.startsWith("/workspace/")
        ? decodeURIComponent(pathname.slice("/workspace/".length))
        : selectedSession?.workspaceId;
    const workspace = workspaces.find((w) => w.workspaceId === workspaceId);

    let crumbs: string[] = [];
    let title = t("nav.workspaces");

    if (pathname.startsWith("/connect")) {
        title = t("connect.title");
    } else if (pathname.startsWith("/status")) {
        crumbs = server?.name ? [server.name] : [];
        title = t("nav.status");
    } else if (pathname === "/chat") {
        title = t("nav.chat");
    } else if (pathname.startsWith("/chat/")) {
        crumbs = workspace?.name ? [workspace.name] : [];
        title = selectedSession?.name ?? decodeURIComponent(pathname.slice("/chat/".length));
    } else if (pathname.startsWith("/workspace/")) {
        crumbs = [t("nav.workspaces")];
        title = workspace?.name ?? workspaceId ?? pathname;
    } else {
        crumbs = server?.name ? [server.name] : [];
        title = t("nav.workspaces");
    }

    const parts = [...crumbs, title].filter((part): part is string => Boolean(part));
    return (
        <nav className="crumbs" aria-label={t("shell.navLabel")}>
            {parts.map((part, index) => {
                const last = index === parts.length - 1;
                return (
                    <span key={`${part}-${index}`} className="contents">
                        {index > 0 ? <span className="sep">/</span> : null}
                        <span className={last ? "truncate" : undefined}>{part}</span>
                    </span>
                );
            })}
        </nav>
    );
}

function NavLinks({ pathname }: { pathname: string }) {
    const { t } = useTranslation();
    return (
        <>
            {NAV.map((item) => (
                <SidebarItem key={item.to} active={item.match(pathname)} asChild>
                    <Link to={item.to}>
                        <Icon name={item.icon} />
                        <span>{t(item.labelKey)}</span>
                    </Link>
                </SidebarItem>
            ))}
        </>
    );
}

export function AppShell() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const href = useRouterState({ select: (state) => state.location.href });
    const paired = useConnectionStore((state) => state.paired);
    const setServer = useConnectionStore((state) => state.setServer);
    const wsState = useConnectionStore((state) => state.wsState);
    const setWsState = useConnectionStore((state) => state.setWsState);
    const disconnect = useConnectionStore((state) => state.disconnect);
    const isConnect = pathname.startsWith("/connect");
    // The chat page owns its own socket and already publishes wsState.
    const ownsSocket = !pathname.startsWith("/chat");
    const page = pageName(pathname);
    const redirectingRef = useRef(false);

    const info = useQuery({
        queryKey: ["info"],
        queryFn: ({ signal }) => api.info(signal),
        enabled: paired && !isConnect,
        staleTime: 30_000,
        retry: 1,
    });

    useEffect(() => {
        if (info.data) setServer(info.data);
    }, [info.data, setServer]);

    useEffect(() => {
        document.body.dataset.page = page;
    }, [page]);

    // A fresh pairing re-arms the one-shot unauthorized redirect.
    useEffect(() => {
        if (paired) redirectingRef.current = false;
    }, [paired]);

    /**
     * The daemon rejected the stored device token: drop the local connection
     * (token + paired flags) and bounce once to `/connect` with the current page
     * as `next`. The ref keeps a burst of parallel 401s from looping.
     */
    useEffect(() => {
        return onUnauthorized(() => {
            if (redirectingRef.current) return;
            redirectingRef.current = true;
            disconnect();
            clearPairMeta();
            void navigate({ href: `${CONNECT_PATH}?next=${encodeURIComponent(safeNext(href))}`, replace: true });
        });
    }, [disconnect, href, navigate]);

    /**
     * Lightweight socket probe so `wsState` (shell banner, status card) is
     * populated on pages that do not open a socket themselves. Chat skips it
     * because `useChatSocket` already publishes the same state.
     */
    useEffect(() => {
        if (!paired || isConnect || !ownsSocket) return;
        let active = true;
        const client = new PiWsClient({
            url: defaultWsUrl(),
            token: getDeviceToken(),
            handlers: {
                onState: (state: WsConnectionState) => {
                    if (active) setWsState(state);
                },
                onError: (error) => {
                    if ((error as { code?: string }).code !== "E_UNAUTHORIZED") return;
                    if (redirectingRef.current) return;
                    redirectingRef.current = true;
                    disconnect();
                    clearPairMeta();
                    void navigate({ href: `${CONNECT_PATH}?next=${encodeURIComponent(safeNext(href))}`, replace: true });
                },
            },
        });
        client.connect();
        return () => {
            active = false;
            client.close();
        };
    }, [disconnect, href, isConnect, navigate, ownsSocket, paired, setWsState]);

    const connectionLost = paired && !isConnect && (wsState === "reconnecting" || wsState === "closed");

    return (
        <div className="shell bg-background text-foreground" data-ws-state={wsState} data-paired={paired ? "true" : "false"}>
            <header className="topbar">
                <Link to="/workspaces" className="brand">
                    <img
                        className="brand__logo"
                        src="/pi2-nvim.png"
                        alt=""
                        width={24}
                        height={24}
                        decoding="async"
                    />
                    <span className="brand__text">pi2.nvim</span>
                </Link>
                <RouteTitle pathname={pathname} />
                <div className="spacer" />
                <div className="actions">
                    {isConnect ? null : <ServerChip />}
                    <LangMenu />
                    <ThemeMenu />
                </div>
            </header>

            {connectionLost ? (
                <div className="reconnect-banner" role="status" data-testid="reconnect-banner">
                    <span className="ico">
                        <Icon name="alert" />
                    </span>
                    <span className="reconnect-banner__text">
                        {t(wsState === "closed" ? "shell.connectionLost" : "shell.reconnecting")}
                    </span>
                    <Link to="/connect" className="btn btn--ghost btn--sm">
                        {t("connect.reconnect")}
                    </Link>
                </div>
            ) : null}

            <div className="body">
                {isConnect ? null : (
                    <>
                        <aside className="sidebar">
                            <div className="nav-label">{t("shell.navLabel")}</div>
                            <NavLinks pathname={pathname} />
                        </aside>
                        <aside className="rail">
                            <NavLinks pathname={pathname} />
                        </aside>
                    </>
                )}
                <main className="main">
                    <Outlet />
                </main>
            </div>

            {isConnect ? null : (
                <nav className="tabbar">
                    <NavLinks pathname={pathname} />
                </nav>
            )}
        </div>
    );
}
