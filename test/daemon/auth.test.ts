import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, hashToken, isAllowedOrigin, timingSafeEqualHex } from "../../src/daemon/auth.js";
import { DaemonError } from "../../src/daemon/errors.js";

describe("auth device store", () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pi2-auth-"));
        path = join(dir, "devices.json");
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("creates a device, persists its hash and never leaks it", () => {
        const auth = new AuthStore({ path });
        const { token, device } = auth.createDevice({ name: "Pixel", kind: "phone" });

        expect(token.length).toBeGreaterThanOrEqual(40);
        expect(device.id).toMatch(/^dev-/);
        expect(device.name).toBe("Pixel");
        expect(device.kind).toBe("phone");
        expect((device as unknown as Record<string, unknown>).tokenHash).toBeUndefined();

        const persisted = JSON.parse(readFileSync(path, "utf8")) as {
            devices: { tokenHash: string; name: string }[];
        };
        expect(persisted.devices).toHaveLength(1);
        expect(persisted.devices[0]!.tokenHash).toBe(hashToken(token));
        expect(persisted.devices[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
        expect(statSync(path).mode & 0o777).toBe(0o600);

        const verified = auth.verifyToken(token);
        expect(verified).not.toBeNull();
        expect(verified!.id).toBe(device.id);
        expect((verified as unknown as Record<string, unknown>).tokenHash).toBeUndefined();
    });

    it("rejects unknown and tampered tokens", () => {
        const auth = new AuthStore({ path });
        const { token } = auth.createDevice({ name: "Laptop", kind: "laptop" });
        expect(auth.verifyToken("")).toBeNull();
        expect(auth.verifyToken("not-a-token")).toBeNull();
        expect(auth.verifyToken(token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"))).toBeNull();
    });

    it("persists devices across store reloads", () => {
        const first = new AuthStore({ path });
        const { token } = first.createDevice({ name: "Tablet", kind: "tablet" });

        const second = new AuthStore({ path });
        expect(second.verifyToken(token)?.name).toBe("Tablet");
        expect(second.listDevices()).toHaveLength(1);
    });

    it("revokes devices", () => {
        const auth = new AuthStore({ path });
        const { token, device } = auth.createDevice({ name: "Phone", kind: "phone" });

        expect(auth.revokeDevice(device.id)).toBe(true);
        expect(auth.verifyToken(token)).toBeNull();
        expect(auth.listDevices()[0]!.revokedAt).toBeTypeOf("number");
        expect(auth.revokeDevice(device.id)).toBe(false);
        expect(auth.revokeDevice("dev-unknown")).toBe(false);

        const reloaded = new AuthStore({ path });
        expect(reloaded.verifyToken(token)).toBeNull();
    });

    it("throttles touchDevice to 60 seconds", () => {
        let now = 1_000_000;
        const auth = new AuthStore({ path, now: () => now });
        const { device } = auth.createDevice({ name: "Phone", kind: "phone" });
        expect(device.lastSeenAt).toBe(now);

        now += 10_000;
        auth.touchDevice(device.id);
        expect(auth.listDevices()[0]!.lastSeenAt).toBe(1_000_000);

        now += 51_000;
        auth.touchDevice(device.id);
        expect(auth.listDevices()[0]!.lastSeenAt).toBe(1_061_000);

        now += 1_000;
        auth.touchDevice(device.id);
        expect(auth.listDevices()[0]!.lastSeenAt).toBe(1_061_000);
    });

    it("redeems a pairing code exactly once", () => {
        let now = 1_700_000_000_000;
        const auth = new AuthStore({ path, now: () => now });
        const pair = auth.pairCreate({ ttlSec: 600 });

        expect(pair.code).toMatch(/^[A-Z0-9]{8}$/);
        expect(pair.nonce).toMatch(/^[0-9a-f]+$/);
        expect(pair.expiresAt).toBe(now + 600_000);

        const redeemed = auth.pairRedeem({ code: pair.code, deviceName: "Pixel", kind: "phone" });
        expect(redeemed.device.name).toBe("Pixel");
        expect(redeemed.device.kind).toBe("phone");
        expect(auth.verifyToken(redeemed.token)?.id).toBe(redeemed.device.id);

        expect(() => auth.pairRedeem({ code: pair.code, deviceName: "Again", kind: "laptop" })).toThrow(DaemonError);
        expect(() => auth.pairRedeem({ code: "NOPE1234", deviceName: "Again", kind: "laptop" })).toThrow(/invalid|expired|used/i);
    });

    it("expires pairing codes", () => {
        let now = 1_700_000_000_000;
        const auth = new AuthStore({ path, now: () => now });
        const pair = auth.pairCreate({ ttlSec: 1 });
        now += 1_001;
        expect(() => auth.pairRedeem({ code: pair.code, deviceName: "Pixel", kind: "phone" })).toThrow(/expired/i);
    });

    it("compares token hashes in constant time", () => {
        const a = hashToken("token-a");
        expect(timingSafeEqualHex(a, a)).toBe(true);
        expect(timingSafeEqualHex(a, hashToken("token-b"))).toBe(false);
        expect(timingSafeEqualHex(a, a.slice(0, 10))).toBe(false);
        expect(timingSafeEqualHex("", "")).toBe(true);
    });
});

describe("local browser session", () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pi2-auth-browser-"));
        path = join(dir, "devices.json");
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("creates exactly one local-browser device", () => {
        const auth = new AuthStore({ path, now: () => 1_000 });
        const session = auth.localBrowserSession();

        expect(session.device.name).toBe("local browser");
        expect(session.device.kind).toBe("laptop");
        expect(session.device.createdAt).toBe(1_000);
        expect(session.device.lastSeenAt).toBe(1_000);
        expect(session.device.revokedAt).toBeNull();
        expect(auth.listDevices()).toHaveLength(1);
        expect(auth.verifyToken(session.token)?.id).toBe(session.device.id);
    });

    it("reuses the same token across logins, so a second :PiWeb keeps the open tab alive", () => {
        const auth = new AuthStore({ path, now: () => 2_000 });
        const first = auth.localBrowserSession();
        const second = auth.localBrowserSession();

        expect(second.token).toBe(first.token);
        expect(second.device.id).toBe(first.device.id);
        expect(auth.verifyToken(first.token)?.id).toBe(first.device.id);
        expect(auth.listDevices()).toHaveLength(1);

        const persisted = JSON.parse(readFileSync(path, "utf8")) as {
            devices: { tokenHash: string; name: string }[];
        };
        expect(persisted.devices).toHaveLength(1);
        expect(persisted.devices[0]!.tokenHash).toBe(hashToken(first.token));

        const tokenPath = join(dir, "local-browser.token");
        expect(readFileSync(tokenPath, "utf8").trim()).toBe(first.token);
        expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    });

    it("mints a new token once the device is revoked", () => {
        const auth = new AuthStore({ path, now: () => 3_000 });
        const first = auth.localBrowserSession();
        expect(auth.revokeDevice(first.device.id)).toBe(true);
        expect(auth.verifyToken(first.token)).toBeNull();

        const second = auth.localBrowserSession();
        expect(second.device.id).toBe(first.device.id);
        expect(second.device.revokedAt).toBeNull();
        expect(second.token).not.toBe(first.token);
        expect(auth.verifyToken(first.token)).toBeNull();
        expect(auth.verifyToken(second.token)?.revokedAt).toBeNull();
    });

    it("mints a new token when the stored plaintext is missing or stale", () => {
        const auth = new AuthStore({ path, now: () => 4_000 });
        const first = auth.localBrowserSession();

        unlinkSync(join(dir, "local-browser.token"));
        const second = auth.localBrowserSession();
        expect(second.token).not.toBe(first.token);
        expect(auth.verifyToken(second.token)?.id).toBe(first.device.id);
        expect(auth.listDevices()).toHaveLength(1);
    });

    it("survives a store reload with the same token", () => {
        const first = new AuthStore({ path });
        const session = first.localBrowserSession();
        const reloaded = new AuthStore({ path });
        expect(reloaded.verifyToken(session.token)?.name).toBe("local browser");
        const again = reloaded.localBrowserSession();
        expect(again.token).toBe(session.token);
        expect(again.device.id).toBe(session.device.id);
        expect(reloaded.listDevices()).toHaveLength(1);
    });
});

describe("isAllowedOrigin", () => {
    const allow = ["http://127.0.0.1:7676", "http://localhost:7676"];

    it("permits non-browser requests", () => {
        expect(isAllowedOrigin(undefined, allow)).toBe(true);
        expect(isAllowedOrigin("", allow)).toBe(true);
    });

    it("permits allow-listed origins (including a trailing slash)", () => {
        expect(isAllowedOrigin("http://127.0.0.1:7676", allow)).toBe(true);
        expect(isAllowedOrigin("http://127.0.0.1:7676/", allow)).toBe(true);
        expect(isAllowedOrigin("http://localhost:7676", allow)).toBe(true);
    });

    it("rejects unknown origins, schemes and ports", () => {
        expect(isAllowedOrigin("http://evil.test", allow)).toBe(false);
        expect(isAllowedOrigin("https://127.0.0.1:7676", allow)).toBe(false);
        expect(isAllowedOrigin("http://127.0.0.1:9999", allow)).toBe(false);
        expect(isAllowedOrigin("http://localhost:7676", [])).toBe(false);
    });
});
