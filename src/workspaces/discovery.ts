/**
 * Read-only disk discovery for pi session directories.
 *
 * pi stores sessions at:
 *   `<PI_CODING_AGENT_DIR or ~/.pi/agent>/sessions/--<encoded-cwd>--/<ISO>_<id>.jsonl`
 *
 * The encoded directory name is not reversible (`-` is both a path character
 * and the separator), so the authoritative cwd is the first JSONL line:
 *   {"type":"session","version":3,"id":"…","timestamp":"…","cwd":"/abs/path"}
 *
 * Scanning is header-only (one read of up to 64 KiB per directory) and cached
 * per directory by (mtime, file count). The rest of a session file is never read.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { sessionsRoot, workspaceIdForCwd } from "../core/paths.js";

/** Maximum bytes read to obtain the first JSONL line. Headers are ~150 bytes. */
export const HEADER_READ_LIMIT = 64 * 1024;

export interface DiscoveredWorkspace {
    workspaceId: string;
    /** Authoritative cwd from the session header (not decoded from `dir`). */
    cwd: string;
    /** Number of `.jsonl` files in the encoded directory. */
    sessionCount: number;
    /** mtime (ms) of the newest session file, or null when unknown. */
    lastActiveAt: number | null;
    /** Absolute path of the `--<encoded-cwd>--` directory. */
    dir: string;
    /** False when the cwd in the header no longer exists (ghost workspace). */
    exists: boolean;
}

export interface SessionFile {
    /** Session id from the header, falling back to the file name suffix. */
    id: string;
    /** Absolute path to the `.jsonl` file. */
    file: string;
    /** Header timestamp in epoch ms (file-name fallback when the header is bad). */
    timestamp: number;
    /** File mtime in epoch ms. */
    modified: number;
    /**
     * Optional first user message preview. Deliberately not populated by the
     * cheap header-only scan; a name comes from the live instance later.
     */
    firstMessage?: string;
}

export interface DiscoveryOptions {
    /** Defaults to `sessionsRoot()`. */
    root?: string;
    logger?: DiscoveryLogger;
}

export interface DiscoveryLogger {
    debug?(msg: string, fields?: Record<string, unknown>): void;
    warn?(msg: string, fields?: Record<string, unknown>): void;
}

export interface Discovery {
    /** Scan every `--*--` directory under the sessions root. */
    discover(): DiscoveredWorkspace[];
    /** Session files for a cwd, newest first (header-only, cheap). */
    listSessions(cwd: string, limit?: number): SessionFile[];
    /** Drop one directory's cache entry, or the whole cache when omitted. */
    invalidate(dir?: string): void;
    /** The encoded directory used for a cwd, when it has been discovered. */
    dirForCwd(cwd: string): string | undefined;
}

interface CacheEntry {
    /** Signature component 1: directory mtime in ms. */
    mtimeMs: number;
    /** Signature component 2: number of `.jsonl` files in the directory. */
    size: number;
    result: DiscoveredWorkspace | null;
}

interface SessionFileInfo {
    file: string;
    mtimeMs: number;
    size: number;
}

interface SessionHeader {
    cwd?: string;
    id?: string;
    timestamp?: string;
}

export function isSessionDirName(name: string): boolean {
    return name.length > 4 && name.startsWith("--") && name.endsWith("--");
}

class DiskDiscovery implements Discovery {
    private readonly root: string;
    private readonly logger: DiscoveryLogger | undefined;
    private readonly cache = new Map<string, CacheEntry>();

    constructor(options: DiscoveryOptions = {}) {
        this.root = options.root ?? sessionsRoot();
        this.logger = options.logger;
    }

    discover(): DiscoveredWorkspace[] {
        let dirents;
        try {
            dirents = readdirSync(this.root, { withFileTypes: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "ENOTDIR") {
                this.logger?.warn?.("cannot read sessions root", {
                    root: this.root,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return [];
        }

        const out: DiscoveredWorkspace[] = [];
        for (const dirent of dirents) {
            if (!dirent.isDirectory() || !isSessionDirName(dirent.name)) continue;
            const result = this.scanDir(join(this.root, dirent.name));
            if (result) out.push({ ...result });
        }
        return out;
    }

    listSessions(cwd: string, limit?: number): SessionFile[] {
        if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) return [];
        const workspaceId = workspaceIdForCwd(cwd);
        const dirs = this.discover()
            .filter((entry) => entry.workspaceId === workspaceId)
            .map((entry) => entry.dir);
        if (dirs.length === 0) return [];

        // Sort the raw file descriptors first so a `limit` reads only the headers
        // of the newest files instead of every session in the workspace.
        const infos: SessionFileInfo[] = [];
        const seen = new Set<string>();
        for (const dir of dirs) {
            for (const info of this.sessionFiles(dir)) {
                if (seen.has(info.file)) continue;
                seen.add(info.file);
                infos.push(info);
            }
        }
        infos.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
        const selected = limit !== undefined && limit > 0 ? infos.slice(0, limit) : infos;

        const sessions = selected.map((info) => this.describeSession(info));
        sessions.sort((a, b) => b.modified - a.modified || b.timestamp - a.timestamp || a.id.localeCompare(b.id));
        return sessions;
    }

    invalidate(dir?: string): void {
        if (dir === undefined) this.cache.clear();
        else this.cache.delete(dir);
    }

    dirForCwd(cwd: string): string | undefined {
        if (typeof cwd !== "string" || !isAbsolute(cwd)) return undefined;
        const workspaceId = workspaceIdForCwd(cwd);
        return this.discover().find((entry) => entry.workspaceId === workspaceId)?.dir;
    }

    private scanDir(dir: string): DiscoveredWorkspace | null {
        let dirStat;
        try {
            dirStat = statSync(dir);
        } catch {
            return null;
        }
        if (!dirStat.isDirectory()) return null;

        const files = this.sessionFiles(dir);
        const cached = this.cache.get(dir);
        if (cached && cached.mtimeMs === dirStat.mtimeMs && cached.size === files.length) {
            return cached.result ? { ...cached.result } : null;
        }

        const newest = files[0];
        let result: DiscoveredWorkspace | null = null;
        if (newest) {
            // Newest by mtime, falling back to older files only when the newest
            // header is unreadable (e.g. a truncated write).
            let header: SessionHeader | undefined;
            for (const file of files) {
                header = readSessionHeader(file.file);
                if (header?.cwd) break;
            }

            if (header?.cwd && isAbsolute(header.cwd)) {
                result = {
                    workspaceId: workspaceIdForCwd(header.cwd),
                    cwd: header.cwd,
                    sessionCount: files.length,
                    lastActiveAt: newest.mtimeMs,
                    dir,
                    exists: isDirectory(header.cwd),
                };
            } else {
                this.logger?.debug?.("skipping session directory without a usable header", { dir });
            }
        }

        this.cache.set(dir, {
            mtimeMs: dirStat.mtimeMs,
            size: files.length,
            result: result ? { ...result } : null,
        });
        return result;
    }

    /** `.jsonl` files in a directory, newest first. Never reads file contents. */
    private sessionFiles(dir: string): SessionFileInfo[] {
        let dirents;
        try {
            dirents = readdirSync(dir, { withFileTypes: true });
        } catch {
            return [];
        }

        const files: SessionFileInfo[] = [];
        for (const dirent of dirents) {
            if (!dirent.name.endsWith(".jsonl")) continue;
            const file = join(dir, dirent.name);
            try {
                const stat = statSync(file);
                if (!stat.isFile()) continue;
                files.push({ file, mtimeMs: stat.mtimeMs, size: stat.size });
            } catch {
                // Vanished or unreadable file: keep scanning the rest of the dir.
            }
        }
        files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.size - a.size);
        return files;
    }

    private describeSession(info: SessionFileInfo): SessionFile {
        const header = readSessionHeader(info.file);
        const fromName = parseSessionFileName(info.file);
        const id = header?.id ?? fromName.id;
        const headerTs = header?.timestamp ? Date.parse(header.timestamp) : Number.NaN;
        const timestamp = Number.isFinite(headerTs) ? headerTs : fromName.timestamp;
        return {
            id,
            file: info.file,
            timestamp,
            modified: info.mtimeMs,
        };
    }
}

export function createDiscovery(options: DiscoveryOptions = {}): Discovery {
    return new DiskDiscovery(options);
}

function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** Read only the first JSONL line; returns undefined for unreadable/invalid files. */
function readSessionHeader(file: string): SessionHeader | undefined {
    let fd: number | undefined;
    try {
        fd = openSync(file, "r");
        const buffer = Buffer.allocUnsafe(HEADER_READ_LIMIT);
        const bytes = readSync(fd, buffer, 0, HEADER_READ_LIMIT, 0);
        if (bytes <= 0) return undefined;

        const text = buffer.toString("utf8", 0, bytes);
        const newline = text.indexOf("\n");
        const line = (newline >= 0 ? text.slice(0, newline) : text).replace(/\r$/, "").trim();
        if (line.length === 0) return undefined;

        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || (parsed as { type?: unknown }).type !== "session") {
            return undefined;
        }
        const record = parsed as Record<string, unknown>;
        return {
            cwd: typeof record.cwd === "string" ? record.cwd : undefined,
            id: typeof record.id === "string" ? record.id : undefined,
            timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
        };
    } catch {
        return undefined;
    } finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            } catch {
                // ignore
            }
        }
    }
}

/** `<YYYY-MM-DDTHH-MM-SS-mmmZ>_<id>.jsonl` → `{ id, timestamp }`. */
export function parseSessionFileName(file: string): { id: string; timestamp: number } {
    const name = basename(file).replace(/\.jsonl$/, "");
    const separator = name.indexOf("_");
    if (separator < 0) return { id: name, timestamp: 0 };

    const stamp = name.slice(0, separator);
    const id = name.slice(separator + 1);
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
    if (!match) {
        const fallback = Date.parse(stamp);
        return { id, timestamp: Number.isFinite(fallback) ? fallback : 0 };
    }
    const [, year, month, day, hour, minute, second, millis] = match;
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
    const timestamp = Date.parse(iso);
    return { id, timestamp: Number.isFinite(timestamp) ? timestamp : 0 };
}

// ---------------------------------------------------------------------------
// Module-level convenience API (shared cache keyed by sessions root).
// ---------------------------------------------------------------------------

const shared = new Map<string, Discovery>();

function sharedDiscovery(root: string | undefined, logger?: DiscoveryLogger): Discovery {
    const key = root ?? sessionsRoot();
    const existing = shared.get(key);
    if (existing) return existing;
    const created = createDiscovery({ root: key, ...(logger ? { logger } : {}) });
    shared.set(key, created);
    return created;
}

export function discoverWorkspaces(options: DiscoveryOptions = {}): DiscoveredWorkspace[] {
    return sharedDiscovery(options.root, options.logger).discover();
}

export function listSessions(cwd: string, options: DiscoveryOptions = {}, limit?: number): SessionFile[] {
    return sharedDiscovery(options.root, options.logger).listSessions(cwd, limit);
}

/** Drop cached discovery results for every root (or one directory). */
export function invalidate(dir?: string): void {
    for (const discovery of shared.values()) discovery.invalidate(dir);
}
