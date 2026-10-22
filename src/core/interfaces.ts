/**
 * Frozen internal interfaces between the daemon surfaces.
 *
 * Owners:
 *   - `src/core/**`            (orchestrator, frozen)
 *   - `src/daemon/**`          W1 (HTTP/WS/SSE/auth/static/router)
 *   - `src/instances/**`       W2 (supervisor: one managed nvim per workspace)
 *   - `src/workspaces/**`      W3 (registry + disk discovery)
 *   - `src/cli/**`             W8 (pi2 / daemon commands)
 *
 * Do not change these shapes without updating `docs/protocol.md`.
 */

import type { InstanceState, SessionState, WorkspaceInfo } from "../protocol/types.js";

/** One connected plugin (an nvim process running pi2.nvim). */
export interface PluginConnection {
    readonly instanceId: string;
    readonly workspaceId: string;
    readonly cwd: string;
    readonly pid: number;
    readonly hasUI: boolean;
    readonly listenAddr: string | null;
    readonly pluginVersion: string;
    /** Send one JSONL record to the plugin. */
    send(record: Record<string, unknown>): void;
    /** Forward a command; resolves with the plugin `ack` payload. */
    command(
        cmd: { id: string; sessionId?: string; method: string; params?: Record<string, unknown>; clientRequestId?: string },
        timeoutMs?: number,
    ): Promise<{ seq?: number; disposition?: string } & Record<string, unknown>>;
    subscribe(sessionId: string): void;
    unsubscribe(sessionId: string): void;
    /** Last snapshot received for a session (render cache, may be undefined). */
    snapshot(sessionId: string): SessionState | undefined;
    /** Last seq received for a session. */
    lastSeq(sessionId: string): number;
    close(reason: string): void;
}

export interface InstanceManager {
    /** Idempotently make the workspace instance ready; resolves once `hello` arrived. */
    ensure(workspaceId: string, opts?: { timeoutMs?: number }): Promise<InstanceState>;
    shutdown(workspaceId: string, mode: "drain" | "stop"): Promise<void>;
    /** Currently connected instance for a workspace, if any. */
    get(workspaceId: string): PluginConnection | undefined;
    list(): InstanceState[];
    /** Workspaces that currently have a managed instance. */
    instanceStates(): InstanceState[];
    /** Find the workspace that owns a session according to live instances. */
    findWorkspaceBySession(sessionId: string): string | undefined;
    /** Resources for `/api/v1/resources`. */
    resources(): Promise<InstanceResourcesSnapshot>;
    /** Called by the daemon when the last browser subscriber for a session goes away. */
    maybeUnsubscribe(workspaceId: string, sessionId: string): void;
    onInstanceChange(handler: (state: InstanceState) => void): void;
}

export interface InstanceResourcesSnapshot {
    instances: {
        workspaceId: string;
        instanceId: string;
        nvimPid: number | null;
        rssBytes: number | null;
        sessions: number;
        hasUI: boolean;
    }[];
    totalRssBytes: number;
    physicalMemoryBytes: number;
    /** Soft warning threshold reached (instances > 8 or RSS > 60%). */
    warn: boolean;
    reason?: string;
}

export interface WorkspaceStore {
    /** Registry entries merged with disk discovery and instance state. */
    list(): WorkspaceInfo[];
    get(workspaceId: string): WorkspaceInfo | undefined;
    byCwd(cwd: string): WorkspaceInfo | undefined;
    add(input: { cwd: string; alias?: string; trust?: boolean }): Promise<WorkspaceInfo>;
    update(workspaceId: string, patch: Partial<{ alias: string | null; pinned: boolean; hidden: boolean; trusted: boolean }>): Promise<WorkspaceInfo>;
    /** Removes the registry entry only; never touches session files. */
    remove(workspaceId: string): Promise<void>;
    refresh(workspaceId?: string): Promise<void>;
    /** Ensure a workspace exists for a cwd (used when an instance connects). */
    ensureForCwd(cwd: string): Promise<WorkspaceInfo>;
}

/** Minimal event bus used by the daemon to fan plugin records out to browsers. */
export interface Bus {
    publish(record: Record<string, unknown>): void;
    subscribe(handler: (record: Record<string, unknown>) => void): () => void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface Logger {
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
    child(fields: Record<string, unknown>): Logger;
}
