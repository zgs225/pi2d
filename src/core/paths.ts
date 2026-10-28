/**
 * Platform paths (Linux + macOS). Frozen — used by the daemon, the instance
 * supervisor and the CLI.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

export const IS_MAC = platform() === "darwin";

export function dataDir(): string {
    if (process.env.PI2_DATA_DIR) return process.env.PI2_DATA_DIR;
    if (IS_MAC) return join(homedir(), "Library", "Application Support", "pi2");
    return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "pi2");
}

export function runtimeDir(): string {
    if (process.env.PI2_RUNTIME_DIR) return process.env.PI2_RUNTIME_DIR;
    if (IS_MAC) return join(homedir(), "Library", "Caches", "pi2", "run");
    return join(process.env.XDG_RUNTIME_DIR ?? join(tmpdir(), `pi2-${process.getuid?.() ?? 0}`), "pi2");
}

export function stateDir(): string {
    if (process.env.PI2_STATE_DIR) return process.env.PI2_STATE_DIR;
    if (IS_MAC) return join(homedir(), "Library", "Logs", "pi2");
    return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "pi2");
}

/**
 * `~` → `home`, `~/…` → `home/…`, `~user/…` → `undefined` (never expanded),
 * anything else unchanged. Shared by the workspace allowlist and the plugin
 * probe so both accept exactly the same shorthand.
 */
export function expandTilde(raw: string, home: string = homedir()): string | undefined {
    if (raw === "~") return home;
    if (raw.startsWith("~/")) return join(home, raw.slice(2));
    if (raw.startsWith("~")) return undefined;
    return raw;
}

export function ensureDir(path: string, mode = 0o700): string {
    if (!existsSync(path)) mkdirSync(path, { recursive: true, mode });
    return path;
}

export const daemonSocketPath = () => join(ensureDir(runtimeDir()), "d.sock");
export const daemonTokenPath = () => join(runtimeDir(), "d.sock.token");
export const daemonLockPath = () => join(runtimeDir(), "daemon.lock");

export function instanceDir(): string {
    return ensureDir(join(runtimeDir(), "i"));
}

/** Unix socket paths are capped at ~104 bytes (macOS); always hash long ids. */
export function instanceSocketPath(workspaceId: string, instanceId: string): string {
    const hash = createHash("sha256").update(`${workspaceId}:${instanceId}`).digest("hex").slice(0, 16);
    return join(instanceDir(), `${hash}.sock`);
}

export type PathEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

/**
 * Pi session storage directory; where pi keeps `sessions/--<cwd>--/`.
 *
 * Resolution order:
 *   1. `PI2_CODING_AGENT_DIR` — pi2's documented override
 *   2. `PI_CODING_AGENT_DIR` — pi's own variable (injected by pi when it runs a child)
 *   3. `~/.pi/agent` — default location
 *
 * Empty strings are ignored (fall through to the next candidate).
 */
export function piAgentDir(env: PathEnv = process.env): string {
    const pi2 = env.PI2_CODING_AGENT_DIR;
    if (pi2 !== undefined && pi2 !== "") return pi2;
    const pi = env.PI_CODING_AGENT_DIR;
    if (pi !== undefined && pi !== "") return pi;
    return join(homedir(), ".pi", "agent");
}

export function sessionsRoot(env: PathEnv = process.env): string {
    return join(piAgentDir(env), "sessions");
}

export function readToken(): string | undefined {
    try {
        return readFileSync(daemonTokenPath(), "utf8").trim();
    } catch {
        return undefined;
    }
}

/** Best-effort realpath that never throws. */
export function realpathSafe(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

export function workspaceIdForCwd(cwd: string): string {
    return createHash("sha256").update(realpathSafe(cwd)).digest("hex").slice(0, 16);
}
