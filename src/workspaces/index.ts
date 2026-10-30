/**
 * WorkspaceStore: merges the durable registry, disk discovery and live
 * instance state into the `WorkspaceInfo` shape served by the daemon.
 *
 * `list()` returns every known workspace (including `hidden` ones) with stable
 * registry-first order: rows are never filtered, so `/workspace/<id>` deep
 * links keep resolving. Instead every row carries a derived, non-persisted
 * `visibility` (`default` | `secondary`) + `visibilityReason` that the UI uses
 * to collapse workspace noise (ghosts, temp dirs, …) into a "show hidden"
 * section. Ordering and presentation stay with the UI.
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InstanceManager, WorkspaceStore as WorkspaceStoreContract } from "../core/interfaces.js";
import { dataDir, expandTilde, realpathSafe, workspaceIdForCwd } from "../core/paths.js";
import { ERROR_CODES } from "../protocol/errors.js";
import type {
    InstanceState,
    RecentSessionInfo,
    WorkspaceInfo,
    WorkspaceVisibility,
    WorkspaceVisibilityReason,
} from "../protocol/types.js";
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

export type WorkspaceEnv = Record<string, string | undefined>;

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
    /**
     * Environment used for `PI2_WORKSPACE_*` (roots + visibility policy);
     * injectable so tests stay hermetic. Defaults to `process.env`.
     */
    env?: WorkspaceEnv;
    /** Clock for the `PI2_WORKSPACE_STALE_DAYS` comparison; defaults to `Date.now`. */
    now?: () => number;
    /**
     * Home for `~`/`~/…` expansion in `add()` and the default allowlist root;
     * injectable so tests never touch the real home directory.
     */
    home?: string;
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
    private readonly env: WorkspaceEnv;
    private readonly now: () => number;
    private readonly home: string;

    constructor(options: WorkspaceStoreOptions = {}) {
        this.logger = options.logger;
        this.env = options.env ?? process.env;
        this.now = options.now ?? Date.now;
        this.home = options.home ?? homedir();
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
        // `~` and `~/…` are shell shorthand the web dialog advertises; expand before
        // the absolute-path check. `~user/…` is deliberately left alone: resolving
        // another user's home is not something the daemon should guess at.
        const expanded = expandTilde(raw, this.home);
        if (expanded === undefined) {
            throw new WorkspaceError(
                ERROR_CODES.BAD_REQUEST,
                `cwd must be an absolute path (or start with ~/): ~user is not expanded: ${raw}`,
            );
        }
        if (!isAbsolute(expanded)) {
            throw new WorkspaceError(ERROR_CODES.BAD_REQUEST, `cwd must be an absolute path (or start with ~/): ${raw}`);
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
            real = realpathSync(expanded);
        } catch (error) {
            throw mapFsError(error, expanded);
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
        // Explicitly reopen: `registry.update()` only touches the keys it is
        // given, so a previously hidden workspace would otherwise stay hidden
        // and vanish from the list after the user just asked to open it.
        const patch: WorkspacePatch = { hidden: false };
        if (input.alias !== undefined) {
            const alias = input.alias.trim();
            patch.alias = alias.length > 0 ? alias : null;
        }
        if (input.trust !== undefined) patch.trusted = input.trust;
        await this.registry.update(workspaceIdForCwd(real), patch);

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

    /**
     * Newest session files across every known workspace (registry ∪ discovery).
     *
     * Each workspace asks discovery for at most `limit` rows, so the header scan
     * stays bounded even on a workspace with a long history. Rows are deduped by
     * session id (two encoded directories can resolve to the same cwd) and sorted
     * by file mtime, then header timestamp, then id for a deterministic order.
     * Only the returned rows get a bounded display-title preview.
     */
    recentSessions(limit = 20): RecentSessionInfo[] {
        const capped = clampLimit(limit);
        const rows: RecentSessionInfo[] = [];
        const seen = new Set<string>();
        for (const workspace of this.list()) {
            if (!workspace.cwd) continue;
            for (const file of this.discovery.listSessions(workspace.cwd, capped)) {
                if (file.id === "" || seen.has(file.id)) continue;
                seen.add(file.id);
                rows.push({
                    sessionId: file.id,
                    workspaceId: workspace.workspaceId,
                    workspaceName: workspace.name,
                    cwd: workspace.cwd,
                    sessionFile: file.file,
                    timestamp: file.timestamp,
                    modified: file.modified,
                });
            }
        }
        rows.sort(
            (a, b) =>
                b.modified - a.modified ||
                b.timestamp - a.timestamp ||
                a.sessionId.localeCompare(b.sessionId),
        );
        const selected = rows.slice(0, capped);
        // Enrich only the rows the caller will render: previews are bounded but
        // per-file reads, so never pay for candidates that are sliced away.
        for (const row of selected) {
            const preview = this.discovery.previewSession(row.sessionFile, row.modified);
            if (preview?.name !== undefined) row.name = preview.name;
            if (preview?.firstMessage !== undefined) row.firstMessage = preview.firstMessage;
        }
        return selected;
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
        const pinned = entry?.pinned ?? false;
        const hidden = entry?.hidden ?? false;
        const trusted = entry?.trusted ?? false;
        const exists = discovered?.exists ?? isDirectory(cwd);
        const lastActiveAt = discovered?.lastActiveAt ?? null;
        const liveCount = views.live.get(workspaceId) ?? 0;
        const instance = views.instances.get(workspaceId) ?? null;
        const classification = classifyWorkspace({
            cwd,
            hidden,
            pinned,
            trusted,
            exists,
            lastActiveAt,
            liveCount,
            instance,
            roots: this.allowlist(),
            env: this.env,
            now: this.now(),
        });
        return {
            workspaceId,
            cwd,
            name: alias ?? (basename(cwd) || cwd),
            alias,
            pinned,
            hidden,
            trusted,
            exists,
            sessionCount: discovered?.sessionCount ?? 0,
            liveCount,
            lastActiveAt,
            instance,
            ...classification,
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
        return rootsFromEnv(this.env.PI2_WORKSPACE_ROOTS, this.home);
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

/* ------------------------------------------------------------------ */
/* Workspace visibility policy (derived, never persisted)              */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/** Built-in temp roots, in addition to `$TMPDIR` when it is set and absolute. */
const DEFAULT_TEMP_ROOTS: readonly string[] = ["/tmp", "/var/tmp", "/var/folders", "/private/var/folders"];

export interface ClassifyWorkspaceInput {
    cwd: string;
    hidden?: boolean | undefined;
    pinned?: boolean | undefined;
    trusted?: boolean | undefined;
    exists: boolean;
    lastActiveAt: number | null;
    /** Live instance for this workspace (`WorkspaceInfo.instance`). */
    instance?: InstanceState | null | undefined;
    /** Live sessions reported by the instance (`WorkspaceInfo.liveCount`). */
    liveCount?: number | undefined;
    /** Roots for the `outside-roots` rule; defaults to `PI2_WORKSPACE_ROOTS` / `$HOME`. */
    roots?: readonly string[] | undefined;
    /** Policy switches; defaults to `process.env`. */
    env?: WorkspaceEnv | undefined;
    /** Clock for `PI2_WORKSPACE_STALE_DAYS`; defaults to `Date.now()`. */
    now?: number | undefined;
}

export interface WorkspaceClassification {
    visibility: WorkspaceVisibility;
    visibilityReason?: WorkspaceVisibilityReason;
}

/**
 * Derive the workspace-noise policy for one row. Pure and non-persisted so the
 * same inputs always produce the same classification. Precedence (first match
 * wins):
 *
 *   1. `hidden`                          → secondary/hidden (explicit intent)
 *   2. live instance, pinned or trusted  → default (rescue)
 *   3. `PI2_WORKSPACE_HIDE_TEMP` (1)     → secondary/temp
 *   4. `PI2_WORKSPACE_HIDE_GHOSTS` (1)   → secondary/ghost
 *   5. `PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS` (0) → secondary/outside-roots
 *   6. `PI2_WORKSPACE_STALE_DAYS` (0=off)     → secondary/stale
 *   7. otherwise                         → default
 */
export function classifyWorkspace(input: ClassifyWorkspaceInput): WorkspaceClassification {
    const env = input.env ?? process.env;
    const cwd = typeof input.cwd === "string" ? input.cwd : "";
    const real = cwd.length > 0 ? realpathSafe(cwd) : "";

    if (input.hidden === true) return secondary("hidden");

    const liveCount = typeof input.liveCount === "number" && Number.isFinite(input.liveCount) ? input.liveCount : 0;
    if (input.instance != null || liveCount > 0 || input.pinned === true || input.trusted === true) {
        return { visibility: "default" };
    }

    if (parseBooleanEnv(env.PI2_WORKSPACE_HIDE_TEMP, true) && real !== "" && isTempPath(real, env)) {
        return secondary("temp");
    }

    if (parseBooleanEnv(env.PI2_WORKSPACE_HIDE_GHOSTS, true) && input.exists === false) {
        return secondary("ghost");
    }

    if (parseBooleanEnv(env.PI2_WORKSPACE_HIDE_OUTSIDE_ROOTS, false)) {
        // Both sides canonicalised, mirroring the `add()` allowlist.
        const roots = (input.roots ?? rootsFromEnv(env.PI2_WORKSPACE_ROOTS)).map((root) => realpathSafe(root));
        if (real !== "" && !roots.some((root) => isWithin(root, real))) return secondary("outside-roots");
    }

    const staleDays = parseNonNegativeInt(env.PI2_WORKSPACE_STALE_DAYS);
    if (staleDays > 0 && typeof input.lastActiveAt === "number" && Number.isFinite(input.lastActiveAt)) {
        const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
        if (now - input.lastActiveAt > staleDays * DAY_MS) return secondary("stale");
    }

    return { visibility: "default" };
}

/** `1/true/yes/on` enable, `0/false/no/off` disable, anything else → `fallback`. Never throws. */
export function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
    if (typeof raw !== "string") return fallback;
    const value = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(value)) return true;
    if (FALSE_VALUES.has(value)) return false;
    return fallback;
}

/** Non-negative integer days, or `0` (policy disabled) for garbage. Never throws. */
export function parseNonNegativeInt(raw: string | undefined): number {
    if (typeof raw !== "string") return 0;
    const value = raw.trim();
    if (!/^\d+$/.test(value)) return 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** `$TMPDIR` (when set) plus the platform defaults, realpath'd and deduped. */
export function tempRoots(env: WorkspaceEnv = process.env): string[] {
    const candidates = [env.TMPDIR, ...DEFAULT_TEMP_ROOTS];
    const roots: string[] = [];
    for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const value = candidate.trim();
        if (value.length === 0 || !isAbsolute(value)) continue;
        roots.push(realpathSafe(value));
    }
    return [...new Set(roots)];
}

/** True for a temp root itself or any path below one (both sides realpath'd). */
export function isTempPath(cwd: string, env: WorkspaceEnv = process.env): boolean {
    if (typeof cwd !== "string" || cwd.length === 0) return false;
    const real = realpathSafe(cwd);
    return tempRoots(env).some((root) => isWithin(root, real));
}

function secondary(reason: WorkspaceVisibilityReason): WorkspaceClassification {
    return { visibility: "secondary", visibilityReason: reason };
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

/** Keeps a user-supplied recent-session limit in a cheap, predictable range. */
function clampLimit(limit: number): number {
    if (!Number.isFinite(limit) || limit <= 0) return 20;
    return Math.min(200, Math.max(1, Math.floor(limit)));
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
