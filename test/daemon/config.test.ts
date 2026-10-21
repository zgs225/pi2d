import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("loadConfig", () => {
    it("uses protocol defaults", () => {
        const config = loadConfig({});
        expect(config.host).toBe("127.0.0.1");
        expect(config.port).toBe(7676);
        expect(config.staticDir).toBe(join(repoRoot, "web", "dist"));
        expect(config.corsOrigins).toEqual(["http://127.0.0.1:7676", "http://localhost:7676"]);
        expect(config.limits.maxBodyBytes).toBe(8 * 1024 * 1024);
        expect(config.limits.maxFrameBytes).toBe(8 * 1024 * 1024);
        expect(config.limits.maxConnections).toBe(64);
        expect(config.tokenPath).toMatch(/d\.sock\.token$/);
        expect(config.deviceStorePath).toMatch(/devices\.json$/);
    });

    it("honours environment overrides", () => {
        const config = loadConfig({
            PI2_PORT: "0",
            PI2_HOST: "0.0.0.0",
            PI2_STATIC_DIR: "/srv/pi2/web",
            PI2_ORIGINS: "http://a.test, http://b.test ,,",
        });
        expect(config.port).toBe(0);
        expect(config.host).toBe("0.0.0.0");
        expect(config.staticDir).toBe("/srv/pi2/web");
        expect(config.corsOrigins).toEqual(["http://a.test", "http://b.test"]);
    });

    it("rejects invalid ports", () => {
        expect(() => loadConfig({ PI2_PORT: "-1" })).toThrow(/PI2_PORT/);
        expect(() => loadConfig({ PI2_PORT: "abc" })).toThrow(/PI2_PORT/);
        expect(() => loadConfig({ PI2_PORT: "70000" })).toThrow(/PI2_PORT/);
    });

    it("derives default origins from the port", () => {
        const config = loadConfig({ PI2_PORT: "8080" });
        expect(config.corsOrigins).toEqual(["http://127.0.0.1:8080", "http://localhost:8080"]);
    });
});
