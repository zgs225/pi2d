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

function findCreated(list: WorkspaceInfo[], cwd: string, name: string): WorkspaceInfo | undefined {
    const exact = list.find((item) => item.cwd === cwd && (name ? item.name === name : true));
    if (exact) return exact;
    return list.find((item) => item.cwd === cwd);
}

/**
 * `workspace.add` → resolve the new workspace id (the command response is not
 * required to carry it, so fall back to a fresh GET) → `instance.ensure`.
 */
export async function openWorkspace(input: { cwd: string; name?: string }): Promise<string> {
    const cwd = input.cwd.trim();
    const name = input.name?.trim() ?? "";
    const added = (await api.command({
        method: "workspace.add",
        params: { cwd, ...(name ? { name } : {}) },
    })) as unknown as CommandResult;

    let workspaceId = extractWorkspaceId(added);
    if (!workspaceId) {
        const list = await api.workspaces();
        workspaceId = findCreated(list, cwd, name)?.workspaceId;
    }
    if (!workspaceId) {
        throw new Error("workspace.add returned no workspace id");
    }

    await api.command({ method: "instance.ensure", params: { workspaceId } });
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
