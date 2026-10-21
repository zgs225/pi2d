import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const DAEMON = "http://127.0.0.1:7676";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(import.meta.dirname, "src"),
            // Canonical wire types + reducer live in the daemon package; import them
            // instead of keeping a drifting copy under src/lib/protocol.ts.
            "@protocol": path.resolve(REPO_ROOT, "src/protocol"),
        },
    },
    server: {
        // The @protocol alias points outside web/, so Vite must be allowed to
        // serve the repo root (daemon protocol files) in dev.
        fs: { allow: [REPO_ROOT] },
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
