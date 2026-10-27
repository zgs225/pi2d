import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "@/components/icons";
import { CommandPalette } from "@/components/shared/command-palette";
import { NavList, pageName } from "@/components/shared/nav-list";
import { PagePill } from "@/components/shared/page-pill";
import { PrefsMenu } from "@/components/shared/prefs-menu";
import { ServerChip } from "@/components/shared/server-chip";
import { clearPairMeta } from "@/features/connect/pairing";
import { useHealthQuery } from "@/features/status/queries";
import { resolveServerStatus } from "@/features/status/server";
import { api, getDeviceToken, onUnauthorized } from "@/lib/api";
import { CONNECT_PATH, safeNext } from "@/lib/routing";
import { defaultWsUrl, PiWsClient, type WsConnectionState } from "@/lib/ws";
import { useConnectionStore } from "@/stores/connection";
import { useSessionsStore } from "@/stores/sessions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

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

/** Topbar palette entry: icon + label (≤1099 label hidden) + platform kbd hint. */
function PaletteTrigger({ onOpen }: { onOpen: () => void }) {
    const { t } = useTranslation();
    const [kbd, setKbd] = useState("Ctrl K");

    useEffect(() => {
        const platform = typeof navigator === "undefined" ? "" : navigator.platform || "";
        setKbd(/Mac|iPhone|iPad/.test(platform) ? "⌘K" : "Ctrl K");
    }, []);

    return (
        <button
            type="button"
            className="btn btn--ghost btn--sm palette-trigger"
            aria-label={t("shell.searchHint")}
            title={t("shell.searchHint")}
            onClick={onOpen}
        >
            <Icon name="search" />
            <span className="palette-trigger__label">{t("shell.searchAction")}</span>
            <span className="kbd palette-trigger__kbd">{kbd}</span>
        </button>
    );
}

export function AppShell() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const pathname = useRouterState({ select: (state) => state.location.pathname });
    const href = useRouterState({ select: (state) => state.location.href });
    const paired = useConnectionStore((state) => state.paired);
    const setServer = useConnectionStore((state) => state.setServer);
    const setServerStatus = useConnectionStore((state) => state.setServerStatus);
    const wsState = useConnectionStore((state) => state.wsState);
    const setWsState = useConnectionStore((state) => state.setWsState);
    const disconnect = useConnectionStore((state) => state.disconnect);
    const isConnect = pathname.startsWith("/connect");
    // The chat page owns its own socket and already publishes wsState.
    const ownsSocket = !pathname.startsWith("/chat");
    const page = pageName(pathname);
    const redirectingRef = useRef(false);
    const [paletteOpen, setPaletteOpen] = useState(false);

    const info = useQuery({
        queryKey: ["info"],
        queryFn: ({ signal }) => api.info(signal),
        enabled: paired && !isConnect,
        staleTime: 30_000,
        retry: 1,
    });
    const health = useHealthQuery(paired && !isConnect);
    const healthOk = health.data?.ok ?? (health.data ? health.data.items.every((item) => item.ok) : undefined);

    useEffect(() => {
        if (info.data) setServer(info.data);
    }, [info.data, setServer]);

    useEffect(() => {
        setServerStatus(
            resolveServerStatus({
                paired,
                info: info.data,
                infoError: info.isError,
                healthError: health.isError,
                healthOk,
            }),
        );
    }, [health.isError, healthOk, info.data, info.isError, paired, setServerStatus]);

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

    /** ⌘K / Ctrl-K opens the palette on every navigation page (never on /connect). */
    useEffect(() => {
        if (!paired || isConnect) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
            if (event.defaultPrevented) return;
            event.preventDefault();
            setPaletteOpen(true);
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, [paired, isConnect]);

    const connectionLost = paired && !isConnect && (wsState === "reconnecting" || wsState === "closed");

    return (
        <div className="shell bg-background text-foreground" data-ws-state={wsState} data-paired={paired ? "true" : "false"}>
            <header className="topbar">
                <Link to="/workspaces" className="brand" aria-label="pi2.nvim">
                    <img
                        className="brand__logo"
                        src="/pi2-nvim.png"
                        alt=""
                        width={22}
                        height={22}
                        decoding="async"
                    />
                    <span className="brand__text">pi2.nvim</span>
                </Link>
                {isConnect ? null : <PagePill page={page} onSearch={() => setPaletteOpen(true)} />}
                <RouteTitle pathname={pathname} />
                <div className="spacer" />
                <div className="actions">
                    {isConnect ? null : <PaletteTrigger onOpen={() => setPaletteOpen(true)} />}
                    {isConnect ? null : <ServerChip />}
                    <PrefsMenu />
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
                {/* <600 has no persistent navigation strip: the page pill owns navigation. */}
                {isConnect ? null : (
                    <>
                        <NavList variant="sidebar" page={page} />
                        <NavList variant="rail" page={page} />
                    </>
                )}
                <main className="main">
                    <Outlet />
                </main>
            </div>

            {isConnect ? null : <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />}
        </div>
    );
}
