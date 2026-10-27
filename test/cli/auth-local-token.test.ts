import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStore, LOCAL_CLI_DEVICE_ID } from "../../src/daemon/auth.js";
import { writeCliToken } from "../../src/cli/token.js";
import { removeDir, tempDir } from "./helpers.js";

describe("AuthStore local CLI token", () => {
    let dir: string;
    let tokenPath: string;
    let storePath: string;

    beforeEach(() => {
        dir = tempDir("pi2-local-token-");
        tokenPath = join(dir, "cli.token");
        storePath = join(dir, "devices.json");
    });

    afterEach(() => removeDir(dir));

    it("accepts the token file contents as the synthetic admin device", () => {
        const token = writeCliToken(tokenPath);
        const auth = new AuthStore({ path: storePath, localTokenPath: tokenPath });

        const device = auth.verifyToken(token);
        expect(device).not.toBeNull();
        expect(device!.id).toBe(LOCAL_CLI_DEVICE_ID);
        expect(device!.id).toBe("local-cli");
        expect(device!.name).toBe("local CLI");
        expect(device!.revokedAt).toBeNull();
        expect((device as unknown as Record<string, unknown>).tokenHash).toBeUndefined();
    });

    it("tolerates a trailing newline in the token file", () => {
        const token = writeCliToken(tokenPath);
        writeFileSync(tokenPath, `${token}\n\n`, { mode: 0o600 });
        const auth = new AuthStore({ path: storePath, localTokenPath: tokenPath });
        expect(auth.verifyToken(token)?.id).toBe(LOCAL_CLI_DEVICE_ID);
    });

    it("rejects wrong, truncated, empty and missing tokens", () => {
        const token = writeCliToken(tokenPath);
        const auth = new AuthStore({ path: storePath, localTokenPath: tokenPath });

        expect(auth.verifyToken("")).toBeNull();
        expect(auth.verifyToken("not-a-token")).toBeNull();
        expect(auth.verifyToken(token.slice(0, -1))).toBeNull();
        expect(auth.verifyToken(token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"))).toBeNull();

        writeFileSync(tokenPath, "\n", { mode: 0o600 });
        expect(auth.verifyToken("")).toBeNull();
        expect(auth.verifyToken(token)).toBeNull();

        rmSync(tokenPath, { force: true });
        expect(auth.verifyToken(token)).toBeNull();
    });

    it("rotates: a rewritten token file invalidates the previous one", () => {
        const first = writeCliToken(tokenPath);
        const auth = new AuthStore({ path: storePath, localTokenPath: tokenPath });
        expect(auth.verifyToken(first)?.id).toBe(LOCAL_CLI_DEVICE_ID);

        const second = writeCliToken(tokenPath);
        expect(second).not.toBe(first);
        expect(auth.verifyToken(first)).toBeNull();
        expect(auth.verifyToken(second)?.id).toBe(LOCAL_CLI_DEVICE_ID);
    });

    it("keeps paired devices working and never lists the synthetic one", () => {
        writeCliToken(tokenPath);
        const auth = new AuthStore({ path: storePath, localTokenPath: tokenPath });
        const { token } = auth.createDevice({ name: "Pixel", kind: "phone" });

        expect(auth.verifyToken(token)?.name).toBe("Pixel");
        expect(auth.listDevices().map((device) => device.id)).not.toContain(LOCAL_CLI_DEVICE_ID);
        expect(auth.listDevices()).toHaveLength(1);

        // The synthetic device is not revocable; a paired device is.
        expect(auth.revokeDevice(LOCAL_CLI_DEVICE_ID)).toBe(false);
        expect(auth.revokeDevice(auth.listDevices()[0]!.id)).toBe(true);
        expect(auth.verifyToken(token)).toBeNull();
    });

    it("is inert without localTokenPath (existing API unchanged)", () => {
        const token = writeCliToken(tokenPath);
        const auth = new AuthStore({ path: storePath });
        expect(auth.localTokenPath).toBeUndefined();
        expect(auth.verifyToken(token)).toBeNull();
    });

    it("does not persist anything to the device store", () => {
        const token = writeCliToken(tokenPath);
        const auth = new AuthStore({ path: storePath, localTokenPath: tokenPath });
        auth.verifyToken(token);
        const reloaded = new AuthStore({ path: storePath, localTokenPath: tokenPath });
        expect(reloaded.listDevices()).toHaveLength(0);
        expect(reloaded.verifyToken(token)?.id).toBe(LOCAL_CLI_DEVICE_ID);
    });
});
