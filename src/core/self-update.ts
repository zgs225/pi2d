/**
 * On-disk state of a curl-channel install: the receipt at `<prefix>/install.json`
 * and the versioned tree it describes (`docs/adr/0003-self-update.md`).
 *
 * ```
 * <prefix>/versions/<version>/{bin,share,LICENSE}   immutable once written
 * <prefix>/current -> versions/<version>            the only thing that moves
 * <prefix>/install.json                             the receipt
 * ```
 *
 * `install.sh` writes the same shapes with POSIX shell; the two must stay in
 * step (a test pins the JSON keys, the installer is exercised by
 * `scripts/install.sh`'s own smoke run).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const RECEIPT_FILE = "install.json";
export const RECEIPT_SCHEMA = 1;
export const VERSIONS_DIR = "versions";
export const CURRENT_LINK = "current";

/** Who installed this tree — the only channel detection that cannot be spoofed. */
export type InstallerChannel = "curl" | "brew" | "aur" | "npm" | "unknown";

export interface InstallReceipt {
    schema: number;
    installer: InstallerChannel | string;
    layout: string;
    /** Absolute `<prefix>`. */
    prefix: string;
    /** Absolute `<prefix>/current`. */
    current: string;
    version: string;
    /** Absolute path of the installed binary *inside* the version tree. */
    bin: string;
    asset?: string;
    sha256?: string;
    installed_at?: string;
}

export interface ReceiptReadResult {
    receipt?: InstallReceipt;
    /** Why the receipt is unusable, when it is. */
    error?: string;
}

export function receiptPath(prefix: string): string {
    return join(prefix, RECEIPT_FILE);
}

function isString(value: unknown): value is string {
    return typeof value === "string" && value !== "";
}

function asReceipt(value: unknown): InstallReceipt | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const raw = value as Record<string, unknown>;
    if (!isString(raw.prefix) || !isString(raw.version) || !isString(raw.bin)) return undefined;
    const receipt: InstallReceipt = {
        schema: typeof raw.schema === "number" ? raw.schema : RECEIPT_SCHEMA,
        installer: isString(raw.installer) ? raw.installer : "unknown",
        layout: isString(raw.layout) ? raw.layout : "versioned",
        prefix: raw.prefix,
        current: isString(raw.current) ? raw.current : join(raw.prefix, CURRENT_LINK),
        version: raw.version,
        bin: raw.bin,
    };
    for (const key of ["asset", "sha256", "installed_at"] as const) {
        const field = raw[key];
        if (isString(field)) receipt[key] = field;
    }
    return receipt;
}

/** Read `<prefix>/install.json`. Never throws: a missing/broken receipt is a report. */
export function readReceipt(prefix: string): ReceiptReadResult {
    const file = receiptPath(prefix);
    if (!existsSync(file)) return { error: `no install receipt at ${file}` };
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
        return { error: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})` };
    }
    const receipt = asReceipt(parsed);
    if (receipt === undefined) return { error: `${file} is missing prefix/version/bin` };
    if (receipt.schema > RECEIPT_SCHEMA) {
        return { error: `${file} was written by a newer pi2 (schema ${receipt.schema})` };
    }
    return { receipt };
}

export interface BuildReceiptOptions {
    prefix: string;
    version: string;
    bin: string;
    asset?: string;
    sha256?: string;
    now?: Date;
    installer?: InstallerChannel | string;
}

export function buildReceipt(options: BuildReceiptOptions): InstallReceipt {
    const receipt: InstallReceipt = {
        schema: RECEIPT_SCHEMA,
        installer: options.installer ?? "curl",
        layout: "versioned",
        prefix: options.prefix,
        current: join(options.prefix, CURRENT_LINK),
        version: options.version,
        bin: options.bin,
        installed_at: (options.now ?? new Date()).toISOString().replace(/\.\d+Z$/, "Z"),
    };
    if (options.asset !== undefined) receipt.asset = options.asset;
    if (options.sha256 !== undefined) receipt.sha256 = options.sha256;
    return receipt;
}

/** Write the receipt through a temp file + rename, so it is never half-written. */
export function writeReceiptAtomic(prefix: string, receipt: InstallReceipt): string {
    const file = receiptPath(prefix);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
    return file;
}

function readCurrentTarget(prefix: string): string | undefined {
    try {
        return readlinkSync(join(prefix, CURRENT_LINK));
    } catch {
        return undefined;
    }
}

/** `versions/<version>` → `<version>`; anything else is `undefined`. */
export function currentVersion(prefix: string): string | undefined {
    const target = readCurrentTarget(prefix);
    if (target === undefined) return undefined;
    const parts = target.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.length !== 2 || parts[0] !== VERSIONS_DIR) return undefined;
    return parts[1];
}

/**
 * Point `<prefix>/current` at `target` atomically: a fresh symlink in the same
 * directory, then `rename(2)` over the old one. The live daemon keeps its old
 * inode, so a running process is never disturbed.
 */
export function switchCurrent(prefix: string, target: string): void {
    const link = join(prefix, CURRENT_LINK);
    const tmp = join(prefix, `.${CURRENT_LINK}.${process.pid}.${Date.now()}`);
    rmSync(tmp, { force: true });
    symlinkSync(target, tmp);
    renameSync(tmp, link);
}

/** A staging directory inside `<prefix>/versions` — same filesystem, so renames are atomic. */
export function stagingDir(prefix: string, label = "update"): string {
    return join(prefix, VERSIONS_DIR, `.staging-${label}-${process.pid}-${Date.now()}`);
}

/** Delete staging directories left behind by a crashed run. */
export function removeStaleStaging(prefix: string): string[] {
    const dir = join(prefix, VERSIONS_DIR);
    if (!existsSync(dir)) return [];
    const removed: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (!entry.startsWith(".staging-")) continue;
        rmSync(join(dir, entry), { recursive: true, force: true });
        removed.push(entry);
    }
    return removed;
}

export interface ApplyVersionedInstallOptions {
    prefix: string;
    version: string;
    /** Directory holding a freshly extracted `bin/`, `share/`, `LICENSE`. */
    stagedDir: string;
    asset?: string;
    sha256?: string;
    now?: Date;
}

export interface ApplyVersionedInstallResult {
    versionDir: string;
    /** The version `current` pointed at before the switch, when it pointed anywhere. */
    previous?: string;
    receiptFile: string;
    removed: string[];
}

/**
 * Move an extracted tree into `<prefix>/versions/<version>`, switch `current`,
 * write the receipt, prune. A failure at any step restores the previous
 * `current` target and the tree it replaced, so an interrupted update cannot
 * leave a half-installed version behind.
 */
export function applyVersionedInstall(options: ApplyVersionedInstallOptions): ApplyVersionedInstallResult {
    const { prefix, version, stagedDir } = options;
    const versionsDir = join(prefix, VERSIONS_DIR);
    mkdirSync(versionsDir, { recursive: true });

    const versionDir = join(versionsDir, version);
    const previous = currentVersion(prefix);
    const previousTarget = readCurrentTarget(prefix);
    const backup = `${versionDir}.old.${process.pid}.${Date.now()}`;
    const replaced = existsSync(versionDir);
    if (replaced) renameSync(versionDir, backup);

    let switched = false;
    try {
        renameSync(stagedDir, versionDir);
        switchCurrent(prefix, `${VERSIONS_DIR}/${version}`);
        switched = true;
        const receipt = buildReceipt({
            prefix,
            version,
            bin: join(versionDir, "bin", "pi2"),
            ...(options.asset === undefined ? {} : { asset: options.asset }),
            ...(options.sha256 === undefined ? {} : { sha256: options.sha256 }),
            ...(options.now === undefined ? {} : { now: options.now }),
        });
        const receiptFile = writeReceiptAtomic(prefix, receipt);
        if (replaced) rmSync(backup, { recursive: true, force: true });
        const keep = [version];
        if (previous !== undefined && previous !== version) keep.push(previous);
        const removed = pruneVersions(prefix, keep);
        return {
            versionDir,
            ...(previous === undefined ? {} : { previous }),
            receiptFile,
            removed,
        };
    } catch (error) {
        if (switched && previousTarget !== undefined) {
            try {
                switchCurrent(prefix, previousTarget);
            } catch {
                // Best effort: the caller reports the original failure.
            }
        }
        rmSync(versionDir, { recursive: true, force: true });
        if (replaced && existsSync(backup)) renameSync(backup, versionDir);
        throw error;
    }
}

/** Delete every version tree except `keep`, skipping dot entries. */
export function pruneVersions(prefix: string, keep: readonly string[]): string[] {
    const versionsDir = join(prefix, VERSIONS_DIR);
    if (!existsSync(versionsDir)) return [];
    const keepSet = new Set(keep);
    const removed: string[] = [];
    for (const entry of readdirSync(versionsDir)) {
        if (entry.startsWith(".")) continue;
        if (keepSet.has(entry)) continue;
        rmSync(join(versionsDir, entry), { recursive: true, force: true });
        removed.push(entry);
    }
    return removed;
}

/** `<prefix>/versions/<version>` → `<version>`; used to spot "another copy is running". */
export function versionOfBinary(bin: string): string | undefined {
    const versionDir = dirname(dirname(bin));
    if (basename(dirname(versionDir)) !== VERSIONS_DIR) return undefined;
    return basename(versionDir);
}
