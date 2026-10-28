import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockApi, type MockRoute } from "./helpers/api-mock";
import { renderPage } from "./helpers/render-page";

import { setLanguage } from "@/lib/i18n";
import { StatusPage } from "@/pages/status";

// ── minimal stubs for every endpoint the StatusPage touches ──────────────────

const infoBody = {
    v: 1,
    daemonId: "daemon-1",
    hostname: "box",
    version: "0.1.0",
    platform: "linux",
};

const healthBody = {
    ok: true,
    checkedAt: Date.now(),
    items: [{ name: "plugin", ok: true, detail: "connected" }],
};

const resourcesBody = {
    instances: [],
    totalRssBytes: 0,
    physicalMemoryBytes: 1024 * 1024 * 1024,
    warn: false,
};

const workspacesBody = [
    {
        workspaceId: "ws-1",
        cwd: "/home/me/work",
        name: "Work",
        trusted: true,
        exists: true,
        sessionCount: 1,
        liveCount: 1,
        lastActiveAt: Date.now(),
        instance: { workspaceId: "ws-1", status: "ready", pid: 1234, since: Date.now() },
    },
];

const devicesBody: unknown[] = [];
const pairBody = {
    accepted: true,
    code: "XYZW9999",
    url: "http://127.0.0.1:4321/pair/XYZW9999",
    expiresAt: Date.now() + 9 * 60_000,
    nonce: "nonce-x",
    bases: [],
};

const SESSIONS_PATH = /^\/api\/v1\/workspaces\/[^/]+\/sessions$/;

/** Build a full route table, merging caller overrides in front. */
function apiRoutes(overrides: MockRoute[] = []): MockRoute[] {
    const base: MockRoute[] = [
        { path: "/api/v1/info", handler: () => ({ body: infoBody }) },
        { path: "/api/v1/health", handler: () => ({ body: healthBody }) },
        { path: "/api/v1/resources", handler: () => ({ body: resourcesBody }) },
        { path: "/api/v1/workspaces", handler: () => ({ body: workspacesBody }) },
        { path: SESSIONS_PATH, handler: () => ({ body: { sessions: [] } }) },
        { path: "/api/v1/models", handler: () => ({ body: { providers: [], pending: false } }) },
        { path: "/api/v1/devices", handler: () => ({ body: devicesBody }) },
        { method: "POST" as const, path: "/api/v1/pair", handler: () => ({ body: pairBody }) },
    ];
    const overridePaths = overrides.map((r) => r.path);
    return [...overrides, ...base.filter((r) => !overridePaths.includes(r.path))];
}

function routes() {
    return [
        { path: "/status", component: StatusPage },
        { path: "/connect", component: () => <div>connect</div> },
    ];
}

/** Return the `.status-card` whose heading contains the given text. */
function modelsCard(): HTMLElement {
    const heading = screen.getByText("Models & providers");
    const root = heading.closest(".status-card");
    if (!(root instanceof HTMLElement)) throw new Error("Models & providers card not found");
    return root;
}

beforeEach(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ModelsCard via StatusPage", () => {
    it("(a) pending + empty providers → loading block visible, pending copy present, no error block", async () => {
        mockApi(
            apiRoutes([
                {
                    path: "/api/v1/models",
                    handler: () => ({
                        body: { providers: [], pending: true, pendingReason: "fetching" },
                    }),
                },
            ]),
        );

        await renderPage(routes(), "/status", { paired: true });
        // Wait for the page to settle so the models query fires.
        await screen.findByText("Models & providers");

        const card = modelsCard();

        // Must show the loading skeleton (aria role="status").
        await waitFor(() => {
            expect(card.querySelector('[role="status"]')).not.toBeNull();
        });

        // The aria-live pending region must be present and contain the pending copy.
        await waitFor(() => {
            expect(card.querySelector('[aria-live="polite"]')).not.toBeNull();
        });
        await waitFor(() => {
            expect(card).toHaveTextContent("Fetching the catalogue from a running Neovim");
        });

        // Must NOT render an error block (no .status-error).
        expect(card.querySelector(".status-error")).toBeNull();
    });

    it(
        "(b) providers returned → provider row, model id, context window and badges render",
        async () => {
            mockApi(
                apiRoutes([
                    {
                        path: "/api/v1/models",
                        handler: () => ({
                            body: {
                                providers: [
                                    {
                                        provider: "cliproxyapi",
                                        models: [
                                            {
                                                id: "gemini-3.8-flash-high",
                                                contextWindow: 1_000_000,
                                                reasoning: true,
                                            },
                                        ],
                                    },
                                ],
                                pending: false,
                                workspaceId: "ws-1",
                            },
                        }),
                    },
                ]),
            );

            await renderPage(routes(), "/status", { paired: true });
            await screen.findByText("Models & providers");

            const card = modelsCard();

            // Provider name visible.
            await waitFor(() => {
                expect(card).toHaveTextContent("cliproxyapi");
            });

            // Model id visible.
            expect(card).toHaveTextContent("gemini-3.8-flash-high");

            // Context window formatted (1 000 000 → "1M" or "1000K" depending on formatter).
            await waitFor(() => {
                expect(card.querySelector(".model-ctx")).not.toBeNull();
                const ctx = card.querySelector(".model-ctx")?.textContent ?? "";
                expect(ctx.length).toBeGreaterThan(0);
            });

            // Reasoning badge.
            expect(card).toHaveTextContent("reasoning");

            // Scoped badge (cliproxyapi provider).
            expect(card).toHaveTextContent("scoped");
        },
    );

    it("(c) pending:true + pendingReason:no-instance → no-instance empty state", async () => {
        mockApi(
            apiRoutes([
                {
                    path: "/api/v1/models",
                    handler: () => ({
                        body: { providers: [], pending: true, pendingReason: "no-instance" },
                    }),
                },
            ]),
        );

        await renderPage(routes(), "/status", { paired: true });
        await screen.findByText("Models & providers");

        const card = modelsCard();

        await waitFor(() => {
            expect(card).toHaveTextContent("No live Neovim instance");
        });
        expect(card).toHaveTextContent("Open a session in any workspace");

        // Not an error block.
        expect(card.querySelector(".status-error")).toBeNull();
    });

    it("(d) failed request → ErrorBlock with error message and retry button triggers refetch", async () => {
        let callCount = 0;
        // useModelsQuery retries once on its own, so a single 500 is not the
        // click. Keep failing until the button is pressed.
        let allowSuccess = false;
        mockApi(
            apiRoutes([
                {
                    path: "/api/v1/models",
                    handler: () => {
                        callCount += 1;
                        if (!allowSuccess) {
                            return { status: 500, body: { code: "E_INTERNAL", message: "server exploded" } };
                        }
                        return {
                            body: {
                                providers: [
                                    {
                                        provider: "anthropic",
                                        models: [{ id: "claude-opus-4", contextWindow: 200_000, reasoning: false }],
                                    },
                                ],
                                pending: false,
                            },
                        };
                    },
                },
            ]),
        );

        await renderPage(routes(), "/status", { paired: true });
        await screen.findByText("Models & providers");

        const card = modelsCard();

        // Error block must appear. The query retries once (~1s) before it settles.
        await waitFor(
            () => {
                expect(card.querySelector(".status-error")).not.toBeNull();
            },
            { timeout: 4_000 },
        );

        // Retry button must be present.
        const retryBtn = card.querySelector("button");
        expect(retryBtn).not.toBeNull();

        // Click retry → next fetch succeeds → providers appear.
        allowSuccess = true;
        retryBtn!.click();

        await waitFor(
            () => {
                expect(card).toHaveTextContent("anthropic");
            },
            { timeout: 4_000 },
        );
        expect(callCount).toBeGreaterThanOrEqual(2);
    });
});
