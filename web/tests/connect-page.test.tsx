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

/** `POST <origin>/api/v1/pair/redeem` → `{token, device}` (the public redeem contract). */
function pairRoute(reply: { status?: number; body?: unknown } = {}): MockRoute {
    return {
        method: "POST",
        path: "/api/v1/pair/redeem",
        handler: () => ({
            status: reply.status ?? 200,
            body: reply.body ?? {
                token: "pkt_test",
                device: {
                    id: "dev-7c1",
                    name: "My browser",
                    kind: "laptop",
                    lastSeenAt: 1_700_000_000_000,
                },
            },
        }),
    };
}

interface PairCall {
    origin: string;
    path: string;
    body: Record<string, unknown>;
}

/** Every recorded `POST` to the pairing surface (mint or redeem). */
function pairCalls(fetchMock: ReturnType<typeof mockApi>): PairCall[] {
    return fetchMock.mock.calls
        .filter(([input, init]) => {
            const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const path = new URL(raw, "http://localhost").pathname;
            return path.startsWith("/api/v1/pair") && (init?.method ?? "GET") === "POST";
        })
        .map(([input, init]) => {
            const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            const url = new URL(raw, "http://localhost");
            return {
                origin: url.origin,
                path: url.pathname,
                body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
            };
        });
}

function redeemCalls(fetchMock: ReturnType<typeof mockApi>): PairCall[] {
    return pairCalls(fetchMock).filter((call) => call.path === "/api/v1/pair/redeem");
}

function fillManualForm(values: { host?: string; port?: string; code?: string; device?: string; link?: string }) {
    if (values.link !== undefined) fireEvent.change(screen.getByTestId("connect-link"), { target: { value: values.link } });
    if (values.host !== undefined) fireEvent.change(screen.getByTestId("connect-host"), { target: { value: values.host } });
    if (values.port !== undefined) fireEvent.change(screen.getByTestId("connect-port"), { target: { value: values.port } });
    if (values.code !== undefined) {
        fireEvent.change(screen.getByTestId("connect-pair-code"), { target: { value: values.code } });
    }
    if (values.device !== undefined) {
        fireEvent.change(screen.getByTestId("connect-device"), { target: { value: values.device } });
    }
}

/** Every `.btn--primary` currently rendered — the page keeps exactly one. */
function primaries(): Element[] {
    return [...document.querySelectorAll(".btn--primary")];
}

beforeEach(async () => {
    await setLanguage("en");
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("ConnectPage", () => {
    it("renders the brand story beside the pairing card in a two-column shell", async () => {
        mockApi([pairRoute()]);
        await renderPage(routes(), "/connect", { paired: false });

        expect(document.querySelector(".cn > .cn-shell")).not.toBeNull();
        expect(document.querySelector(".cn-shell > .cn-hero")).not.toBeNull();
        expect(document.querySelector(".cn-shell > .cn-col")).not.toBeNull();
        expect(screen.getByRole("heading", { level: 1, name: "Connect your pi2" })).toBeInTheDocument();
        expect(screen.getByText("Workspaces and sessions in real time")).toBeInTheDocument();
        expect(screen.getByText("Token stays on this device")).toBeInTheDocument();
        // The card is the quiet variant (1px --border-subtle, 18/20px padding).
        expect(document.querySelector(".cn-col .cn-card.card--quiet")).not.toBeNull();
    });

    it("keeps the manual form expanded as the single primary action", async () => {
        mockApi([pairRoute()]);
        await renderPage(routes(), "/connect", { paired: false });

        // The camera scanner is gone: the form is the only path and it is open.
        expect(screen.queryByTestId("connect-scan")).toBeNull();
        const panel = screen.getByTestId("connect-manual-panel");
        expect(panel).not.toHaveAttribute("hidden");
        expect(screen.getByTestId("connect-submit")).toHaveClass("btn--primary");
        expect(primaries()).toHaveLength(1);
        expect(screen.getByTestId("connect-host")).toHaveFocus();
    });

    it("defaults the port to the port this console was served from, never a literal", async () => {
        mockApi([pairRoute()]);
        await renderPage(routes(), "/connect", { paired: false });

        const port = screen.getByTestId("connect-port");
        const servedPort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
        expect(port).toHaveValue(servedPort);
        expect(port).not.toHaveValue("4321");
    });

    it("prefers the loaded daemon port for the manual form", async () => {
        mockApi([
            { path: "/api/v1/info", handler: () => ({ body: { ...infoBody, port: 7676 } }) },
            pairRoute(),
        ]);
        await renderPage(routes(), "/connect", {
            paired: true,
            storage: { "pi2-device": "Test browser", "pi2-endpoint": "http://192.168.2.10:4321" },
        });

        await waitFor(() => expect(screen.getByTestId("connect-repair")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("connect-repair"));
        await waitFor(() => expect(screen.getByTestId("connect-port")).toHaveValue("7676"));
    });

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

    it("prefills host, port and code from a pasted pi2:// pairing link", async () => {
        mockApi([pairRoute()]);
        await renderPage(routes(), "/connect", { paired: false });

        fillManualForm({ link: "pi2://pair?host=192.168.2.10&port=4321&code=AB-CD-12-34" });
        expect(screen.getByTestId("connect-host")).toHaveValue("192.168.2.10");
        expect(screen.getByTestId("connect-port")).toHaveValue("4321");
        expect(screen.getByTestId("connect-pair-code")).toHaveValue("ABCD1234");
    });

    it("prefills from a pasted /pair/CODE link and reports an unparseable one", async () => {
        mockApi([pairRoute()]);
        await renderPage(routes(), "/connect", { paired: false });

        fillManualForm({ link: "/pair/ABCD1234" });
        expect(screen.getByTestId("connect-host")).toHaveValue(window.location.hostname);
        expect(screen.getByTestId("connect-port")).toHaveValue(window.location.port);
        expect(screen.getByTestId("connect-pair-code")).toHaveValue("ABCD1234");

        fillManualForm({ link: "https://example.invalid/nothing-here" });
        fireEvent.click(screen.getByTestId("connect-submit"));
        expect(
            await screen.findByText("Could not parse it. Paste the full pi2://pair link."),
        ).toBeInTheDocument();
    });

    it("redeems a manual pairing against /api/v1/pair/redeem, stores the token and redirects", async () => {
        const fetchMock = mockApi([pairRoute()]);
        const { router } = await renderPage(routes(), "/connect", { paired: false });

        fillManualForm({ host: "192.168.2.10", port: "4321", code: "abcd1234", device: "My browser" });
        fireEvent.click(screen.getByTestId("connect-submit"));

        await waitFor(() => expect(localStorage.getItem("pi2-device-token")).toBe("Bearer pkt_test"));
        expect(localStorage.getItem("pi2-endpoint")).toBe("http://192.168.2.10:4321");
        expect(localStorage.getItem("pi2-connection")).toBe("paired");

        const calls = redeemCalls(fetchMock);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.origin).toBe("http://192.168.2.10:4321");
        expect(calls[0]?.body).toEqual({ code: "ABCD1234", kind: "laptop", deviceName: "My browser" });
        // The mint path is not the redeem path anymore.
        expect(pairCalls(fetchMock).filter((call) => call.path === "/api/v1/pair")).toHaveLength(0);

        await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces"));
        expect(await screen.findByText("Workspaces destination")).toBeInTheDocument();
    });

    it("pairs automatically from a scanned /pair/<CODE> link, with no input", async () => {
        const fetchMock = mockApi([pairRoute()]);
        const origin = window.location.origin;
        const { router } = await renderPage(routes(), "/connect?code=ABCD1234&auto=1", { paired: false });

        // The form never appears: the link already carries host, port and code.
        expect(screen.queryByTestId("connect-host")).toBeNull();
        expect(screen.getByTestId("connect-auto")).toBeInTheDocument();

        await waitFor(() => expect(localStorage.getItem("pi2-connection")).toBe("paired"));
        expect(localStorage.getItem("pi2-device-token")).toBe("Bearer pkt_test");
        expect(localStorage.getItem("pi2-endpoint")).toBe(origin);

        const calls = redeemCalls(fetchMock);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.origin).toBe(origin);
        expect(calls[0]?.body).toEqual({ code: "ABCD1234", kind: "laptop", deviceName: "Web console" });

        await waitFor(() => expect(router.state.location.pathname).toBe("/workspaces"));
        // `code` and `auto` are consumed, not kept in the URL.
        expect(router.state.location.searchStr).toBe("");
        expect(await screen.findByText("Workspaces destination")).toBeInTheDocument();
    });

    it("falls back to the prefilled form when the automatic pairing is rejected", async () => {
        mockApi([
            pairRoute({
                status: 401,
                body: { code: "E_UNAUTHORIZED", message: "invalid or already used pairing code" },
            }),
        ]);
        const origin = new URL(window.location.origin);
        const { router } = await renderPage(routes(), "/connect?code=ZZZZ9999&auto=1", { paired: false });

        expect(await screen.findByTestId("connect-auto-error")).toHaveTextContent(
            "Pairing code is wrong or expired",
        );
        // Everything the link carried is prefilled — only a fresh code is needed.
        expect(screen.getByTestId("connect-manual-panel")).not.toHaveAttribute("hidden");
        expect(screen.getByTestId("connect-pair-code")).toHaveValue("ZZZZ9999");
        expect(screen.getByTestId("connect-host")).toHaveValue(origin.hostname);
        expect(screen.getByTestId("connect-port")).toHaveValue(origin.port);
        expect(localStorage.getItem("pi2-connection")).toBeNull();
        expect(localStorage.getItem("pi2-device-token")).toBeNull();
        expect(router.state.location.pathname).toBe("/connect");
    });

    it("returns to an allow-listed deep link after pairing", async () => {
        const fetchMock = mockApi([pairRoute()]);
        const { router } = await renderPage(routes(), "/connect?next=%2Fchat%2F01a15368%3Fworkspace%3Dws-1", {
            paired: false,
        });

        fillManualForm({ host: "192.168.2.10", port: "4321", code: "ABCD1234", device: "My browser" });
        fireEvent.click(screen.getByTestId("connect-submit"));

        await waitFor(() => expect(router.state.location.pathname).toBe("/chat/01a15368"));
        expect(router.state.location.search).toMatchObject({ workspace: "ws-1" });
        expect(redeemCalls(fetchMock)).toHaveLength(1);
    });

    it("shows a localized inline error for a wrong or expired code and stays unpaired", async () => {
        mockApi([
            pairRoute({
                status: 401,
                body: { code: "E_UNAUTHORIZED", message: "invalid or already used pairing code" },
            }),
        ]);
        const { router } = await renderPage(routes(), "/connect", { paired: false });

        fillManualForm({ host: "192.168.2.10", port: "4321", code: "ZZZZ9999", device: "My browser" });
        fireEvent.click(screen.getByTestId("connect-submit"));

        expect(
            await screen.findByText("Pairing code is wrong or expired. Create a new code on the server."),
        ).toBeInTheDocument();
        expect(localStorage.getItem("pi2-device-token")).toBeNull();
        expect(localStorage.getItem("pi2-connection")).toBeNull();
        expect(router.state.location.pathname).toBe("/connect");
        expect(screen.getByTestId("connect-submit")).toBeEnabled();
    });

    it("shows the connected summary with server identity and one primary", async () => {
        mockApi([{ path: "/api/v1/info", handler: () => ({ body: infoBody }) }]);
        await renderPage(routes(), "/connect", {
            paired: true,
            storage: {
                "pi2-device": "Test browser",
                "pi2-endpoint": "http://192.168.2.10:4321",
            },
        });

        const state = document.querySelector(".cn-state.card--quiet");
        expect(state).not.toBeNull();
        expect(await screen.findByText("thinkpad-x1")).toBeInTheDocument();
        expect(screen.getByText("http://192.168.2.10:4321")).toBeInTheDocument();
        expect(screen.getByText("0.4.2")).toBeInTheDocument();
        expect(screen.getByText("Test browser")).toBeInTheDocument();
        // Scopes are gone from the console entirely.
        expect(screen.queryByText("Scopes")).not.toBeInTheDocument();
        expect(screen.queryByText("Read")).not.toBeInTheDocument();

        // Back to workspaces is the single primary while the re-pair panel is closed.
        expect(screen.getByTestId("connect-back")).toHaveClass("btn--primary");
        expect(primaries()).toHaveLength(1);
        // The token lives in the collapsed connection details, masked.
        expect(screen.getByText("Connection details")).toBeInTheDocument();
        expect(document.querySelector(".cn-details__body")?.textContent).toContain("…");
    });

    it("re-pairs in place and hands the single primary to the form, then back", async () => {
        mockApi([{ path: "/api/v1/info", handler: () => ({ body: infoBody }) }]);
        await renderPage(routes(), "/connect", {
            paired: true,
            storage: { "pi2-device": "Test browser", "pi2-endpoint": "http://192.168.2.10:4321" },
        });

        const repair = await screen.findByTestId("connect-repair");
        fireEvent.click(repair);
        const panel = screen.getByTestId("connect-repair-panel");
        expect(panel).not.toHaveAttribute("hidden");
        expect(screen.getByTestId("connect-submit")).toHaveClass("btn--primary");
        expect(screen.getByTestId("connect-back")).not.toHaveClass("btn--primary");
        expect(primaries()).toHaveLength(1);

        // Collapsing the panel returns the primary to "back to workspaces".
        fireEvent.click(repair);
        expect(panel).toHaveAttribute("hidden");
        expect(screen.getByTestId("connect-back")).toHaveClass("btn--primary");
        expect(primaries()).toHaveLength(1);
    });

    it("clears storage on confirmed disconnect and returns to the unconnected state", async () => {
        mockApi([{ path: "/api/v1/info", handler: () => ({ body: infoBody }) }]);
        await renderPage(routes(), "/connect", {
            paired: true,
            storage: { "pi2-device": "Test browser", "pi2-endpoint": "http://192.168.2.10:4321" },
        });

        expect(await screen.findByText("Test browser")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
        const dialog = await screen.findByRole("dialog");
        fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));

        await waitFor(() => expect(localStorage.getItem("pi2-device-token")).toBeNull());
        expect(localStorage.getItem("pi2-connection")).toBe("unpaired");
        expect(await screen.findByRole("heading", { name: "Connect your pi2 server" })).toBeInTheDocument();
        expect(screen.queryByText("Current connection")).not.toBeInTheDocument();
        expect(screen.getByTestId("connect-submit")).toHaveClass("btn--primary");
        expect(primaries()).toHaveLength(1);
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

    it("falls back to the served port (never a literal) when a link omits one", () => {
        const servedPort = window.location.port || (window.location.protocol === "https:" ? "443" : "80");
        expect(parsePairLink("pi2://pair?host=pi2.local&code=ABCD1234")).toMatchObject({
            endpoint: `http://pi2.local:${servedPort}`,
        });
        expect(parsePairLink("pi2://pair?host=pi2.local&proto=https&code=ABCD1234")).toMatchObject({
            endpoint: `https://pi2.local:${servedPort}`,
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
