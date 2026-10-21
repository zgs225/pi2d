import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@/styles/app.css";
import "@/lib/i18n";

import { Toaster } from "@/components/ui/toast";
import { router } from "@/router";

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

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");
createRoot(container).render(<App />);
