import { describe, expect, it } from "vitest";

import { resolveServerStatus, type ServerStatusInput } from "@/features/status/server";
import type { InfoResponse } from "@/lib/api";

/** Exact real payload shape from the daemon: no `status` field present. */
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

describe("resolveServerStatus", () => {
    it("resolves unpaired client to offline even when info is present", () => {
        const input: ServerStatusInput = {
            paired: false,
            info: realisticInfo,
            healthOk: true,
        };
        expect(resolveServerStatus(input)).toBe("offline");
        expect(resolveServerStatus({ paired: false })).toBe("offline");
        expect(resolveServerStatus({ paired: false, info: realisticInfo })).toBe("offline");
    });

    it("resolves infoError to offline, even with stale cached info", () => {
        const input: ServerStatusInput = {
            paired: true,
            infoError: true,
            healthOk: true,
        };
        expect(resolveServerStatus(input)).toBe("offline");
        expect(
            resolveServerStatus({
                paired: true,
                info: realisticInfo,
                infoError: true,
            }),
        ).toBe("offline");
    });

    it("resolves healthError to degraded even when info is present", () => {
        expect(
            resolveServerStatus({
                paired: true,
                info: realisticInfo,
                healthError: true,
            }),
        ).toBe("degraded");
    });

    it("resolves info present + healthOk === false to degraded", () => {
        const input: ServerStatusInput = {
            paired: true,
            info: realisticInfo,
            healthOk: false,
        };
        expect(resolveServerStatus(input)).toBe("degraded");
    });

    it("resolves info present in exact real payload shape (no status field) to online", () => {
        // Assert property absence so the regression contract is explicitly guarded.
        expect("status" in realisticInfo).toBe(false);

        expect(
            resolveServerStatus({
                paired: true,
                info: realisticInfo,
            }),
        ).toBe("online");

        expect(
            resolveServerStatus({
                paired: true,
                info: realisticInfo,
                healthOk: true,
            }),
        ).toBe("online");
    });

    it("resolves nothing yet to unknown", () => {
        expect(
            resolveServerStatus({
                paired: true,
            }),
        ).toBe("unknown");
    });

    it("resolves paired with info: null, healthOk: true to unknown", () => {
        expect(
            resolveServerStatus({
                paired: true,
                info: null,
                healthOk: true,
            }),
        ).toBe("unknown");
    });

    it("resolves paired with info: null, healthOk: null to unknown", () => {
        expect(
            resolveServerStatus({
                paired: true,
                info: null,
                healthOk: null,
            }),
        ).toBe("unknown");
    });
});
