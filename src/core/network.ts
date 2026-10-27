/**
 * Where the daemon can be reached, and in which order to advertise it.
 *
 * The console is phone-first: the daemon binds `0.0.0.0` by default, so a phone
 * on the same network opens `http://<lan-ip>:<port>` and the browser sends an
 * `Origin` header the daemon has to allow. Both the CORS allowlist and the
 * pairing link need the same answer to "which addresses are we reachable on",
 * so they share this module instead of each sniffing `os.networkInterfaces()`.
 *
 * `interfaces` is injectable so ordering and classification stay testable
 * without the host's real NICs.
 */
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type NetworkBaseKind = "public" | "lan" | "other" | "tailscale" | "loopback";

export interface NetworkBase {
    kind: NetworkBaseKind;
    /** Interface name, `loopback`, or `public-url` for the configured base. */
    name: string;
    /** IPv4 address; empty for the `public-url` entry. */
    address: string;
    /** Base URL, no trailing slash and no credentials. */
    url: string;
}

export interface NetworkOptions {
    port: number;
    /** The configured bind address; decides what is reachable. Defaults to wildcard. */
    bindHost?: string;
    /** External base URL (e.g. behind `tailscale serve`). */
    publicUrl?: string | null;
    interfaces?: NodeJS.Dict<NetworkInterfaceInfo[]>;
}

/** Wildcard binds: everything on the host is reachable. */
export const WILDCARD_HOSTS: readonly string[] = ["", "0.0.0.0", "::", "[::]"];

/** Interfaces that never reach a phone sitting next to the machine. */
const VIRTUAL_INTERFACE = /^(docker|veth|br-|virbr|vmnet|vboxnet|tun|tap|utun|tailscale|zt|wg|bridge|dummy)/i;

/** Interfaces a human would recognise as "the network cable / wifi". */
const PHYSICAL_INTERFACE = /^(eth|en|wlan|wl|eno|ens|enp|wlp)/i;

const PRIVATE_IPV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** 100.64.0.0/10 — the tailnet range Tailscale hands out. */
const TAILSCALE_IPV4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** 169.254.0.0/16 — link-local, never reachable from another device. */
const LINK_LOCAL_IPV4 = /^169\.254\./;

const KIND_ORDER: Record<NetworkBaseKind, number> = {
    public: 0,
    lan: 1,
    other: 2,
    tailscale: 3,
    loopback: 4,
};

/** `127.0.0.1`, `::1`, `localhost` — only this machine can connect. */
export function isLoopbackHost(host: string | undefined | null): boolean {
    const value = (host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
    if (value === "" || value === "localhost") return true;
    if (value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
    return value.startsWith("127.");
}

/** `0.0.0.0` / `::` / empty: every interface. */
export function isWildcardHost(host: string | undefined | null): boolean {
    return WILDCARD_HOSTS.includes((host ?? "").trim().toLowerCase());
}

export function isVirtualInterface(name: string): boolean {
    return VIRTUAL_INTERFACE.test(name);
}

export function classifyAddress(name: string, address: string): NetworkBaseKind {
    if (address.startsWith("127.")) return "loopback";
    if (/^tailscale/i.test(name) || TAILSCALE_IPV4.test(address)) return "tailscale";
    if (PRIVATE_IPV4.test(address)) return "lan";
    return "other";
}

function isIPv4(entry: NetworkInterfaceInfo): boolean {
    // Node exposes `family` as a string ("IPv4") on modern versions and a number
    // (4) on older ones; accept both.
    return entry.family === "IPv4" || (entry.family as unknown as number) === 4;
}

function normalizeBase(raw: string): string {
    return raw.trim().replace(/\/+$/, "");
}

function originOf(url: string): string | null {
    try {
        return new URL(url).origin;
    } catch {
        return normalizeBase(url) === "" ? null : normalizeBase(url);
    }
}

/**
 * Every base a browser could use, best first.
 *
 * `bindHost` decides reachability: a loopback bind only advertises loopback (a
 * public URL still counts — `tailscale serve` proxies to the loopback port), a
 * specific address advertises that address plus loopback, and a wildcard bind
 * advertises everything the host has.
 */
export function networkBases(options: NetworkOptions): NetworkBase[] {
    const port = options.port;
    const bindHost = options.bindHost;
    const bases: NetworkBase[] = [];

    const publicUrl = normalizeBase(options.publicUrl ?? "");
    if (publicUrl !== "") bases.push({ kind: "public", name: "public-url", address: "", url: publicUrl });

    const loopback = (name: string, address: string): NetworkBase => ({
        kind: "loopback",
        name,
        address,
        url: `http://${address}:${port}`,
    });
    const wildcard = isWildcardHost(bindHost);

    if (!wildcard && isLoopbackHost(bindHost)) {
        // Loopback-only daemon: nothing else is reachable, not even its own NICs.
        return [...bases, loopback("loopback", "127.0.0.1")];
    }

    const boundAddress = wildcard ? null : normalizeBase(String(bindHost));
    const rows: NetworkBase[] = [];
    for (const [name, addresses] of Object.entries(options.interfaces ?? networkInterfaces())) {
        for (const entry of addresses ?? []) {
            if (entry.internal) continue;
            if (!isIPv4(entry)) continue;
            if (LINK_LOCAL_IPV4.test(entry.address)) continue;
            if (boundAddress !== null && entry.address !== boundAddress) continue;
            rows.push({
                kind: classifyAddress(name, entry.address),
                name,
                address: entry.address,
                url: `http://${entry.address}:${port}`,
            });
        }
    }
    rows.sort((left, right) => {
        const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
        if (byKind !== 0) return byKind;
        const physical = Number(isVirtualInterface(left.name)) - Number(isVirtualInterface(right.name));
        if (physical !== 0) return physical;
        return left.name.localeCompare(right.name) || left.address.localeCompare(right.address);
    });

    bases.push(...rows);
    bases.push(loopback("loopback", "127.0.0.1"));
    return bases;
}

/** The base the daemon advertises by default: public URL, else best LAN, else loopback. */
export function primaryBase(options: NetworkOptions): NetworkBase {
    const bases = networkBases(options);
    const first = bases[0];
    if (first === undefined) throw new Error("no reachable base address");
    return first;
}

/**
 * CORS allowlist: every reachable base, plus the loopback aliases a browser may
 * have typed (`localhost`, IPv6 loopback).
 */
export function localOrigins(options: NetworkOptions): string[] {
    const origins = new Set<string>();
    for (const base of networkBases(options)) {
        const origin = base.kind === "public" ? originOf(base.url) : null;
        origins.add(origin ?? base.url);
    }
    const port = options.port;
    origins.add(`http://localhost:${port}`);
    origins.add(`http://[::1]:${port}`);
    return [...origins];
}
