import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { renderPage, type TestRoute } from "./helpers/render-page";

import { ServerChip } from "@/components/shared/server-chip";
import type { InfoResponse } from "@/lib/api";
import { setLanguage } from "@/lib/i18n";
import { useConnectionStore } from "@/stores/connection";

/** Realistic daemon /info response payload without `status` field. */
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
        component: () => <ServerChip />,
    },
    {
        path: "/status",
        component: () => <div>Status Page</div>,
    },
];

describe("ServerChip", () => {
    beforeEach(() => {
        setLanguage("en");
        useConnectionStore.getState().disconnect();
        useConnectionStore.getState().connect({ endpoint: "http://127.0.0.1:7676" });
    });

    it("renders dot--ok and Online in English / 在线 in Chinese when serverStatus is online with status-less info payload", async () => {
        // Explicitly assert that realisticInfo does not contain a wire `status` field.
        expect("status" in realisticInfo).toBe(false);

        const { container } = await renderPage(routes(), "/", { paired: true });

        act(() => {
            const store = useConnectionStore.getState();
            store.setServer(realisticInfo);
            store.setServerStatus("online");
        });

        const dot = container.querySelector(".server-chip .dot");
        expect(dot).not.toBeNull();
        expect(dot).toHaveClass("dot--ok");
        expect(dot).not.toHaveClass("dot--exited");
        expect(dot?.getAttribute("title")).toBe("Online");
        expect(dot?.getAttribute("aria-label")).toBe("Online");

        // Verify Chinese localization
        act(() => {
            setLanguage("zh");
        });
        expect(dot?.getAttribute("title")).toBe("在线");
        expect(dot?.getAttribute("aria-label")).toBe("在线");
    });

    it("renders dot--idle and Unknown / 未知 for the initial store value (unknown)", async () => {
        expect(useConnectionStore.getState().serverStatus).toBe("unknown");

        const { container } = await renderPage(routes(), "/", { paired: true });

        const dot = container.querySelector(".server-chip .dot");
        expect(dot).not.toBeNull();
        expect(dot).toHaveClass("dot--idle");
        expect(dot?.getAttribute("title")).toBe("Unknown");
        expect(dot?.getAttribute("aria-label")).toBe("Unknown");

        act(() => {
            setLanguage("zh");
        });
        expect(dot?.getAttribute("title")).toBe("未知");
        expect(dot?.getAttribute("aria-label")).toBe("未知");
    });

    it("renders dot--ok when server override carries a bogus status: 'offline' while store's serverStatus is online", async () => {
        const bogusServer = { ...realisticInfo, status: "offline" } as unknown as InfoResponse;
        const overrideRoutes = (): TestRoute[] => [
            {
                path: "/",
                component: () => <ServerChip server={bogusServer} />,
            },
        ];

        const { container } = await renderPage(overrideRoutes(), "/", { paired: true });

        act(() => {
            const store = useConnectionStore.getState();
            store.setServerStatus("online");
        });

        const dot = container.querySelector(".server-chip .dot");
        expect(dot).not.toBeNull();
        expect(dot).toHaveClass("dot--ok");
        expect(dot).not.toHaveClass("dot--exited");
    });

    it("renders dot--idle and Unknown / 未知 when serverStatus is unknown", async () => {
        const { container } = await renderPage(routes(), "/", { paired: true });

        act(() => {
            const store = useConnectionStore.getState();
            store.setServer(realisticInfo);
            store.setServerStatus("unknown");
        });

        const dot = container.querySelector(".server-chip .dot");
        expect(dot).not.toBeNull();
        expect(dot).toHaveClass("dot--idle");
        expect(dot?.getAttribute("title")).toBe("Unknown");
        expect(dot?.getAttribute("aria-label")).toBe("Unknown");

        act(() => {
            setLanguage("zh");
        });
        expect(dot?.getAttribute("title")).toBe("未知");
        expect(dot?.getAttribute("aria-label")).toBe("未知");
    });

    it("renders dot--exited and Offline / 离线 when serverStatus is offline", async () => {
        const { container } = await renderPage(routes(), "/", { paired: true });

        act(() => {
            const store = useConnectionStore.getState();
            store.setServer(realisticInfo);
            store.setServerStatus("offline");
        });

        const dot = container.querySelector(".server-chip .dot");
        expect(dot).not.toBeNull();
        expect(dot).toHaveClass("dot--exited");
        expect(dot?.getAttribute("title")).toBe("Offline");
        expect(dot?.getAttribute("aria-label")).toBe("Offline");

        act(() => {
            setLanguage("zh");
        });
        expect(dot?.getAttribute("title")).toBe("离线");
        expect(dot?.getAttribute("aria-label")).toBe("离线");
    });
});
