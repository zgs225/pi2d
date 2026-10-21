import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const DAEMON = "http://127.0.0.1:7676";

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "src"),
        },
    },
    server: {
        port: 5173,
        strictPort: false,
        proxy: {
            "/api": {
                target: DAEMON,
                changeOrigin: true,
            },
            "/ws": {
                target: DAEMON,
                changeOrigin: true,
                ws: true,
            },
        },
    },
    preview: {
        proxy: {
            "/api": { target: DAEMON, changeOrigin: true },
            "/ws": { target: DAEMON, changeOrigin: true, ws: true },
        },
    },
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: ["./tests/setup.ts"],
        include: ["tests/**/*.test.{ts,tsx}"],
        css: true,
        restoreMocks: true,
    },
});
