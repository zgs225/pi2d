/**
 * Device token store (daemon-owned) and pairing helpers.
 *
 * Tokens are bearer credentials for the HTTP/WS surfaces. Only a SHA-256 hash
 * is persisted, in `$PI2_DATA_DIR/devices.json` (mode 0600, atomic replace).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dataDir } from "../core/paths.js";
import { ERROR_CODES } from "../protocol/errors.js";
import { DaemonError } from "./errors.js";

export type DeviceKind = "phone" | "laptop" | "tablet";
export type Scope = "read" | "steer" | "control" | "admin";

export const DEVICE_KINDS: readonly DeviceKind[] = ["phone", "laptop", "tablet"];
export const SCOPES: readonly Scope[] = ["read", "steer", "control", "admin"];
export const DEFAULT_SCOPES: readonly Scope[] = ["read", "steer", "control"];

export interface DeviceRecord {
    id: string;
    name: string;
    kind: DeviceKind;
    scopes: Scope[];
    tokenHash: string;
    createdAt: number;
    lastSeenAt: number;
    revokedAt: number | null;
}

export type DevicePublic = Omit<DeviceRecord, "tokenHash">;

export interface CreateDeviceInput {
    name: string;
    kind: DeviceKind;
    scopes?: Scope[];
}

export interface PairCode {
    code: string;
    url: string;
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
    baseUrl?: string;
    /** `touchDevice` write throttle. */
    touchIntervalMs?: number;
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

function isScope(value: unknown): value is Scope {
    return typeof value === "string" && (SCOPES as readonly string[]).includes(value);
}

function publicDevice(record: DeviceRecord): DevicePublic {
    const { tokenHash: _tokenHash, ...rest } = record;
    return { ...rest, scopes: [...rest.scopes] };
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
    private readonly now: () => number;
    private readonly baseUrl: string;
    private readonly touchIntervalMs: number;
    private readonly devices: DeviceRecord[] = [];
    private readonly pairs = new Map<string, PairEntry>();

    constructor(options: AuthStoreOptions = {}) {
        this.path = options.path ?? `${dataDir()}/devices.json`;
        this.now = options.now ?? Date.now;
        this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:7676").replace(/\/+$/, "");
        this.touchIntervalMs = options.touchIntervalMs ?? 60_000;
        this.load();
    }

    createDevice(input: CreateDeviceInput): { token: string; device: DevicePublic } {
        if (typeof input.name !== "string" || input.name.trim() === "") {
            throw DaemonError.badRequest("device name is required");
        }
        if (!isDeviceKind(input.kind)) throw DaemonError.badRequest(`unknown device kind "${String(input.kind)}"`);

        const scopes = input.scopes === undefined ? [...DEFAULT_SCOPES] : input.scopes.filter(isScope);
        if (scopes.length === 0) scopes.push("read");

        const token = randomBytes(32).toString("base64url");
        const timestamp = this.now();
        const record: DeviceRecord = {
            id: `dev-${randomBytes(6).toString("hex")}`,
            name: input.name.trim(),
            kind: input.kind,
            scopes,
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
        return {
            code,
            url: `${this.baseUrl}/pair/${code}`,
            expiresAt: timestamp + ttlSec * 1000,
            nonce,
        };
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
                scopes: Array.isArray(candidate.scopes) ? candidate.scopes.filter(isScope) : ["read"],
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
