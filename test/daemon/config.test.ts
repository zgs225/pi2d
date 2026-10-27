import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NetworkInterfaceInfo } from "node:os";
import { DEFAULT_HOST, loadConfig } from "../../src/config.js";
import { localOrigins } from "../../src/core/network.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LOOPBACK = (port: number): string[] => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
];

const ipv4 = (address: string, overrides: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo => ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
    ...overrides,
});

describe("loadConfig", () => {
    it("uses protocol defaults and binds every interface", () => {
        const config = loadConfig({}, { interfaces: {} });
        expect(DEFAULT_HOST).toBe("0.0.0.0");
        expect(config.host).toBe("0.0.0.0");
        expect(config.port).toBe(7676);
        expect(config.publicUrl).toBeNull();
        expect(config.staticDir).toBe(join(repoRoot, "web", "dist"));
        expect(config.corsOrigins).toEqual(LOOPBACK(7676));
        expect(config.limits.maxBodyBytes).toBe(8 * 1024 * 1024);
        expect(config.limits.maxFrameBytes).toBe(8 * 1024 * 1024);
        expect(config.limits.maxConnections).toBe(64);
        expect(config.tokenPath).toMatch(/d\.sock\.token$/);
        expect(config.deviceStorePath).toMatch(/devices\.json$/);
    });

    it("honours environment overrides; PI2_ORIGINS is additive", () => {
        const config = loadConfig(
            {
                PI2_PORT: "0",
                PI2_HOST: "127.0.0.1",
                PI2_STATIC_DIR: "/srv/pi2/web",
                PI2_ORIGINS: "http://a.test, http://b.test ,,",
            },
            { interfaces: {} },
        );
        expect(config.port).toBe(0);
        expect(config.host).toBe("127.0.0.1");
        expect(config.staticDir).toBe("/srv/pi2/web");
        // Loopback origins stay in place; the extras are appended, normalized,
        // and empty entries dropped.
        expect(config.corsOrigins).toEqual([...LOOPBACK(0), "http://a.test", "http://b.test"]);
    });

    it("rejects invalid ports", () => {
        expect(() => loadConfig({ PI2_PORT: "-1" })).toThrow(/PI2_PORT/);
        expect(() => loadConfig({ PI2_PORT: "abc" })).toThrow(/PI2_PORT/);
        expect(() => loadConfig({ PI2_PORT: "70000" })).toThrow(/PI2_PORT/);
    });

    it("allows every local IPv4 origin at the bound port", () => {
        const config = loadConfig(
            { PI2_PORT: "8080" },
            {
                interfaces: {
                    lo: [ipv4("127.0.0.1", { internal: true })],
                    wlan0: [ipv4("192.168.11.7"), ipv4("169.254.10.1")],
                    tailscale0: [ipv4("100.64.0.14")],
                },
            },
        );
        // Loopback aliases plus each reachable address; link-local is skipped.
        for (const origin of [...LOOPBACK(8080), "http://192.168.11.7:8080", "http://100.64.0.14:8080"]) {
            expect(config.corsOrigins).toContain(origin);
        }
        expect(config.corsOrigins).toHaveLength(LOOPBACK(8080).length + 2);
    });

    it("narrows the bind on PI2_HOST", () => {
        const config = loadConfig({ PI2_HOST: "127.0.0.1" }, { interfaces: { wlan0: [ipv4("192.168.11.7")] } });
        expect(config.host).toBe("127.0.0.1");
        // A loopback-only daemon is unreachable from the LAN, so the allowlist
        // must not advertise an address nothing is listening on.
        expect(config.corsOrigins).toEqual(LOOPBACK(7676));
    });

    it("adds the public URL origin and keeps loopback", () => {
        const config = loadConfig({ PI2_PUBLIC_URL: "https://myhost.tail1234.ts.net/" }, { interfaces: {} });
        expect(config.publicUrl).toBe("https://myhost.tail1234.ts.net");
        expect(config.corsOrigins).toContain("https://myhost.tail1234.ts.net");
        for (const origin of LOOPBACK(7676)) expect(config.corsOrigins).toContain(origin);
    });

    it("normalizes and de-duplicates explicit origins", () => {
        const config = loadConfig(
            { PI2_ORIGINS: "https://a.test/, http://127.0.0.1:7676, ,http://a.test" },
            { interfaces: {} },
        );
        expect(config.corsOrigins.filter((origin) => origin.endsWith("a.test"))).toEqual([
            "https://a.test",
            "http://a.test",
        ]);
        expect(config.corsOrigins.filter((origin) => origin === "http://127.0.0.1:7676")).toHaveLength(1);
    });

    it("derives only loopback origins for link-local addresses", () => {
        expect(
            localOrigins({ port: 7676, bindHost: "0.0.0.0", interfaces: { wlan0: [ipv4("169.254.10.1")] } }),
        ).toEqual(LOOPBACK(7676));
    });
});
