import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { renderPage, type TestRoute } from "./helpers/render-page";

import { PageSheet } from "@/components/shared/page-sheet";
import type { InfoResponse } from "@/lib/api";
import { setLanguage } from "@/lib/i18n";
import { useConnectionStore } from "@/stores/connection";

const realisticInfo: InfoResponse = {
    v: 1,
    daemonId: "daemon-test-1",
    machineId: "machine-test-1",
    platform: "linux",
    hostname: "devbook-eos",
    os: "Linux 6.12.0",
    version: "0.1.3",
    uptimeMs: 123456,
    port: 7676,
    capabilities: ["read", "steer"],
    limits: { maxInstances: 5 },
};

const routes = (): TestRoute[] => [
    {
        path: "/",
        component: () => (
            <PageSheet
                open={true}
                onOpenChange={() => {}}
                page="workspaces"
                onSearch={() => {}}
            />
        ),
    },
    {
        path: "/workspaces",
        component: () => <div>Workspaces</div>,
    },
    {
        path: "/status",
        component: () => <div>Status</div>,
    },
    {
        path: "/chat",
        component: () => <div>Chat</div>,
    },
];

describe("PageSheet", () => {
    beforeEach(() => {
        setLanguage("en");
        useConnectionStore.getState().disconnect();
        useConnectionStore.getState().connect({ endpoint: "http://127.0.0.1:7676" });
    });

    it("shows localized online state + 0.1.3 on the status row fact and never unknown / 未知 once serverStatus is online", async () => {
        await renderPage(routes(), "/", { paired: true });

        act(() => {
            const store = useConnectionStore.getState();
            store.setServer(realisticInfo);
            store.setServerStatus("online");
        });

        const statusLink = document.querySelector('a[href="/status"]');
        expect(statusLink).not.toBeNull();
        const fact = statusLink?.querySelector(".sheet-row__fact");
        expect(fact).not.toBeNull();
        expect(fact?.textContent).toBe("Online · 0.1.3");
        expect(fact?.textContent).not.toContain("Unknown");

        // Verify Chinese localization
        act(() => {
            setLanguage("zh");
        });
        expect(fact?.textContent).toBe("在线 · 0.1.3");
        expect(fact?.textContent).not.toContain("未知");
    });

    it("shows 0.1.3 even when pluginVersion is empty string via the fallback chain", async () => {
        await renderPage(routes(), "/", { paired: true });

        act(() => {
            const store = useConnectionStore.getState();
            store.setServer({ ...realisticInfo, pluginVersion: "", version: "0.1.3" } as unknown as InfoResponse);
            store.setServerStatus("online");
        });

        const statusLink = document.querySelector('a[href="/status"]');
        expect(statusLink).not.toBeNull();
        const fact = statusLink?.querySelector(".sheet-row__fact");
        expect(fact?.textContent).toBe("Online · 0.1.3");
    });
});
