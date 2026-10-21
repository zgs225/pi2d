/**
 * Durable workspace registry (`${dataDir()}/workspaces.json`).
 *
 * The registry stores user intent (alias, pin, hidden, trust) keyed by the
 * canonical `workspaceId = sha256(realpath(cwd)).slice(0, 16)`. Disk discovery
 * is deliberately kept separate: the registry never scans session files.
 *
 * The file is written atomically (tmp file + rename) with mode 0600. A corrupt
 * file is moved aside to `workspaces.json.bak` and the registry starts empty.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { dataDir, realpathSafe, workspaceIdForCwd } from "../core/paths.js";
import { ERROR_CODES } from "../protocol/errors.js";
import { WorkspaceError } from "./errors.js";

export { WorkspaceError } from "./errors.js";

const entrySchema = z.object({
    cwd: z.string().min(1),
    alias: z.string().min(1).optional(),
    pinned: z.boolean(),
    hidden: z.boolean(),
    trusted: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const fileSchema = z.object({
    version: z.literal(1),
    workspaces: z.record(entrySchema),
});

export interface WorkspaceEntry {
    cwd: string;
    alias?: string;
    pinned: boolean;
    hidden: boolean;
    trusted: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface WorkspaceRecord {
    workspaceId: string;
    entry: WorkspaceEntry;
}

export type WorkspacePatch = Partial<{
    alias: string | null;
    pinned: boolean;
    hidden: boolean;
    trusted: boolean;
}>;

export interface RegistryLogger {
    warn(msg: string, fields?: Record<string, unknown>): void;
    debug?(msg: string, fields?: Record<string, unknown>): void;
}

export interface RegistryOptions {
    /** Defaults to `${dataDir()}/workspaces.json`. */
    filePath?: string;
    logger?: RegistryLogger;
    now?: () => number;
}

/**
 * Canonicalise a cwd; rejects relative paths. Missing directories throw unless
 * `allowMissing` is set (used when persisting metadata for a ghost workspace).
 */
export function canonicalizeCwd(cwd: string, options: { allowMissing?: boolean } = {}): string {
    if (typeof cwd !== "string" || cwd.trim().length === 0) {
        throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "cwd must be a non-empty string");
    }
    if (cwd.includes("\0")) {
        throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "cwd contains a NUL byte");
    }
    if (!isAbsolute(cwd)) {
        throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, `cwd must be absolute: ${cwd}`);
    }
    if (options.allowMissing) return realpathSafe(cwd);
    try {
        return realpathSync(cwd);
    } catch (error) {
        throw mapFsError(error, cwd);
    }
}

function mapFsError(error: unknown, cwd: string): WorkspaceError {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
        return new WorkspaceError(ERROR_CODES.NOT_FOUND, `cwd does not exist: ${cwd}`, false, { cause: error });
    }
    if (code === "EACCES" || code === "EPERM") {
        return new WorkspaceError(ERROR_CODES.FORBIDDEN, `cwd is not accessible: ${cwd}`, false, {
            cause: error,
        });
    }
    return new WorkspaceError(ERROR_CODES.BAD_REQUEST, `invalid cwd ${cwd}: ${detail}`, false, {
        cause: error,
    });
}

function cloneEntry(entry: WorkspaceEntry): WorkspaceEntry {
    return { ...entry };
}

function isErrno(error: unknown): NodeJS.ErrnoException {
    return error as NodeJS.ErrnoException;
}

export class WorkspaceRegistry {
    readonly filePath: string;

    private readonly logger: RegistryLogger | undefined;
    private readonly now: () => number;
    private readonly entries = new Map<string, WorkspaceEntry>();
    /** Serialises writes so concurrent CRUD calls cannot interleave renames. */
    private saveChain: Promise<void> = Promise.resolve();

    constructor(options: RegistryOptions = {}) {
        this.filePath = options.filePath ?? join(dataDir(), "workspaces.json");
        this.logger = options.logger;
        this.now = options.now ?? Date.now;
        this.load();
    }

    /** (Re)load from disk. Corrupt content is backed up and treated as empty. */
    load(): void {
        this.entries.clear();

        let raw: string;
        try {
            raw = readFileSync(this.filePath, "utf8");
        } catch (error) {
            if (isErrno(error).code === "ENOENT") return;
            this.handleCorrupt(`read failed: ${isErrno(error).message}`);
            return;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            this.handleCorrupt(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }

        const result = fileSchema.safeParse(parsed);
        if (!result.success) {
            this.handleCorrupt(result.error.issues.map((issue) => issue.message).join("; "));
            return;
        }

        for (const [workspaceId, entry] of Object.entries(result.data.workspaces)) {
            this.entries.set(workspaceId, cloneEntry(entry));
        }
    }

    list(): WorkspaceRecord[] {
        return [...this.entries].map(([workspaceId, entry]) => ({
            workspaceId,
            entry: cloneEntry(entry),
        }));
    }

    get(workspaceId: string): WorkspaceRecord | undefined {
        const entry = this.entries.get(workspaceId);
        return entry ? { workspaceId, entry: cloneEntry(entry) } : undefined;
    }

    byCwd(cwd: string): WorkspaceRecord | undefined {
        if (typeof cwd !== "string" || !isAbsolute(cwd)) return undefined;
        const id = workspaceIdForCwd(cwd);
        const direct = this.get(id);
        if (direct) return direct;

        const canonical = realpathSafe(cwd);
        for (const [workspaceId, entry] of this.entries) {
            if (entry.cwd === cwd || entry.cwd === canonical) {
                return { workspaceId, entry: cloneEntry(entry) };
            }
        }
        return undefined;
    }

    /**
     * Return the record for a cwd, creating it when absent. Idempotent:
     * `createdAt` and all user metadata are preserved for existing entries.
     */
    async ensureForCwd(cwd: string, options: { allowMissing?: boolean } = {}): Promise<WorkspaceRecord> {
        const canonical = canonicalizeCwd(cwd, options);
        const workspaceId = workspaceIdForCwd(canonical);
        const existing = this.entries.get(workspaceId);
        if (existing) return { workspaceId, entry: cloneEntry(existing) };

        const timestamp = this.now();
        const entry: WorkspaceEntry = {
            cwd: canonical,
            pinned: false,
            hidden: false,
            trusted: false,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.entries.set(workspaceId, entry);
        await this.persist();
        return { workspaceId, entry: cloneEntry(entry) };
    }

    async update(workspaceId: string, patch: WorkspacePatch): Promise<WorkspaceRecord> {
        validatePatch(patch);
        const entry = this.entries.get(workspaceId);
        if (!entry) {
            throw new WorkspaceError(ERROR_CODES.NOT_FOUND, `unknown workspace: ${workspaceId}`);
        }

        if (patch.alias !== undefined) {
            const alias = patch.alias === null ? "" : patch.alias.trim();
            if (alias.length === 0) delete entry.alias;
            else entry.alias = alias;
        }
        if (patch.pinned !== undefined) entry.pinned = patch.pinned;
        if (patch.hidden !== undefined) entry.hidden = patch.hidden;
        if (patch.trusted !== undefined) entry.trusted = patch.trusted;
        entry.updatedAt = this.now();

        await this.persist();
        return { workspaceId, entry: cloneEntry(entry) };
    }

    /** Removes the registry entry only; session files on disk are untouched. */
    async remove(workspaceId: string): Promise<boolean> {
        const existed = this.entries.delete(workspaceId);
        if (existed) await this.persist();
        return existed;
    }

    /** Force a write of the current in-memory registry. */
    async save(): Promise<void> {
        await this.persist();
    }

    private persist(): Promise<void> {
        const next = this.saveChain.then(() => this.writeFile());
        // Keep the chain alive after a failed write; callers still see the error.
        this.saveChain = next.catch(() => undefined);
        return next;
    }

    private async writeFile(): Promise<void> {
        const payload = {
            version: 1 as const,
            workspaces: Object.fromEntries(
                [...this.entries].map(([workspaceId, entry]) => [workspaceId, cloneEntry(entry)]),
            ),
        };
        const data = `${JSON.stringify(payload, null, 2)}\n`;
        const dir = dirname(this.filePath);
        const tmp = join(dir, `.${basename(this.filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);

        try {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            const handle = await open(tmp, "w", 0o600);
            try {
                await handle.writeFile(data, "utf8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            await chmod(tmp, 0o600);
            await rename(tmp, this.filePath);
            // A rename replaces the inode, but enforce the mode even on odd umasks.
            await chmod(this.filePath, 0o600);
        } catch (error) {
            await rm(tmp, { force: true }).catch(() => undefined);
            throw new WorkspaceError(
                ERROR_CODES.INTERNAL,
                `failed to write workspace registry ${this.filePath}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                false,
                { cause: error },
            );
        }
    }

    private handleCorrupt(reason: string): void {
        this.entries.clear();
        const backup = `${this.filePath}.bak`;
        let backedUp = false;
        try {
            // rename replaces an existing backup on POSIX.
            renameSync(this.filePath, backup);
            backedUp = true;
        } catch (error) {
            // Best effort: still start empty even if the backup could not be made.
            this.logger?.warn("could not back up corrupt workspace registry", {
                file: this.filePath,
                backup,
                reason: error instanceof Error ? error.message : String(error),
            });
        }

        const message = "workspace registry is corrupt; starting empty";
        if (this.logger) {
            this.logger.warn(message, {
                file: this.filePath,
                backup: backedUp ? backup : null,
                reason,
            });
        } else {
            console.warn(`[workspaces] ${message}`, { file: this.filePath, backup: backedUp ? backup : null, reason });
        }
    }
}

export function validatePatch(patch: WorkspacePatch): void {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "workspace patch must be an object");
    }
    const allowed = new Set(["alias", "pinned", "hidden", "trusted"]);
    for (const key of Object.keys(patch)) {
        if (!allowed.has(key)) {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, `unknown workspace field: ${key}`);
        }
    }
    if (patch.alias !== undefined && patch.alias !== null && typeof patch.alias !== "string") {
        throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "alias must be a string or null");
    }
    for (const key of ["pinned", "hidden", "trusted"] as const) {
        const value = patch[key];
        if (value !== undefined && typeof value !== "boolean") {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, `${key} must be a boolean`);
        }
    }
}
