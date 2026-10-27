import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";

import "@/styles/app.css";
import "@/lib/i18n";

import { Toaster } from "@/components/ui/toast";
import { startBlinkClock } from "@/lib/blink";
import { consumeHandoff } from "@/lib/handoff";
import { router } from "@/router";
import { useConnectionStore } from "@/stores/connection";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 10_000,
            retry: 1,
            refetchOnWindowFocus: false,
        },
    },
});

function App() {
    useEffect(() => startBlinkClock(), []);

    return (
        <StrictMode>
            <ThemeProvider
                attribute="data-theme"
                storageKey="pi2-theme"
                defaultTheme="system"
                enableSystem
                disableTransitionOnChange
            >
                <QueryClientProvider client={queryClient}>
                    <RouterProvider router={router} />
                    <Toaster />
                </QueryClientProvider>
            </ThemeProvider>
        </StrictMode>
    );
}

// `:PiWeb` hands the device token over in the fragment. Consume it before the
// router resolves its first route, and go through the connection store (not
// `setDeviceToken`) so the `pi2-connection` marker the guards read is set too:
// otherwise a fresh browser would still bounce to `/connect` on its first load.
consumeHandoff(window.location, window.history, (token) => {
    useConnectionStore.getState().connect({ token, endpoint: window.location.origin });
});

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(<App />);
