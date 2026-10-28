import { api } from "@/lib/api";
import type { WorkspaceInfo } from "@/lib/protocol";

interface CommandResult {
    accepted?: boolean;
    disposition?: string;
    workspaceId?: string;
    workspace?: { workspaceId?: string };
    result?: { workspaceId?: string; workspace?: { workspaceId?: string } };
    instance?: { workspaceId?: string };
    [key: string]: unknown;
}

function extractWorkspaceId(result: CommandResult): string | undefined {
    return (
        result.workspaceId ||
        result.workspace?.workspaceId ||
        result.result?.workspaceId ||
        result.result?.workspace?.workspaceId ||
        result.instance?.workspaceId
    );
}

/** Trailing slashes are noise; the daemon stores the canonical path either way. */
function samePath(a: string, b: string): boolean {
    const normalize = (value: string) => value.trim().replace(/\/+$/, "");
    return normalize(a) === normalize(b);
}

function matchesName(workspace: WorkspaceInfo, name: string): boolean {
    return (workspace.name?.trim() || workspace.alias?.trim()) === name;
}

function findCreated(list: WorkspaceInfo[], cwd: string, name: string): WorkspaceInfo | undefined {
    // `~` paths never match on cwd (the daemon expands them), so fall back to the
    // display name the caller just typed.
    const byPathAndName = list.find((item) => samePath(item.cwd, cwd) && (name ? matchesName(item, name) : true));
    if (byPathAndName) return byPathAndName;
    const byPath = list.find((item) => samePath(item.cwd, cwd));
    if (byPath) return byPath;
    return name ? list.find((item) => matchesName(item, name)) : undefined;
}

/**
 * `workspace.add` succeeded but its instance did not start. The workspace id is
 * already known, so the dialog can retry `instance.ensure` without adding twice.
 */
export class InstanceStartError extends Error {
    readonly workspaceId: string;
    /** Whatever `instance.ensure` threw (usually an `ApiError`). */
    readonly detail: unknown;

    constructor(workspaceId: string, detail: unknown) {
        super(detail instanceof Error ? detail.message : String(detail));
        this.name = "InstanceStartError";
        this.workspaceId = workspaceId;
        this.detail = detail;
    }
}

/** `instance.ensure` is idempotent (docs/protocol.md §3), so retrying it is safe. */
export async function ensureInstance(workspaceId: string): Promise<void> {
    await api.command({ method: "instance.ensure", params: { workspaceId } });
}

/**
 * `workspace.add` → resolve the new workspace id (the command response is not
 * required to carry it, so fall back to a fresh GET) → `instance.ensure`.
 *
 * The daemon owns path expansion: `~/…` and `~` are sent verbatim and resolved
 * there, and the display name travels as `alias` (the field it persists).
 */
export async function openWorkspace(input: { cwd: string; name?: string }): Promise<string> {
    const cwd = input.cwd.trim();
    const name = input.name?.trim() ?? "";
    const added = (await api.command({
        method: "workspace.add",
        params: { cwd, ...(name ? { alias: name } : {}) },
    })) as unknown as CommandResult;

    let workspaceId = extractWorkspaceId(added);
    if (!workspaceId) {
        const list = await api.workspaces();
        workspaceId = findCreated(list, cwd, name)?.workspaceId;
    }
    if (!workspaceId) {
        throw new Error("workspace.add returned no workspace id");
    }

    try {
        await ensureInstance(workspaceId);
    } catch (error) {
        throw new InstanceStartError(workspaceId, error);
    }
    return workspaceId;
}

/** Display name: explicit name → alias → last cwd segment → untitled. */
export function workspaceName(workspace: WorkspaceInfo, unnamed = "Untitled"): string {
    const explicit = workspace.name?.trim() || workspace.alias?.trim();
    if (explicit) return explicit;
    const cwd = String(workspace.cwd || "").replace(/\/+$/, "");
    const segments = cwd.split("/");
    return segments[segments.length - 1] || cwd || unnamed;
}

export function workspaceSessionCount(workspace: WorkspaceInfo): number {
    return Math.max(workspace.liveCount || 0, workspace.sessionCount || 0);
}
