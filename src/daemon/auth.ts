/**
 * Device token store (daemon-owned) and pairing helpers.
 *
 * Tokens are bearer credentials for the HTTP/WS surfaces. Only a SHA-256 hash
 * is persisted, in `$PI2_DATA_DIR/devices.json` (mode 0600, atomic replace).
 *
 * A second, non-persisted credential exists for local tooling: the CLI token in
 * `<runtime>/cli.token` (written by `pi2 daemon`). It authenticates as the synthetic
 * `local-cli` device; see `docs/deployment.md` §7.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataDir } from "../core/paths.js";
import { ERROR_CODES } from "../protocol/errors.js";
import { DaemonError } from "./errors.js";

export type DeviceKind = "phone" | "laptop" | "tablet";

export const DEVICE_KINDS: readonly DeviceKind[] = ["phone", "laptop", "tablet"];

export interface DeviceRecord {
    id: string;
    name: string;
    kind: DeviceKind;
    tokenHash: string;
    createdAt: number;
    lastSeenAt: number;
    revokedAt: number | null;
}

export type DevicePublic = Omit<DeviceRecord, "tokenHash">;

export interface CreateDeviceInput {
    name: string;
    kind: DeviceKind;
}

/** Minted code; the URL is built by the HTTP layer from `core/network`. */
export interface PairCode {
    code: string;
    expiresAt: number;
    nonce: string;
}

export interface RedeemPairInput {
    code: string;
    deviceName: string;
    kind: DeviceKind;
}

export interface RedeemPairResult {
    token: string;
    device: DevicePublic;
}

export interface AuthStoreOptions {
    /** Defaults to `<dataDir>/devices.json`. */
    path?: string;
    now?: () => number;
    /** `touchDevice` write throttle. */
    touchIntervalMs?: number;
    /**
     * File holding the local CLI token (`<runtime>/cli.token`, written by `pi2 daemon`).
     * A bearer token equal to its trimmed contents authenticates as the synthetic
     * `local-cli` device. Checked after the persisted devices.
     */
    localTokenPath?: string;
    /**
     * Where the plaintext local-browser token lives. Defaults to
     * `<dataDir>/local-browser.token` (mode 0600), next to `devices.json`.
     */
    localBrowserTokenPath?: string;
}

/** Synthetic device id used for the local CLI token (never persisted). */
export const LOCAL_CLI_DEVICE_ID = "local-cli";

/** The single device that represents the browser opened by `pi2 open`. */
export const LOCAL_BROWSER_NAME = "local browser";
export const LOCAL_BROWSER_KIND: DeviceKind = "laptop";

export interface LocalBrowserSession {
    token: string;
    device: DevicePublic;
}

/** Constant-time string compare; the token length itself is not a secret. */
function tokensEqual(expected: string, candidate: string): boolean {
    const left = Buffer.from(expected, "utf8");
    const right = Buffer.from(candidate, "utf8");
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

interface PairEntry {
    code: string;
    nonce: string;
    expiresAt: number;
    used: boolean;
}

interface PersistedDevices {
    version: 1;
    devices: DeviceRecord[];
}

export function hashToken(rawToken: string): string {
    return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests (length is not secret here). */
export function timingSafeEqualHex(left: string, right: string): boolean {
    if (left.length !== right.length) return false;
    try {
        return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
    } catch {
        return false;
    }
}

/** Non-browser requests (no Origin) are allowed; unknown origins are not. */
export function isAllowedOrigin(origin: string | undefined, allowList: readonly string[]): boolean {
    if (origin === undefined || origin === "") return true;
    const normalized = origin.replace(/\/+$/, "");
    return allowList.some((allowed) => allowed.replace(/\/+$/, "") === normalized);
}

function isDeviceKind(value: unknown): value is DeviceKind {
    return typeof value === "string" && (DEVICE_KINDS as readonly string[]).includes(value);
}

function publicDevice(record: DeviceRecord): DevicePublic {
    const { tokenHash: _tokenHash, ...rest } = record;
    return { ...rest };
}

function pairCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(8);
    let code = "";
    for (const byte of bytes) code += alphabet[byte % alphabet.length];
    return code;
}

export class AuthStore {
    readonly path: string;
    readonly localTokenPath: string | undefined;
    readonly localBrowserTokenPath: string;
    private readonly now: () => number;
    private readonly touchIntervalMs: number;
    private readonly devices: DeviceRecord[] = [];
    private readonly pairs = new Map<string, PairEntry>();

    constructor(options: AuthStoreOptions = {}) {
        this.path = options.path ?? `${dataDir()}/devices.json`;
        this.now = options.now ?? Date.now;
        this.touchIntervalMs = options.touchIntervalMs ?? 60_000;
        this.localTokenPath =
            options.localTokenPath === undefined || options.localTokenPath === "" ? undefined : options.localTokenPath;
        this.localBrowserTokenPath = options.localBrowserTokenPath ?? `${dirname(this.path)}/local-browser.token`;
        this.load();
    }

    createDevice(input: CreateDeviceInput): { token: string; device: DevicePublic } {
        if (typeof input.name !== "string" || input.name.trim() === "") {
            throw DaemonError.badRequest("device name is required");
        }
        if (!isDeviceKind(input.kind)) throw DaemonError.badRequest(`unknown device kind "${String(input.kind)}"`);

        const token = randomBytes(32).toString("base64url");
        const timestamp = this.now();
        const record: DeviceRecord = {
            id: `dev-${randomBytes(6).toString("hex")}`,
            name: input.name.trim(),
            kind: input.kind,
            tokenHash: hashToken(token),
            createdAt: timestamp,
            lastSeenAt: timestamp,
            revokedAt: null,
        };
        this.devices.push(record);
        this.persist();
        return { token, device: publicDevice(record) };
    }

    verifyToken(rawToken: string): DevicePublic | null {
        if (typeof rawToken !== "string" || rawToken.length === 0) return null;
        if (this.matchesLocalToken(rawToken)) return this.localCliDevice();
        const digest = hashToken(rawToken);
        let matched: DeviceRecord | undefined;
        // Compare against every record so the timing does not reveal the position.
        for (const record of this.devices) {
            if (timingSafeEqualHex(record.tokenHash, digest) && matched === undefined) matched = record;
        }
        if (!matched || matched.revokedAt !== null) return null;
        return publicDevice(matched);
    }

    listDevices(): DevicePublic[] {
        return this.devices.map(publicDevice);
    }

    revokeDevice(id: string): boolean {
        const record = this.devices.find((device) => device.id === id);
        if (!record || record.revokedAt !== null) return false;
        record.revokedAt = this.now();
        this.persist();
        // Revoking the local browser also drops the plaintext token, so the next
        // `:PiWeb` / `pi2 open` mints a fresh one instead of handing out a dead URL.
        if (record.name === LOCAL_BROWSER_NAME && record.kind === LOCAL_BROWSER_KIND) this.clearLocalBrowserToken();
        return true;
    }

    touchDevice(id: string): void {
        const record = this.devices.find((device) => device.id === id);
        if (!record) return;
        const timestamp = this.now();
        if (timestamp - record.lastSeenAt < this.touchIntervalMs) return;
        record.lastSeenAt = timestamp;
        this.persist();
    }

    pairCreate(options: { ttlSec?: number } = {}): PairCode {
        const ttlSec = options.ttlSec ?? 600;
        if (!Number.isFinite(ttlSec) || ttlSec <= 0) throw DaemonError.badRequest("ttlSec must be positive");
        const timestamp = this.now();
        this.prunePairs(timestamp);
        const code = pairCode();
        const nonce = randomBytes(16).toString("hex");
        this.pairs.set(code, { code, nonce, expiresAt: timestamp + ttlSec * 1000, used: false });
        return { code, expiresAt: timestamp + ttlSec * 1000, nonce };
    }

    pairRedeem(input: RedeemPairInput): RedeemPairResult {
        if (typeof input.code !== "string" || !/^[A-Z0-9]{8}$/.test(input.code)) {
            throw DaemonError.unauthorized("invalid or already used pairing code");
        }
        if (!isDeviceKind(input.kind)) throw DaemonError.badRequest(`unknown device kind "${String(input.kind)}"`);
        if (typeof input.deviceName !== "string" || input.deviceName.trim() === "") {
            throw DaemonError.badRequest("deviceName is required");
        }

        const entry = this.pairs.get(input.code);
        if (!entry || entry.used) throw DaemonError.unauthorized("invalid or already used pairing code");
        const timestamp = this.now();
        if (timestamp > entry.expiresAt) {
            this.pairs.delete(entry.code);
            throw DaemonError.unauthorized("pairing code expired");
        }

        entry.used = true;
        this.pairs.delete(entry.code);
        return this.createDevice({ name: input.deviceName, kind: input.kind });
    }

    /** Exposed for tests and diagnostics; never includes hashes. */
    isPairing(code: string): boolean {
        return this.pairs.has(code);
    }

    /**
     * The local-browser login handshake (`POST /api/v1/console/session`).
     *
     * There is exactly one "local browser" device and, until it is revoked, one
     * stable token: `pi2 open` and `:PiWeb` hand the same credentials to the
     * browser on every call, so opening the console twice never invalidates the
     * tab that is already open. The plaintext lives in
     * `<dataDir>/local-browser.token` (0600, like `cli.token`); `devices.json`
     * keeps only the hash.
     *
     * Revoking the device (or deleting the file) forces a new token on the next
     * login; that path also covers a `devices.json` whose hash no longer matches
     * the stored plaintext.
     */
    localBrowserSession(): LocalBrowserSession {
        const existing = this.devices.find(
            (device) => device.name === LOCAL_BROWSER_NAME && device.kind === LOCAL_BROWSER_KIND,
        );
        const stored = this.readLocalBrowserToken();
        if (
            existing !== undefined &&
            existing.revokedAt === null &&
            stored !== null &&
            timingSafeEqualHex(existing.tokenHash, hashToken(stored))
        ) {
            return { token: stored, device: publicDevice(existing) };
        }

        const token = randomBytes(32).toString("base64url");
        const hash = hashToken(token);
        if (existing === undefined) {
            // `createDevice` mints its own token; overwrite it so the created and
            // rotated paths end in the same state (one record, this token).
            const created = this.createDevice({
                name: LOCAL_BROWSER_NAME,
                kind: LOCAL_BROWSER_KIND,
            });
            const record = this.devices.find((device) => device.id === created.device.id);
            if (record === undefined) return created;
            record.tokenHash = hash;
            this.persist();
            this.writeLocalBrowserToken(token);
            return { token, device: publicDevice(record) };
        }

        existing.tokenHash = hash;
        existing.revokedAt = null;
        this.persist();
        this.writeLocalBrowserToken(token);
        return { token, device: publicDevice(existing) };
    }

    /** Stored plaintext for the local browser; `null` when absent or unreadable. */
    private readLocalBrowserToken(): string | null {
        if (!existsSync(this.localBrowserTokenPath)) return null;
        try {
            const contents = readFileSync(this.localBrowserTokenPath, "utf8").trim();
            return contents === "" ? null : contents;
        } catch {
            return null;
        }
    }

    /** Atomic 0600 write, same pattern as `persist()`. */
    private writeLocalBrowserToken(token: string): void {
        const directory = dirname(this.localBrowserTokenPath);
        if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.localBrowserTokenPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
        renameSync(temporary, this.localBrowserTokenPath);
    }

    /** Drop the stored token; the next login mints a new one. */
    private clearLocalBrowserToken(): void {
        try {
            if (existsSync(this.localBrowserTokenPath)) unlinkSync(this.localBrowserTokenPath);
        } catch {
            /* best effort: a missing file is the desired state */
        }
    }

    /** The local CLI token is the daemon's own admin credential; not persisted, not revocable. */
    private localCliDevice(): DevicePublic {
        const timestamp = this.now();
        return {
            id: LOCAL_CLI_DEVICE_ID,
            name: "local CLI",
            kind: "laptop",
            createdAt: 0,
            lastSeenAt: timestamp,
            revokedAt: null,
        };
    }

    private matchesLocalToken(candidate: string): boolean {
        const path = this.localTokenPath;
        if (path === undefined) return false;
        let contents: string;
        try {
            contents = readFileSync(path, "utf8").trim();
        } catch {
            return false;
        }
        if (contents === "") return false;
        return tokensEqual(contents, candidate);
    }

    private prunePairs(timestamp: number): void {
        for (const [code, entry] of this.pairs) {
            if (entry.used || timestamp > entry.expiresAt) this.pairs.delete(code);
        }
    }

    private load(): void {
        if (!existsSync(this.path)) return;
        const raw = readFileSync(this.path, "utf8");
        if (raw.trim() === "") return;
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            throw new Error(`invalid device store ${this.path}: ${(error as Error).message}`);
        }
        const records = Array.isArray(parsed)
            ? parsed
            : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as PersistedDevices).devices)
              ? (parsed as PersistedDevices).devices
              : [];
        for (const value of records) {
            if (typeof value !== "object" || value === null) continue;
            const candidate = value as Partial<DeviceRecord>;
            if (
                typeof candidate.id !== "string" ||
                typeof candidate.name !== "string" ||
                !isDeviceKind(candidate.kind) ||
                typeof candidate.tokenHash !== "string" ||
                typeof candidate.createdAt !== "number"
            ) {
                continue;
            }
            this.devices.push({
                id: candidate.id,
                name: candidate.name,
                kind: candidate.kind,
                tokenHash: candidate.tokenHash,
                createdAt: candidate.createdAt,
                lastSeenAt: typeof candidate.lastSeenAt === "number" ? candidate.lastSeenAt : candidate.createdAt,
                revokedAt: typeof candidate.revokedAt === "number" ? candidate.revokedAt : null,
            });
        }
    }

    private persist(): void {
        const directory = dirname(this.path);
        if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
        const payload: PersistedDevices = { version: 1, devices: this.devices };
        const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, this.path);
    }
}
