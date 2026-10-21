/**
 * WorkspaceStore: merges the durable registry, disk discovery and live
 * instance state into the `WorkspaceInfo` shape served by the daemon.
 *
 * Ordering and hiding are intentionally left to the UI; `list()` returns every
 * known workspace (including `hidden` ones) with stable registry-first order.
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InstanceManager, WorkspaceStore as WorkspaceStoreContract } from "../core/interfaces.js";
import { dataDir, realpathSafe, workspaceIdForCwd } from "../core/paths.js";
import { ERROR_CODES } from "../protocol/errors.js";
import type { InstanceState, WorkspaceInfo } from "../protocol/types.js";
import {
    createDiscovery,
    type DiscoveredWorkspace,
    type Discovery,
    type DiscoveryLogger,
} from "./discovery.js";
import { WorkspaceError } from "./errors.js";
import {
    validatePatch,
    WorkspaceRegistry,
    type RegistryLogger,
    type WorkspaceEntry,
    type WorkspacePatch,
} from "./registry.js";

export interface WorkspaceStoreOptions {
    /** Defaults to a discovery over `sessionsRoot()`. */
    discovery?: Discovery;
    /** Defaults to `${dataDir()}/workspaces.json`. */
    registry?: WorkspaceRegistry;
    /** Instance supervisor; absent in unit tests and during early boot. */
    instances?: Pick<InstanceManager, "list" | "instanceStates">;
    logger?: RegistryLogger & Partial<DiscoveryLogger>;
    /**
     * Explicit allowlist for `add()` (real paths). When omitted,
     * `PI2_WORKSPACE_ROOTS` (comma separated) is used, defaulting to homedir.
     * `ensureForCwd()` deliberately ignores this list: instances may live
     * anywhere the user already opened nvim.
     */
    roots?: readonly string[];
}

export interface WorkspaceStoreHandle extends WorkspaceStoreContract {
    readonly discovery: Discovery;
    readonly registry: WorkspaceRegistry;
}

interface InstanceViews {
    instances: Map<string, InstanceState>;
    live: Map<string, number>;
}

class WorkspaceStore implements WorkspaceStoreHandle {
    readonly discovery: Discovery;
    readonly registry: WorkspaceRegistry;

    private readonly instances: Pick<InstanceManager, "list" | "instanceStates"> | undefined;
    private readonly logger: WorkspaceStoreOptions["logger"] | undefined;
    private readonly roots: readonly string[] | undefined;

    constructor(options: WorkspaceStoreOptions = {}) {
        this.logger = options.logger;
        this.discovery = options.discovery ?? createDiscovery({ ...(options.logger ? { logger: options.logger } : {}) });
        this.registry =
            options.registry ??
            new WorkspaceRegistry({
                filePath: join(dataDir(), "workspaces.json"),
                ...(options.logger ? { logger: options.logger } : {}),
            });
        this.instances = options.instances;
        this.roots = options.roots;
    }

    list(): WorkspaceInfo[] {
        const discovered = this.discoveredById();
        const views = this.instanceViews();
        const records = this.registry.list();
        const registered = new Set(records.map((record) => record.workspaceId));

        const infos = records.map((record) =>
            this.buildInfo(record.workspaceId, record.entry, discovered.get(record.workspaceId), views),
        );
        for (const [workspaceId, entry] of discovered) {
            if (registered.has(workspaceId)) continue;
            infos.push(this.buildInfo(workspaceId, undefined, entry, views));
        }
        return infos;
    }

    get(workspaceId: string): WorkspaceInfo | undefined {
        if (typeof workspaceId !== "string" || workspaceId.length === 0) return undefined;
        const record = this.registry.get(workspaceId);
        const discovered = this.discoveredById().get(workspaceId);
        if (!record && !discovered) return undefined;
        return this.buildInfo(workspaceId, record?.entry, discovered, this.instanceViews());
    }

    byCwd(cwd: string): WorkspaceInfo | undefined {
        if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return undefined;
        const registered = this.registry.byCwd(cwd);
        if (registered) return this.get(registered.workspaceId);
        return this.get(workspaceIdForCwd(cwd));
    }

    async add(input: { cwd: string; alias?: string; trust?: boolean }): Promise<WorkspaceInfo> {
        if (!input || typeof input !== "object") {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "workspace input must be an object");
        }
        const raw = input.cwd;
        if (typeof raw !== "string" || raw.trim().length === 0) {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "cwd must be a non-empty string");
        }
        if (raw.includes("\0")) {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "cwd contains a NUL byte");
        }
        if (!isAbsolute(raw)) {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, `cwd must be absolute: ${raw}`);
        }
        if (input.alias !== undefined && typeof input.alias !== "string") {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "alias must be a string");
        }
        if (input.trust !== undefined && typeof input.trust !== "boolean") {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "trust must be a boolean");
        }

        const roots = this.allowlist();
        let real: string;
        try {
            real = realpathSync(raw);
        } catch (error) {
            throw mapFsError(error, raw);
        }
        // Check the canonical path: symlinks inside the allowlist must not escape it.
        this.assertAllowed(real, roots);

        let stat;
        try {
            stat = statSync(real);
        } catch (error) {
            throw mapFsError(error, real);
        }
        if (!stat.isDirectory()) {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, `not a directory: ${real}`);
        }

        try {
            accessSync(real, constants.R_OK | constants.W_OK | constants.X_OK);
        } catch (error) {
            throw new WorkspaceError(ERROR_CODES.FORBIDDEN, `directory is not readable and writable: ${real}`, false, {
                cause: error,
            });
        }

        await this.registry.ensureForCwd(real);
        const patch: WorkspacePatch = {};
        if (input.alias !== undefined) {
            const alias = input.alias.trim();
            patch.alias = alias.length > 0 ? alias : null;
        }
        if (input.trust !== undefined) patch.trusted = input.trust;
        if (Object.keys(patch).length > 0) {
            await this.registry.update(workspaceIdForCwd(real), patch);
        }

        return this.requireInfo(workspaceIdForCwd(real));
    }

    async update(workspaceId: string, patch: WorkspacePatch): Promise<WorkspaceInfo> {
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "workspaceId is required");
        }
        validatePatch(patch);

        let record = this.registry.get(workspaceId);
        if (!record) {
            const discovered = this.discoveredById().get(workspaceId);
            if (!discovered) {
                throw new WorkspaceError(ERROR_CODES.NOT_FOUND, `unknown workspace: ${workspaceId}`);
            }
            // Ghost workspaces have no directory to realpath, but user intent
            // (pin/hide/trust) must still be persistable.
            record = await this.registry.ensureForCwd(discovered.cwd, { allowMissing: true });
        }

        await this.registry.update(record.workspaceId, patch);
        return this.requireInfo(record.workspaceId);
    }

    async remove(workspaceId: string): Promise<void> {
        if (typeof workspaceId !== "string" || workspaceId.length === 0) {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, "workspaceId is required");
        }
        // Registry only: session files are never touched. Discovered-only
        // workspaces simply have nothing to remove.
        await this.registry.remove(workspaceId);
    }

    async refresh(workspaceId?: string): Promise<void> {
        if (workspaceId === undefined) {
            this.discovery.invalidate();
        } else {
            const cwd = this.registry.get(workspaceId)?.entry.cwd;
            const dir = (cwd ? this.discovery.dirForCwd(cwd) : undefined) ?? this.discoveredById().get(workspaceId)?.dir;
            if (dir) this.discovery.invalidate(dir);
            else this.discovery.invalidate();
        }
        // Pick up external edits to workspaces.json as well as session files.
        this.registry.load();
    }

    async ensureForCwd(cwd: string): Promise<WorkspaceInfo> {
        const record = await this.registry.ensureForCwd(cwd);
        return this.requireInfo(record.workspaceId);
    }

    // ------------------------------------------------------------------

    private requireInfo(workspaceId: string): WorkspaceInfo {
        const info = this.get(workspaceId);
        if (!info) {
            throw new WorkspaceError(ERROR_CODES.INTERNAL, `workspace disappeared after write: ${workspaceId}`);
        }
        return info;
    }

    private discoveredById(): Map<string, DiscoveredWorkspace> {
        const merged = new Map<string, DiscoveredWorkspace>();
        let entries: DiscoveredWorkspace[];
        try {
            entries = this.discovery.discover();
        } catch (error) {
            this.logger?.warn("workspace discovery failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return merged;
        }

        for (const entry of entries) {
            const previous = merged.get(entry.workspaceId);
            if (!previous) {
                merged.set(entry.workspaceId, { ...entry });
                continue;
            }
            // Two encoded directories can resolve to the same canonical cwd.
            const lastActiveAt =
                previous.lastActiveAt === null
                    ? entry.lastActiveAt
                    : entry.lastActiveAt === null
                      ? previous.lastActiveAt
                      : Math.max(previous.lastActiveAt, entry.lastActiveAt);
            merged.set(entry.workspaceId, {
                ...previous,
                sessionCount: previous.sessionCount + entry.sessionCount,
                lastActiveAt,
                exists: previous.exists || entry.exists,
                // Prefer the directory with more sessions for listSessions().
                dir: entry.sessionCount > previous.sessionCount ? entry.dir : previous.dir,
                cwd: entry.sessionCount > previous.sessionCount ? entry.cwd : previous.cwd,
            });
        }
        return merged;
    }

    private buildInfo(
        workspaceId: string,
        entry: WorkspaceEntry | undefined,
        discovered: DiscoveredWorkspace | undefined,
        views: InstanceViews,
    ): WorkspaceInfo {
        const cwd = entry?.cwd ?? discovered?.cwd ?? "";
        const alias = entry?.alias ?? null;
        return {
            workspaceId,
            cwd,
            name: alias ?? (basename(cwd) || cwd),
            alias,
            pinned: entry?.pinned ?? false,
            hidden: entry?.hidden ?? false,
            trusted: entry?.trusted ?? false,
            exists: discovered?.exists ?? isDirectory(cwd),
            sessionCount: discovered?.sessionCount ?? 0,
            liveCount: views.live.get(workspaceId) ?? 0,
            lastActiveAt: discovered?.lastActiveAt ?? null,
            instance: views.instances.get(workspaceId) ?? null,
        };
    }

    private instanceViews(): InstanceViews {
        const instances = new Map<string, InstanceState>();
        const live = new Map<string, number>();

        const listed = this.callInstances("list");
        const states = this.callInstances("instanceStates") ?? listed ?? [];
        for (const state of listed ?? states) {
            if (state && typeof state.workspaceId === "string") instances.set(state.workspaceId, state);
        }
        for (const state of states) {
            if (!state || typeof state.workspaceId !== "string") continue;
            const count = liveCountOf(state);
            live.set(state.workspaceId, Math.max(live.get(state.workspaceId) ?? 0, count));
        }
        return { instances, live };
    }

    private callInstances(method: "list" | "instanceStates"): InstanceState[] | undefined {
        if (!this.instances) return undefined;
        try {
            const fn = this.instances[method];
            const result = fn.call(this.instances);
            return Array.isArray(result) ? result : [];
        } catch (error) {
            this.logger?.warn(`instance manager ${method}() failed`, {
                error: error instanceof Error ? error.message : String(error),
            });
            return undefined;
        }
    }

    private allowlist(): string[] {
        const configured = this.roots;
        if (configured !== undefined) {
            return configured.map((root) => canonicalRoot(root)).filter((root): root is string => root.length > 0);
        }
        return rootsFromEnv(process.env.PI2_WORKSPACE_ROOTS);
    }

    private assertAllowed(candidate: string, roots: readonly string[]): void {
        if (roots.some((root) => isWithin(root, candidate))) return;
        throw new WorkspaceError(
            ERROR_CODES.FORBIDDEN,
            `workspace path is outside the allowed roots: ${candidate}`,
        );
    }
}

export function createWorkspaceStore(options: WorkspaceStoreOptions = {}): WorkspaceStoreHandle {
    return new WorkspaceStore(options);
}

export function rootsFromEnv(raw: string | undefined, fallback: string = homedir()): string[] {
    const parts = (raw ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    if (parts.length === 0) parts.push(fallback);
    return parts.map((part) => canonicalRoot(part)).filter((part) => part.length > 0);
}

/** Expand `~`, resolve relative roots against cwd, and canonicalise when possible. */
function canonicalRoot(root: string): string {
    if (typeof root !== "string") return "";
    let value = root.trim();
    if (value.length === 0 || value.includes("\0")) return "";
    if (value === "~") value = homedir();
    else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
    return realpathSafe(resolve(value));
}

function isWithin(root: string, candidate: string): boolean {
    if (root.length === 0) return false;
    const rel = relative(root, candidate);
    if (rel === "") return true;
    if (isAbsolute(rel)) return false;
    return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function isDirectory(path: string): boolean {
    if (!path || !isAbsolute(path)) return false;
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** InstanceState does not (yet) declare sessions; support the shapes in the wild. */
function liveCountOf(state: InstanceState): number {
    const extended = state as InstanceState & {
        sessions?: unknown;
        sessionCount?: unknown;
        liveCount?: unknown;
    };
    if (Array.isArray(extended.sessions)) return extended.sessions.length;
    if (typeof extended.sessionCount === "number" && Number.isFinite(extended.sessionCount)) {
        return Math.max(0, extended.sessionCount);
    }
    if (typeof extended.sessions === "number" && Number.isFinite(extended.sessions)) {
        return Math.max(0, extended.sessions);
    }
    if (typeof extended.liveCount === "number" && Number.isFinite(extended.liveCount)) {
        return Math.max(0, extended.liveCount);
    }
    return 0;
}

function mapFsError(error: unknown, path: string): WorkspaceError {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
        return new WorkspaceError(ERROR_CODES.NOT_FOUND, `path does not exist: ${path}`, false, { cause: error });
    }
    if (code === "EACCES" || code === "EPERM") {
        return new WorkspaceError(ERROR_CODES.FORBIDDEN, `path is not accessible: ${path}`, false, {
            cause: error,
        });
    }
    return new WorkspaceError(ERROR_CODES.BAD_REQUEST, `invalid path ${path}: ${detail}`, false, {
        cause: error,
    });
}

export { createDiscovery } from "./discovery.js";
export { WorkspaceError } from "./errors.js";
export {
    canonicalizeCwd,
    WorkspaceRegistry,
    type WorkspaceEntry,
    type WorkspacePatch,
    type WorkspaceRecord,
} from "./registry.js";
export type { DiscoveredWorkspace, Discovery, SessionFile } from "./discovery.js";
