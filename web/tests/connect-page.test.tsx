import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockApi, type MockRoute } from "./helpers/api-mock";
import { renderPage } from "./helpers/render-page";

import { isPairCode, normalizePairCode, parsePairLink, safePairNext } from "@/features/connect/pairing";
import { setLanguage } from "@/lib/i18n";
import { ConnectPage } from "@/pages/connect";

const infoBody = {
    v: 1,
    daemonId: "daemon-1",
    machineId: "machine-1",
    platform: "linux",
    capabilities: ["read", "steer"],
    limits: {},
    name: "ThinkPad",
    hostname: "thinkpad-x1",
    os: "linux",
    version: "0.4.2",
    uptimeMs: 3 * 3_600_000,
};

function routes() {
    return [
        { path: "/connect", component: ConnectPage },
        { path: "/workspaces", component: () => <div>Workspaces destination</div> },
        { path: "/chat/$sessionId", component: () => <div>Chat destination</div> },
        { path: "/status", component: () => <div>Status destination</div> },
    ];
}

/** `POST <origin>/api/v1/pair` → `{token, device}` (the public redeem contract). */
function pairRoute(reply: { status?: number; body?: unknown } = {}): MockRoute {
    return {
        method: "POST",
        path: "/api/v1/pair",
        handler: () => ({
            status: reply.status ?? 200,
            body: reply.body ?? {
                token: "pkt_test",
                device: {
                    id: "dev-7c1",
                    name: "My browser",
                    kind: "laptop",
                    scopes: ["read", "steer"],
                    lastSeenAt: 1_700_000_000_000,
                },
            },
        }),
    };
}

interface PairCall {
    origin: string;
    body: Record<string, unknown>;
}

function pairCalls(fetchMock: ReturnType<typeof mockApi>): PairCall[] {
    return fetchMock.mock.calls
        .filter(([input, init]) => {
            const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            return new URL(raw, "http://localhost").pathname === "/api/v1/pair" && (init?.method ?? "GET") === "POST";
        })
        .map(([input, init]) => {
            const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const url = new URL(raw, "http://localhost");
            return { origin: url.origin, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
        });
}

function fillManualForm(values: { host?: string; port?: string; code?: string; device?: string }) {
    if (values.host !== undefined) fireEvent.change(screen.getByTestId("connect-host"), { target: { value: values.host } });
    if (values.port !== undefined) fireEvent.change(screen.getByTestId("connect-port"), { target: { value: values.port } });
    if (values.code !== undefined) {
        fireEvent.change(screen.getByTestId("connect-pair-code"), { target: { value: values.code } });
    }
    if (values.device !== undefined) {
        fireEvent.change(screen.getByTestId("connect-device"), { target: { value: values.device } });
    }
}

beforeEach(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ConnectPage", () => {
    it("validates host, port and the 8-character pairing code inline without calling the daemon", async () => {
        const fetchMock = mockApi([pairRoute()]);
        await renderPage(routes(), "/connect", { paired: false });

        const submit = screen.getByTestId("connect-submit");
        fireEvent.click(submit);
        expect(await screen.findByText("Enter the server address")).toBeInTheDocument();

        fillManualForm({ host: "192.168.2.10", port: "99999" });
        fireEvent.click(submit);
        expect(await screen.findByText("Port must be 1–65535")).toBeInTheDocument();

        fillManualForm({ port: "4321" });
        fireEvent.click(submit);
        expect(await screen.findByText("Enter the 8-character pairing code")).toBeInTheDocument();

        fillManualForm({ code: "ABC" });
        fireEvent.click(submit);
        expect(await screen.findByText("Pairing code must be 8 letters or digits (A–Z, 0–9)")).toBeInTheDocument();

        expect(pairCalls(fetchMock)).toHaveLength(0);
    });

    it("labels the third field as a pairing code and uppercases input", async () => {
        mockApi([pairRoute()]);
        await renderPage(routes(), "/connect", { paired: false });

        expect(screen.getByLabelText("Pairing code")).toBe(screen.getByTestId("connect-pair-code"));
        fillManualForm({ code: "ab-cd12 34" });
        expect(screen.getByTestId("connect-pair-code")).toHaveValue("ABCD1234");
    });

    it("redeems a manual pairing against /api/v1/pair, stores token + scopes and redirects", async () => {
        const fetchMock = mockApi([pairRoute()]);
        const { router } = await renderPage(routes(), "/connect", { paired: false });

        fillManualForm({ host: "192.168.2.10", port: "4321", code: "abcd1234", device: "My browser" });
        fireEvent.click(screen.getByTestId("connect-submit"));

        await waitFor(() => expect(localStorage.getItem("pi2-device-token")).toBe("Bearer pkt_test"));
        expect(localStorage.getItem("pi2-endpoint")).toBe("http://192.168.2.10:4321");
        expect(localStorage.getItem("pi2-connection")).toBe("paired");
        expect(JSON.parse(localStorage.getItem("pi2-device-scopes") ?? "[]")).toEqual(["read", "steer"]);

        const calls = pairCalls(fetchMock);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.origin).toBe("http://192.168.2.10:4321");
        expect(calls[0]?.body).toEqual({ code: "ABCD1234", kind: "laptop", deviceName: "My browser" });

        await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces"));
        expect(await screen.findByText("Workspaces destination")).toBeInTheDocument();
    });

    it("returns to an allow-listed deep link after pairing", async () => {
        const fetchMock = mockApi([pairRoute()]);
        const { router } = await renderPage(routes(), "/connect?next=%2Fchat%2F01a15368%3Fworkspace%3Dws-1", {
            paired: false,
        });

        fillManualForm({ host: "192.168.2.10", code: "ABCD1234", device: "My browser" });
        fireEvent.click(screen.getByTestId("connect-submit"));

        await waitFor(() => expect(router.state.location.pathname).toBe("/chat/01a15368"));
        expect(router.state.location.search).toMatchObject({ workspace: "ws-1" });
        expect(pairCalls(fetchMock)).toHaveLength(1);
    });

    it("shows a localized inline error for a wrong or expired code and stays unpaired", async () => {
        mockApi([
            pairRoute({
                status: 401,
                body: { code: "E_UNAUTHORIZED", message: "invalid or already used pairing code" },
            }),
        ]);
        const { router } = await renderPage(routes(), "/connect", { paired: false });

        fillManualForm({ host: "192.168.2.10", code: "ZZZZ9999", device: "My browser" });
        fireEvent.click(screen.getByTestId("connect-submit"));

        expect(
            await screen.findByText("Pairing code is wrong or expired. Create a new code on the server."),
        ).toBeInTheDocument();
        expect(localStorage.getItem("pi2-device-token")).toBeNull();
        expect(localStorage.getItem("pi2-connection")).toBeNull();
        expect(router.state.location.pathname).toBe("/connect");
        expect(screen.getByTestId("connect-submit")).toBeEnabled();
    });

    it("warns then pairs from a pasted pi2 pair link through the confirmation dialog", async () => {
        const fetchMock = mockApi([pairRoute()]);
        const { router } = await renderPage(routes(), "/connect", { paired: false });

        fireEvent.click(screen.getByTestId("connect-scan"));
        const link = await screen.findByLabelText("Pairing link");
        fireEvent.change(link, {
            target: { value: "pi2://pair?host=192.168.2.10&port=4321&code=ABCD1234" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Identify" }));

        // Confirmation dialog: host:port + masked code, and its buttons must be clickable.
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("192.168.2.10:4321")).toBeInTheDocument();
        expect(within(dialog).getByText("…234")).toBeInTheDocument();

        fireEvent.click(screen.getByTestId("connect-confirm-connect"));
        await waitFor(() => expect(localStorage.getItem("pi2-connection")).toBe("paired"));
        expect(pairCalls(fetchMock)[0]?.body).toMatchObject({ code: "ABCD1234" });
        await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces"));
    });

    it("cancel on the confirmation dialog leaves the connection untouched", async () => {
        const fetchMock = mockApi([pairRoute()]);
        const { router } = await renderPage(routes(), "/connect", { paired: false });

        fireEvent.click(screen.getByTestId("connect-scan"));
        const link = await screen.findByLabelText("Pairing link");
        fireEvent.change(link, { target: { value: "pi2://pair?host=192.168.2.10&code=ABCD1234" } });
        fireEvent.click(screen.getByRole("button", { name: "Identify" }));
        await screen.findByRole("dialog");

        fireEvent.click(screen.getByTestId("connect-confirm-cancel"));
        await waitFor(() => expect(screen.queryByTestId("connect-confirm-cancel")).not.toBeInTheDocument());
        expect(pairCalls(fetchMock)).toHaveLength(0);
        expect(localStorage.getItem("pi2-connection")).toBeNull();
        expect(router.state.location.pathname).toBe("/connect");
    });

    it("shows the paired summary with server identity, uptime and device scopes", async () => {
        mockApi([{ path: "/api/v1/info", handler: () => ({ body: infoBody }) }]);
        await renderPage(routes(), "/connect", {
            paired: true,
            storage: {
                "pi2-device": "Test browser",
                "pi2-endpoint": "http://192.168.2.10:4321",
                "pi2-device-scopes": JSON.stringify(["read", "steer"]),
            },
        });

        expect(await screen.findByText("Current connection")).toBeInTheDocument();
        expect(screen.getByText("Test browser")).toBeInTheDocument();
        expect(await screen.findByText("thinkpad-x1")).toBeInTheDocument();
        expect(screen.getByText("linux")).toBeInTheDocument();
        expect(screen.getByText("0.4.2")).toBeInTheDocument();
        expect(screen.getByText("3h 0m")).toBeInTheDocument();
        expect(screen.getByText("Read")).toBeInTheDocument();
        expect(screen.getByText("Steer")).toBeInTheDocument();
        expect(screen.queryByText("Apply")).not.toBeInTheDocument();
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

describe("parsePairLink", () => {
    it("parses pi2:// pair links", () => {
        expect(parsePairLink("pi2://pair?host=192.168.2.10&port=4321&code=ABCD1234")).toEqual({
            endpoint: "http://192.168.2.10:4321",
            code: "ABCD1234",
            name: "192.168.2.10",
            hostname: "192.168.2.10",
            port: 4321,
        });
        expect(parsePairLink("pi2://pair?host=pi2.local&port=8443&proto=https&code=abcd1234&name=Desk")).toMatchObject({
            endpoint: "https://pi2.local:8443",
            code: "ABCD1234",
            name: "Desk",
        });
        expect(parsePairLink("pi2://pair?host=192.168.2.10:9000&code=ABCD1234")).toMatchObject({
            endpoint: "http://192.168.2.10:9000",
        });
    });

    it("parses http(s) /pair/<CODE> links", () => {
        expect(parsePairLink("https://192.168.2.10:4321/pair/ABCD1234")).toMatchObject({
            endpoint: "https://192.168.2.10:4321",
            code: "ABCD1234",
            hostname: "192.168.2.10",
            port: 4321,
        });
        expect(parsePairLink("/pair/abcd1234", "http://192.168.2.10:4321")).toMatchObject({
            endpoint: "http://192.168.2.10:4321",
            code: "ABCD1234",
        });
    });

    it("parses #pair=, ?pair= and ?code= against the typed endpoint", () => {
        for (const raw of ["#pair=ABCD1234", "?pair=ABCD1234", "?code=ABCD1234"]) {
            expect(parsePairLink(raw, "http://192.168.2.10:4321"), raw).toMatchObject({
                endpoint: "http://192.168.2.10:4321",
                code: "ABCD1234",
                hostname: "192.168.2.10",
            });
        }
        expect(parsePairLink("https://192.168.2.11:4321/#pair=ABCD1234&name=Pi")).toMatchObject({
            endpoint: "https://192.168.2.11:4321",
            code: "ABCD1234",
            name: "Pi",
        });
    });

    it("rejects payloads without a code or an address", () => {
        expect(parsePairLink("")).toBeNull();
        expect(parsePairLink("#pair=")).toBeNull();
        expect(parsePairLink("not a link")).toBeNull();
        expect(parsePairLink("pi2://pair?code=ABCD1234")).toBeNull();
        expect(parsePairLink("https://192.168.2.10:4321/pair/")).toBeNull();
    });
});

describe("pairing helpers", () => {
    it("normalizes pairing codes to 8 uppercase alphanumerics", () => {
        expect(normalizePairCode(" abcd-1234 ")).toBe("ABCD1234");
        expect(normalizePairCode("")).toBe("");
        expect(isPairCode("ABCD1234")).toBe(true);
        expect(isPairCode("abcd 1234")).toBe(true);
        expect(isPairCode("ABCD123")).toBe(false);
        expect(isPairCode("ABCD12345")).toBe(false);
    });

    it("keeps allow-listed deep links across the pairing round trip", () => {
        expect(safePairNext("/chat/01a15368?workspace=ws-1")).toBe("/chat/01a15368?workspace=ws-1");
        expect(safePairNext("/workspace/ws-1")).toBe("/workspace/ws-1");
        expect(safePairNext("/status?tab=devices")).toBe("/status?tab=devices");
        expect(safePairNext("/pair/ABCD1234")).toBe("/workspaces");
        expect(safePairNext("https://evil.example/x")).toBe("/workspaces");
        expect(safePairNext(null)).toBe("/workspaces");
    });
});
