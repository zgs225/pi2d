/**
 * Release metadata for `pi2 update`: which version is out, which asset belongs
 * to this artifact, and does the download match its published digest.
 *
 * Everything here is pure or injectable (`fetchImpl`, `now`, `cache`) so the
 * update path stays testable without a network, matching `test/`'s hermetic
 * rule. The GitHub API is unauthenticated (60 requests/hour), which is why the
 * version lookup is ETag-cached and has a redirect fallback: `pi2 update
 * --check` must not be able to burn the budget on its own.
 */

/** `owner/repo` — also the identity `gh attestation verify` checks. */
export const RELEASE_REPO = "zgs225/pi2d";

export const RELEASES_API_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

/** `https://github.com/<owner>/<repo>/releases` — assets live under `download/v<version>/`. */
export const RELEASE_DOWNLOAD_BASE = `https://github.com/${RELEASE_REPO}/releases/download`;

/** 24 h: a self-updater that phones home on every invocation is rude and rate-limited. */
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCache {
    etag?: string;
    version: string;
    /** ISO timestamp of the last check that produced `version`. */
    checkedAt: string;
}

export interface LatestVersionOptions {
    fetchImpl?: typeof fetch;
    cache?: UpdateCache;
    ttlMs?: number;
    now?: Date;
    apiUrl?: string;
    downloadBase?: string;
}

export interface LatestVersionResult {
    version: string;
    /** Fresh cache state to persist (the caller owns the file). */
    cache: UpdateCache;
    source: "cache" | "api" | "redirect";
}

/** `v0.1.6` → `0.1.6`; already-bare versions pass through. */
export function normalizeVersion(raw: string): string {
    const trimmed = raw.trim();
    return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

/** `0.1.6` → `[0,1,6]`; anything without three numbers is unparsable. */
export function parseVersionTriplet(raw: string | undefined): [number, number, number] | undefined {
    if (raw === undefined) return undefined;
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
    if (match === null) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric triplet ordering; unparsable versions sort as `0.0.0`. */
export function compareVersions(left: string, right: string): -1 | 0 | 1 {
    const a = parseVersionTriplet(left) ?? [0, 0, 0];
    const b = parseVersionTriplet(right) ?? [0, 0, 0];
    for (let index = 0; index < 3; index += 1) {
        const x = a[index] ?? 0;
        const y = b[index] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

/** `pi2d-0.1.6-linux-x64.tar.gz` — the asset name `build-binary.sh` produces. */
export function assetName(version: string, target: string): string {
    return `pi2d-${normalizeVersion(version)}-${target}.tar.gz`;
}

/** Asset URL: `PI2_BASE_URL` (mirror / offline fixture) wins over GitHub. */
export function assetUrl(version: string, target: string, baseUrl?: string): string {
    const asset = assetName(version, target);
    const base = (baseUrl ?? `${RELEASE_DOWNLOAD_BASE}/v${normalizeVersion(version)}`).replace(/\/+$/, "");
    return `${base}/${asset}`;
}

export function checksumsUrl(version: string, baseUrl?: string): string {
    const base = (baseUrl ?? `${RELEASE_DOWNLOAD_BASE}/v${normalizeVersion(version)}`).replace(/\/+$/, "");
    return `${base}/SHA256SUMS`;
}

/**
 * Parse a `sha256sum`-style file into `name → hex`. `sha256sum -c` writes
 * `<hex>  <name>`; a leading `*` marks binary mode (also accepted as
 * `<hex> *<name>`), and `<name>` may carry a `./` prefix.
 */
export function parseChecksums(text: string): Map<string, string> {
    const checksums = new Map<string, string>();
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;
        const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
        if (match === null) continue;
        const [, digest, rawName] = match;
        const name = (rawName ?? "").replace(/^\.\//, "");
        if (digest !== undefined && name !== "") checksums.set(name, digest.toLowerCase());
    }
    return checksums;
}

/** Digest of the bytes, or `undefined` when it cannot be computed. */
export function sha256Hex(bytes: Uint8Array | string): string {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const hash = createHash("sha256");
    hash.update(bytes);
    return hash.digest("hex");
}

/** True when `bytes` matches the published digest (case-insensitive). */
export function matchesChecksum(bytes: Uint8Array | string, expected: string): boolean {
    return sha256Hex(bytes) === expected.trim().toLowerCase();
}

/** `v0.1.6` out of a GitHub release payload. */
export function parseReleaseTag(payload: unknown): string | undefined {
    if (typeof payload !== "object" || payload === null) return undefined;
    const tag = (payload as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string" || tag.trim() === "") return undefined;
    return normalizeVersion(tag);
}

/** `…/releases/tag/v0.1.6` → `0.1.6` (the `releases/latest` redirect fallback). */
export function parseRedirectVersion(location: string | undefined): string | undefined {
    if (location === undefined) return undefined;
    const match = /\/releases\/tag\/([^/?#]+)/.exec(location);
    return match?.[1] === undefined ? undefined : normalizeVersion(match[1]);
}

function freshCache(cache: UpdateCache | undefined, ttlMs: number, now: Date): boolean {
    if (cache === undefined) return false;
    const checkedAt = Date.parse(cache.checkedAt);
    if (Number.isNaN(checkedAt)) return false;
    return now.getTime() - checkedAt < ttlMs;
}

async function fetchLatestFromApi(
    fetchImpl: typeof fetch,
    apiUrl: string,
    etag: string | undefined,
): Promise<{ tag?: string; etag?: string; notModified: boolean }> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (etag !== undefined) headers["If-None-Match"] = etag;
    const response = await fetchImpl(apiUrl, { headers });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) throw new Error(`GitHub API ${response.status} ${response.statusText}`);
    const payload = (await response.json()) as unknown;
    const tag = parseReleaseTag(payload);
    if (tag === undefined) throw new Error("GitHub API response has no tag_name");
    const nextEtag = response.headers.get("etag") ?? undefined;
    return nextEtag === undefined ? { tag, notModified: false } : { tag, etag: nextEtag, notModified: false };
}

async function fetchLatestFromRedirect(fetchImpl: typeof fetch, repo: string): Promise<string> {
    const response = await fetchImpl(`https://github.com/${repo}/releases/latest`, {
        method: "HEAD",
        redirect: "manual",
    });
    const version = parseRedirectVersion(response.headers.get("location") ?? undefined);
    if (version === undefined) {
        throw new Error("could not determine the latest release (GitHub API and redirect both failed)");
    }
    return version;
}

/**
 * Latest published version, in this order: fresh cache → GitHub API (with
 * `If-None-Match`) → the `releases/latest` redirect. Never throws for a stale
 * cache: the caller decides how loud a failure should be.
 */
export async function resolveLatestVersion(options: LatestVersionOptions = {}): Promise<LatestVersionResult> {
    const fetchImpl = options.fetchImpl ?? fetch;
    const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    const now = options.now ?? new Date();
    const apiUrl = options.apiUrl ?? RELEASES_API_URL;
    const cache = options.cache;

    if (freshCache(cache, ttlMs, now) && cache !== undefined) {
        return { version: cache.version, cache, source: "cache" };
    }

    try {
        const result = await fetchLatestFromApi(fetchImpl, apiUrl, cache?.etag);
        if (result.notModified && cache !== undefined) {
            const refreshed: UpdateCache = { version: cache.version, checkedAt: now.toISOString() };
            if (cache.etag !== undefined) refreshed.etag = cache.etag;
            return { version: cache.version, cache: refreshed, source: "api" };
        }
        const version = result.tag as string;
        const next: UpdateCache = { version, checkedAt: now.toISOString() };
        if (result.etag !== undefined) next.etag = result.etag;
        return { version, cache: next, source: "api" };
    } catch (apiError) {
        try {
            const version = await fetchLatestFromRedirect(fetchImpl, RELEASE_REPO);
            return { version, cache: { version, checkedAt: now.toISOString() }, source: "redirect" };
        } catch (redirectError) {
            throw new Error(
                `could not reach GitHub (${describe(apiError)}; ${describe(redirectError)})`,
            );
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The command a package manager owns, for the channels `pi2 update` refuses. */
export function channelUpgradeCommand(installer: string): string {
    switch (installer) {
        case "brew":
            return "brew upgrade pi2d";
        case "aur":
            return "paru -Syu pi2d-bin   # or: yay -Syu pi2d-bin";
        case "npm":
            return "npm i -g @yuez/pi2d@latest";
        default:
            return "npm i -g @yuez/pi2d@latest   # or: brew upgrade pi2d";
    }
}
