import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const DAEMON = "http://127.0.0.1:7676";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Dev/preview proxy for one daemon surface.
 *
 * `changeOrigin` rewrites `Host` only, so the browser's own `Origin`
 * (`http://localhost:5173`) reaches the daemon — whose allowlist is derived from
 * the daemon's own port — and every POST/WS upgrade would be rejected with
 * `403 origin is not allowed`. Presenting the daemon's own origin (always in that
 * derived allowlist) keeps `pnpm --dir web dev` working without `PI2_ORIGINS`,
 * and keeps the daemon's Origin check on rather than bypassing it.
 */
function daemonProxy({ ws = false } = {}) {
    return {
        target: DAEMON,
        changeOrigin: true,
        headers: { origin: DAEMON },
        ...(ws ? { ws: true } : {}),
    };
}

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
            "/api": daemonProxy(),
            "/ws": daemonProxy({ ws: true }),
        },
    },
    preview: {
        proxy: {
            "/api": daemonProxy(),
            "/ws": daemonProxy({ ws: true }),
        },
    },
    test: {
        environment: "jsdom",
        globals: true,
        setupFiles: ["./tests/setup.ts"],
        include: ["tests/**/*.test.{ts,tsx}"],
        css: true,
        // Reuse environment instances across test files within workers to avoid
        // recreating jsdom 35 times (which accounted for ~52% of CPU time).
        isolate: false,
        testTimeout: 15000,
        restoreMocks: true,
    },
});
