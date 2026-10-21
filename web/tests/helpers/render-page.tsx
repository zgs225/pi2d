import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    Outlet,
    RouterProvider,
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import type { ComponentType } from "react";

import { useConnectionStore } from "@/stores/connection";

export interface TestRoute {
    path: string;
    component: ComponentType;
}

export interface RenderPageOptions {
    paired?: boolean;
    storage?: Record<string, string>;
}

/**
 * Mount a page inside a minimal memory router + isolated QueryClient.
 * The root renders an Outlet so each route component mounts without AppShell.
 */
export async function renderPage(
    routes: TestRoute[],
    initialPath: string,
    options: RenderPageOptions = {},
) {
    localStorage.clear();
    if (options.paired ?? true) {
        localStorage.setItem("pi2-connection", "paired");
        localStorage.setItem("pi2-device-token", "test-token");
        localStorage.setItem("pi2-endpoint", "http://127.0.0.1:4321");
        localStorage.setItem("pi2-device", "Test browser");
        localStorage.setItem("pi2-connected-at", String(Date.now()));
    }
    for (const [key, value] of Object.entries(options.storage ?? {})) localStorage.setItem(key, value);
    useConnectionStore.getState().refreshFromStorage();

    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const routeTree = rootRoute.addChildren(
        routes.map((route) =>
            createRoute({
                getParentRoute: () => rootRoute,
                path: route.path,
                component: () => <route.component />,
            }),
        ),
    );
    const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [initialPath] }),
        defaultPreload: false,
    });
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false },
            mutations: { retry: false },
        },
    });

    const result = render(
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
        </QueryClientProvider>,
    );
    await router.load();

    return { ...result, router, queryClient };
}
