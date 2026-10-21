import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { commandCalls, mockApi } from "./helpers/api-mock";
import { renderPage } from "./helpers/render-page";

import { setLanguage } from "@/lib/i18n";
import { ConnectPage } from "@/pages/connect";

const infoBody = {
    v: 1,
    daemonId: "daemon-1",
    machineId: "machine-1",
    platform: "linux",
    capabilities: ["read", "steer"],
    limits: {},
};

function routes() {
    return [
        { path: "/connect", component: ConnectPage },
        { path: "/workspaces", component: () => <div>Workspaces destination</div> },
        { path: "/status", component: () => <div>Status destination</div> },
    ];
}

function redeemRoute() {
    return {
        method: "POST" as const,
        path: "/api/v1/cmd",
        handler: () => ({
            body: {
                accepted: true,
                token: "pkt_test",
                scopes: ["read", "steer"],
                server: { name: "ThinkPad", hostname: "thinkpad" },
            },
        }),
    };
}

beforeEach(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ConnectPage", () => {
    it("validates host, port and token inline without calling the daemon", async () => {
        const fetchMock = mockApi([redeemRoute()]);
        await renderPage(routes(), "/connect", { paired: false });

        const submit = screen.getByRole("button", { name: "Connect" });
        fireEvent.click(submit);
        expect(await screen.findByText("Enter the server address")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Host"), { target: { value: "192.168.2.10" } });
        fireEvent.change(screen.getByLabelText("Port"), { target: { value: "99999" } });
        fireEvent.click(submit);
        expect(await screen.findByText("Port must be 1–65535")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Port"), { target: { value: "4321" } });
        fireEvent.click(submit);
        expect(await screen.findByText("Enter the pairing token")).toBeInTheDocument();
        expect(commandCalls(fetchMock)).toHaveLength(0);
    });

    it("redeems a manual pairing, stores endpoint + token and redirects", async () => {
        const fetchMock = mockApi([redeemRoute()]);
        const { router } = await renderPage(routes(), "/connect", { paired: false });

        fireEvent.change(screen.getByLabelText("Host"), { target: { value: "192.168.2.10" } });
        fireEvent.change(screen.getByLabelText("Port"), { target: { value: "4321" } });
        fireEvent.change(screen.getByPlaceholderText("Pairing token (pkt_…)"), {
            target: { value: "ABCD-1234" },
        });
        fireEvent.change(screen.getByPlaceholderText("e.g. My browser"), {
            target: { value: "My browser" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));

        await waitFor(() =>
            expect(localStorage.getItem("pi2-device-token")).toBe("Bearer pkt_test"),
        );
        expect(localStorage.getItem("pi2-endpoint")).toBe("http://192.168.2.10:4321");
        expect(localStorage.getItem("pi2-connection")).toBe("paired");

        const commands = commandCalls(fetchMock);
        expect(commands).toHaveLength(1);
        expect(commands[0]?.method).toBe("pair.redeem");
        expect(commands[0]?.params).toMatchObject({
            code: "ABCD-1234",
            deviceName: "My browser",
        });

        await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces"));
        expect(await screen.findByText("Workspaces destination")).toBeInTheDocument();
    });

    it("shows the paired summary and clears storage on confirmed disconnect", async () => {
        mockApi([{ path: "/api/v1/info", handler: () => ({ body: infoBody }) }]);
        await renderPage(routes(), "/connect", {
            paired: true,
            storage: {
                "pi2-device": "Test browser",
                "pi2-endpoint": "http://192.168.2.10:4321",
            },
        });

        expect(await screen.findByText("Current connection")).toBeInTheDocument();
        expect(screen.getByText("Test browser")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

        await waitFor(() => expect(localStorage.getItem("pi2-device-token")).toBeNull());
        expect(localStorage.getItem("pi2-connection")).toBe("unpaired");
        expect(await screen.findByRole("button", { name: "Scan to pair" })).toBeInTheDocument();
        expect(screen.queryByText("Current connection")).not.toBeInTheDocument();
    });
});
