/**
 * Where the pi2.nvim plugin lives on disk.
 *
 * The daemon spawns `nvim --headless -u <generated init>` and that init must be
 * able to `require("pi.host")`. Getting this wrong is invisible from the daemon
 * side: nvim stays alive, prints into a log nobody reads, and the browser only
 * sees a 10 s "did not say hello" timeout. So plugin discovery is a first-class
 * probe with an explicit, ordered candidate list and a human failure line — used
 * by the supervisor (spawn refusal) and by `pi2 doctor`.
 *
 * A directory counts as a plugin only when it is *host-capable*: it must ship
 * both `lua/pi/host.lua` (the daemon bridge entry point) and
 * `lua/pi/web/bridge.lua` (the session bridge). Older checkouts that only carry
 * one of the two are reported, never silently used, because `host.start()`
 * would fail again on the next `require`.
 */

import { existsSync, readdirSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTilde } from "./paths.js";

/** Directory name the plugin is installed under (lazy.nvim, pack/*\/start, …). */
export const PLUGIN_NAME = "pi2.nvim";

/** Entry points that every usable plugin checkout must contain. */
export const PLUGIN_HOST_FILE = join("lua", "pi", "host.lua");
export const PLUGIN_BRIDGE_FILE = join("lua", "pi", "web", "bridge.lua");

/** One explored location, classified against the host-capability contract. */
export interface PluginDirCandidate {
    dir: string;
    reason: "ok" | "missing-host" | "missing-bridge" | "absent";
}

/** A confirmed host-capable plugin checkout. */
export interface ResolvedPlugin {
    dir: string;
    host: string;
    bridge: string;
}

export type PluginResolution =
    | { plugin: ResolvedPlugin }
    | {
          plugin: undefined;
          candidates: PluginDirCandidate[];
          /** The `PI2_PLUGIN_DIR` value that was probed first, if any. */
          configured: string | undefined;
      };

type Readdir = (dir: string, options: { withFileTypes: true }) => Dirent[];

export interface ResolvePluginDirOptions {
    /** Defaults to `process.env` (`PI2_PLUGIN_DIR` is read from it). */
    env?: Record<string, string | undefined>;
    /** Defaults to `homedir()`; also used to expand a leading `~/`. */
    home?: string;
    /** Defaults to `existsSync`; injected in tests to stay hermetic. */
    exists?: (path: string) => boolean;
    /** Defaults to `readdirSync`; enumerates `site/pack/*\/{start,opt}`. */
    readdir?: Readdir;
}

const defaultReaddir: Readdir = (dir, options) => readdirSync(dir, options);

/**
 * `site/pack/<name>/{start,opt}/pi2.nvim` for one nvim data directory.
 *
 * `readdir` must never throw here: a stock nvim has no `site/pack` at all, and a
 * missing directory is the normal case, not an error worth surfacing.
 */
function packCandidates(dataDir: string, readdir: Readdir): string[] {
    const root = join(dataDir, "site", "pack");
    let entries: Dirent[];
    try {
        entries = readdir(root, { withFileTypes: true });
    } catch {
        return [];
    }
    const dirs: string[] = [];
    for (const kind of ["start", "opt"] as const) {
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            dirs.push(join(root, entry.name, kind, PLUGIN_NAME));
        }
    }
    return dirs;
}

/**
 * Ordered list of directories that could hold the plugin.
 *
 * `PI2_PLUGIN_DIR` first (explicit user intent beats discovery), then the
 * lazy.nvim default, then `pack/*\/start` before `pack/*\/opt` (start packages
 * are the ones that are actually loaded at startup), user data dir before the
 * system-wide ones.
 */
export function pluginDirCandidates(options: ResolvePluginDirOptions = {}): string[] {
    const env = options.env ?? process.env;
    const home = options.home ?? homedir();
    const readdir = options.readdir ?? defaultReaddir;

    const dirs: string[] = [];
    const configured = env.PI2_PLUGIN_DIR?.trim();
    if (configured !== undefined && configured !== "") {
        dirs.push(resolve(expandTilde(configured, home) ?? configured));
    }

    const userNvim = join(home, ".local", "share", "nvim");
    dirs.push(join(userNvim, "lazy", PLUGIN_NAME));
    for (const dataDir of [userNvim, "/usr/share/nvim", "/usr/local/share/nvim"]) {
        dirs.push(...packCandidates(dataDir, readdir));
    }

    // `PI2_PLUGIN_DIR` may name the same directory lazy.nvim would have found;
    // keep the first occurrence so the reported order matches the probe order.
    return [...new Set(dirs)];
}

/** Classifies one directory; a match needs BOTH entry points. */
export function classifyPluginDir(
    dir: string,
    exists: (path: string) => boolean = existsSync,
): PluginDirCandidate {
    if (!exists(dir)) return { dir, reason: "absent" };
    if (!exists(join(dir, PLUGIN_HOST_FILE))) return { dir, reason: "missing-host" };
    if (!exists(join(dir, PLUGIN_BRIDGE_FILE))) return { dir, reason: "missing-bridge" };
    return { dir, reason: "ok" };
}

/**
 * Finds the first host-capable plugin checkout.
 *
 * Returns the winning `ResolvedPlugin` or every candidate with its verdict, so
 * the caller can explain *why* nothing matched instead of shouting "not found"
 * at a user whose lazy.nvim simply has not installed the plugin yet.
 */
export function resolvePluginDir(options: ResolvePluginDirOptions = {}): PluginResolution {
    const home = options.home ?? homedir();
    const exists = options.exists ?? existsSync;
    const candidates = pluginDirCandidates({ ...options, home }).map((dir) => classifyPluginDir(dir, exists));
    const match = candidates.find((candidate) => candidate.reason === "ok");
    if (match === undefined) {
        const configured = (options.env ?? process.env).PI2_PLUGIN_DIR?.trim();
        return {
            plugin: undefined,
            candidates: [...candidates],
            configured: configured === undefined || configured === "" ? undefined : candidates[0]?.dir,
        };
    }
    return {
        plugin: {
            dir: match.dir,
            host: join(match.dir, PLUGIN_HOST_FILE),
            bridge: join(match.dir, PLUGIN_BRIDGE_FILE),
        },
    };
}

/** Collapses the home directory to `~` so messages stay readable. */
export function displayPath(path: string, home: string = homedir()): string {
    if (path === home) return "~";
    const prefix = `${home}/`;
    if (path.startsWith(prefix)) return `~/${path.slice(prefix.length)}`;
    return path;
}

/**
 * One human line explaining a failed plugin resolution.
 *
 * An explicitly configured `PI2_PLUGIN_DIR` is named first: a typo there is the
 * one failure the user can fix in seconds, and blaming a stale lazy.nvim
 * checkout instead sends them looking in the wrong place.
 *
 * Failing that, a stale checkout (present, but without `host.lua`/`bridge.lua`)
 * is the case users hit after a plugin update and the one a bare "not found"
 * hides, so it is reported before the generic message.
 */
export function describePluginFailure(
    candidates: readonly PluginDirCandidate[],
    options: { configured?: string | undefined } = {},
): string {
    const home = homedir();
    const configured =
        options.configured === undefined
            ? undefined
            : candidates.find((candidate) => candidate.dir === options.configured);
    if (configured !== undefined && configured.reason !== "ok") {
        const path = displayPath(configured.dir, home);
        if (configured.reason === "absent") return `PI2_PLUGIN_DIR=${path} does not exist`;
        const what = configured.reason === "missing-host" ? PLUGIN_HOST_FILE : PLUGIN_BRIDGE_FILE;
        return `PI2_PLUGIN_DIR=${path} has no ${what} (update the plugin)`;
    }

    const broken = candidates.find(
        (candidate) => candidate.reason === "missing-host" || candidate.reason === "missing-bridge",
    );
    if (broken !== undefined) {
        const what = broken.reason === "missing-host" ? PLUGIN_HOST_FILE : PLUGIN_BRIDGE_FILE;
        return `${PLUGIN_NAME} at ${displayPath(broken.dir, home)} has no ${what} (update the plugin)`;
    }
    const first = candidates[0];
    const seen = candidates.length === 0 ? "no locations" : `${candidates.length} location(s)`;
    return first === undefined
        ? `no ${PLUGIN_NAME} plugin found (looked in ${seen})`
        : `no ${PLUGIN_NAME} plugin found (looked in ${seen}, first ${displayPath(first.dir, home)})`;
}
