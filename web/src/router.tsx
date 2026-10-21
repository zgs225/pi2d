import { Link, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AppShell } from "@/components/app-shell";
import { CONNECT_PATH, safeNext } from "@/lib/routing";
import { useConnectionStore } from "@/stores/connection";

import { ChatIndexPage, ChatPage } from "@/pages/chat";
import { ConnectPage } from "@/pages/connect";
import { StatusPage } from "@/pages/status";
import { WorkspacePage } from "@/pages/workspace";
import { WorkspacesPage } from "@/pages/workspaces";

function requirePaired({ location }: { location: { href: string } }): void {
    if (!useConnectionStore.getState().paired) {
        const next = safeNext(location.href);
        throw redirect({ href: `${CONNECT_PATH}?next=${encodeURIComponent(next)}` });
    }
}

function NotFoundPage() {
    const { t } = useTranslation();
    return (
        <div className="empty">
            <div className="t">{t("errors.notFound")}</div>
            <Link to="/workspaces" className="btn btn--primary mt-4">
                {t("connect.backToWorkspaces")}
            </Link>
        </div>
    );
}

const rootRoute = createRootRoute({
    component: AppShell,
    notFoundComponent: NotFoundPage,
});

const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => {
        throw redirect({ href: "/workspaces" });
    },
});

const workspacesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspaces",
    beforeLoad: requirePaired,
    component: WorkspacesPage,
});

const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workspace/$workspaceId",
    beforeLoad: requirePaired,
    component: WorkspacePage,
});

const chatIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat",
    beforeLoad: requirePaired,
    component: ChatIndexPage,
});

const chatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat/$sessionId",
    beforeLoad: requirePaired,
    component: ChatPage,
});

const statusRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/status",
    beforeLoad: requirePaired,
    component: StatusPage,
});

const connectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/connect",
    validateSearch: (search: Record<string, unknown>): { next?: string } => ({
        next: typeof search.next === "string" ? safeNext(search.next) : undefined,
    }),
    component: ConnectPage,
});

const routeTree = rootRoute.addChildren([
    indexRoute,
    workspacesRoute,
    workspaceRoute,
    chatIndexRoute,
    chatRoute,
    statusRoute,
    connectRoute,
]);

export const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
});

declare module "@tanstack/react-router" {
    interface Register {
        router: typeof router;
    }
}
