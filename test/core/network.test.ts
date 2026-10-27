import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";

import {
    classifyAddress,
    isLoopbackHost,
    isVirtualInterface,
    isWildcardHost,
    localOrigins,
    networkBases,
    primaryBase,
} from "../../src/core/network.js";

const ipv4 = (address: string, overrides: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo => ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
    ...overrides,
});

const HOST: NodeJS.Dict<NetworkInterfaceInfo[]> = {
    lo: [ipv4("127.0.0.1", { internal: true })],
    wlan0: [ipv4("192.168.11.7")],
    docker0: [ipv4("172.17.0.1")],
    eth1: [ipv4("203.0.113.9")],
    tailscale0: [ipv4("100.64.0.14")],
    "br-1234": [ipv4("172.18.0.1")],
};

describe("address classification", () => {
    it("maps an interface to the base kind a human would expect", () => {
        expect(classifyAddress("wlan0", "192.168.11.7")).toBe("lan");
        expect(classifyAddress("eth1", "203.0.113.9")).toBe("other");
        expect(classifyAddress("tailscale0", "100.64.0.14")).toBe("tailscale");
        expect(classifyAddress("utun3", "10.1.2.3")).toBe("lan");
        expect(classifyAddress("lo", "127.0.0.1")).toBe("loopback");
    });

    it("recognises loopback and wildcard binds", () => {
        for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost", ""]) {
            expect(isLoopbackHost(host), host).toBe(true);
        }
        for (const host of ["0.0.0.0", "::", "", "[::]"]) {
            expect(isWildcardHost(host), host).toBe(true);
        }
        expect(isLoopbackHost("0.0.0.0")).toBe(false);
        expect(isWildcardHost("192.168.11.7")).toBe(false);
    });

    it("treats container and tunnel interfaces as virtual", () => {
        for (const name of ["docker0", "veth1234", "br-1234", "virbr0", "tun0", "wg0", "tailscale0"]) {
            expect(isVirtualInterface(name), name).toBe(true);
        }
        for (const name of ["wlan0", "eth0", "enp3s0", "wlp2s0"]) {
            expect(isVirtualInterface(name), name).toBe(false);
        }
    });
});

describe("networkBases", () => {
    it("orders public → lan → other → tailscale, physical before virtual", () => {
        const bases = networkBases({ port: 7676, bindHost: "0.0.0.0", interfaces: HOST });
        expect(bases.map((base) => `${base.kind}:${base.name}`)).toEqual([
            "lan:wlan0",
            "lan:br-1234",
            "lan:docker0",
            "other:eth1",
            "tailscale:tailscale0",
            "loopback:loopback",
        ]);
        expect(bases[0]!.url).toBe("http://192.168.11.7:7676");
    });

    it("puts the configured public URL first", () => {
        const bases = networkBases({
            port: 7676,
            bindHost: "0.0.0.0",
            publicUrl: "https://host.tail1234.ts.net/",
            interfaces: HOST,
        });
        expect(bases[0]).toEqual({
            kind: "public",
            name: "public-url",
            address: "",
            url: "https://host.tail1234.ts.net",
        });
    });

    it("skips link-local addresses entirely", () => {
        const bases = networkBases({
            port: 7676,
            bindHost: "0.0.0.0",
            interfaces: { eth0: [ipv4("169.254.10.1")] },
        });
        expect(bases.map((base) => base.kind)).toEqual(["loopback"]);
    });

    it("advertises only loopback for a loopback bind but keeps the public URL", () => {
        expect(networkBases({ port: 7676, bindHost: "127.0.0.1", interfaces: HOST })).toEqual([
            { kind: "loopback", name: "loopback", address: "127.0.0.1", url: "http://127.0.0.1:7676" },
        ]);
        const withPublic = networkBases({
            port: 7676,
            bindHost: "127.0.0.1",
            publicUrl: "https://host.ts.net",
            interfaces: HOST,
        });
        expect(withPublic.map((base) => base.kind)).toEqual(["public", "loopback"]);
    });

    it("advertises the pinned address plus loopback for a specific bind", () => {
        const bases = networkBases({ port: 7676, bindHost: "192.168.11.7", interfaces: HOST });
        expect(bases.map((base) => base.url)).toEqual(["http://192.168.11.7:7676", "http://127.0.0.1:7676"]);
    });

    it("falls back to loopback when the host has no NICs", () => {
        const bases = networkBases({ port: 7676, bindHost: "0.0.0.0", interfaces: {} });
        expect(bases).toEqual([
            { kind: "loopback", name: "loopback", address: "127.0.0.1", url: "http://127.0.0.1:7676" },
        ]);
    });

    it("picks the first base as the default advertisement", () => {
        expect(primaryBase({ port: 7676, bindHost: "0.0.0.0", interfaces: HOST }).url).toBe("http://192.168.11.7:7676");
        expect(primaryBase({ port: 7676, bindHost: "127.0.0.1", interfaces: HOST }).url).toBe("http://127.0.0.1:7676");
    });
});

describe("localOrigins", () => {
    it("covers every reachable address plus the loopback aliases", () => {
        const origins = localOrigins({ port: 8080, bindHost: "0.0.0.0", interfaces: HOST });
        expect(origins).toContain("http://192.168.11.7:8080");
        expect(origins).toContain("http://100.64.0.14:8080");
        expect(origins).toContain("http://127.0.0.1:8080");
        expect(origins).toContain("http://localhost:8080");
        expect(origins).toContain("http://[::1]:8080");
        expect(origins.some((origin) => origin.includes("169.254"))).toBe(false);
    });

    it("reduces the public URL to its origin", () => {
        const origins = localOrigins({
            port: 8080,
            bindHost: "0.0.0.0",
            publicUrl: "https://host.ts.net/some/path?x=1",
            interfaces: {},
        });
        expect(origins).toContain("https://host.ts.net");
        expect(origins).not.toContain("https://host.ts.net/some/path?x=1");
    });

    it("keeps a loopback bind private", () => {
        expect(localOrigins({ port: 8080, bindHost: "127.0.0.1", interfaces: HOST })).toEqual([
            "http://127.0.0.1:8080",
            "http://localhost:8080",
            "http://[::1]:8080",
        ]);
    });
});
