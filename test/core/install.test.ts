import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    defaultStaticDir,
    executablePath,
    isBundledRuntime,
    runtimeDescription,
    staticDirCandidates,
    version,
} from "../../src/core/install.js";

describe("install helpers", () => {
    it("reports version matching package.json when running from a checkout", () => {
        const pkgPath = fileURLToPath(new URL("../../package.json", import.meta.url));
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
        expect(version()).toBe(pkg.version);
    });

    it("returns three absolute candidates with share/pi2d/web/dist first", () => {
        const candidates = staticDirCandidates();
        expect(candidates).toHaveLength(3);
        for (const candidate of candidates) {
            expect(isAbsolute(candidate)).toBe(true);
        }
        const exeDir = dirname(executablePath());
        const expectedFirst = resolve(exeDir, "..", "share", "pi2d", "web", "dist");
        expect(candidates[0]).toBe(expectedFirst);
    });

    it("resolves defaultStaticDir without throwing and returns dev checkout web/dist", () => {
        expect(() => defaultStaticDir()).not.toThrow();
        const dir = defaultStaticDir();
        expect(isAbsolute(dir)).toBe(true);
        const expectedDevPath = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
        expect(dir).toBe(expectedDevPath);
    });

    it("reports isBundledRuntime as false under vitest", () => {
        expect(isBundledRuntime()).toBe(false);
    });

    it("reports runtimeDescription starting with 'node '", () => {
        expect(runtimeDescription().startsWith("node ")).toBe(true);
    });
});
