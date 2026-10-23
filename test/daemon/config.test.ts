import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const LOOPBACK = (port: number): string[] => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
];

describe("loadConfig", () => {
    it("uses protocol defaults (access mode local)", () => {
        const config = loadConfig({});
        expect(config.host).toBe("127.0.0.1");
        expect(config.port).toBe(7676);
        expect(config.access).toBe("local");
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
        const config = loadConfig({
            PI2_PORT: "0",
            PI2_HOST: "0.0.0.0",
            PI2_STATIC_DIR: "/srv/pi2/web",
            PI2_ORIGINS: "http://a.test, http://b.test ,,",
        });
        expect(config.port).toBe(0);
        expect(config.host).toBe("0.0.0.0");
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

    it("derives loopback origins from the port", () => {
        const config = loadConfig({ PI2_PORT: "8080" });
        expect(config.corsOrigins).toEqual(LOOPBACK(8080));
    });

    it("derives local mode origins without a LAN address", () => {
        const config = loadConfig(
            { PI2_ACCESS_MODE: "local" },
            { detectLanIp: () => "192.168.2.10" },
        );
        expect(config.access).toBe("local");
        expect(config.host).toBe("127.0.0.1");
        expect(config.corsOrigins).toEqual(LOOPBACK(7676));
    });

    it("lan mode binds 0.0.0.0 and adds the detected LAN origin", () => {
        const config = loadConfig(
            { PI2_ACCESS_MODE: "lan" },
            { detectLanIp: () => "192.168.2.10" },
        );
        expect(config.access).toBe("lan");
        expect(config.host).toBe("0.0.0.0");
        expect(config.corsOrigins).toEqual([...LOOPBACK(7676), "http://192.168.2.10:7676"]);
    });

    it("lan mode skips the extra origin when detection fails or throws", () => {
        expect(
            loadConfig({ PI2_ACCESS_MODE: "lan" }, { detectLanIp: () => null }).corsOrigins,
        ).toEqual(LOOPBACK(7676));
        expect(
            loadConfig(
                { PI2_ACCESS_MODE: "lan" },
                {
                    detectLanIp: () => {
                        throw new Error("no interfaces");
                    },
                },
            ).corsOrigins,
        ).toEqual(LOOPBACK(7676));
    });

    it("tailscale mode stays on loopback and adds the public URL origin", () => {
        const config = loadConfig({
            PI2_ACCESS_MODE: "tailscale",
            PI2_PUBLIC_URL: "https://myhost.tail1234.ts.net/",
        });
        expect(config.access).toBe("tailscale");
        expect(config.host).toBe("127.0.0.1");
        expect(config.publicUrl).toBe("https://myhost.tail1234.ts.net");
        expect(config.corsOrigins).toEqual([...LOOPBACK(7676), "https://myhost.tail1234.ts.net"]);
    });

    it("tailscale without PI2_PUBLIC_URL keeps only loopback origins", () => {
        const config = loadConfig({ PI2_ACCESS_MODE: "tailscale" });
        expect(config.publicUrl).toBeNull();
        expect(config.corsOrigins).toEqual(LOOPBACK(7676));
    });

    it("lets PI2_HOST win over the mode default", () => {
        expect(loadConfig({ PI2_ACCESS_MODE: "lan", PI2_HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
        expect(loadConfig({ PI2_ACCESS_MODE: "tailscale", PI2_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
        expect(loadConfig({ PI2_ACCESS_MODE: "local", PI2_HOST: "192.168.2.5" }).host).toBe("192.168.2.5");
    });

    it("normalizes and de-duplicates explicit origins", () => {
        const config = loadConfig({
            PI2_ORIGINS: "https://a.test/, http://127.0.0.1:7676, ,http://a.test",
        });
        expect(config.corsOrigins).toEqual([...LOOPBACK(7676), "https://a.test", "http://a.test"]);
    });

    it("fails fast on an unknown access mode", () => {
        expect(() => loadConfig({ PI2_ACCESS_MODE: "public" })).toThrow(
            "PI2_ACCESS_MODE must be local, lan or tailscale",
        );
    });
});
