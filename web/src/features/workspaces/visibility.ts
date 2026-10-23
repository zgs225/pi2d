/**
 * Workspace-noise policy, browser side.
 *
 * The daemon classifies every row (`visibility: "default" | "secondary"` +
 * `visibilityReason`) but never filters the list, so `/workspace/<id>` deep
 * links keep resolving. This module only partitions the served rows for
 * list/picker surfaces: `primary` is what the user normally wants, `secondary`
 * is noise (explicitly hidden, ghosts, temp dirs, …) behind a toggle.
 */

import type { WorkspaceInfo } from "@/lib/protocol";

/** Persisted toggle: "show N hidden" on the workspaces page. */
export const SHOW_ALL_STORAGE_KEY = "pi2-workspaces-show-all";

export interface WorkspacePartition {
    primary: WorkspaceInfo[];
    secondary: WorkspaceInfo[];
}

/** Legacy daemons omit `visibility`; `hidden` alone still means secondary. */
export function isSecondary(workspace: WorkspaceInfo): boolean {
    if (workspace.visibility === "secondary") return true;
    return workspace.hidden === true;
}

/** Reason for the badge; `hidden` is inferred for pre-classification daemons. */
export function visibilityReason(workspace: WorkspaceInfo): string | null {
    if (typeof workspace.visibilityReason === "string" && workspace.visibilityReason.length > 0) {
        return workspace.visibilityReason;
    }
    return workspace.hidden === true ? "hidden" : null;
}

/** i18n key for the reason badge (or `null` for a default row). */
export function reasonLabelKey(workspace: WorkspaceInfo): string | null {
    const reason = visibilityReason(workspace);
    return reason === null ? null : `workspaces.reason.${reason}`;
}

/** Split served rows into the normal list and the collapsed noise. */
export function partitionWorkspaces(list: readonly WorkspaceInfo[], _showAll = false): WorkspacePartition {
    const primary: WorkspaceInfo[] = [];
    const secondary: WorkspaceInfo[] = [];
    for (const workspace of list) {
        if (isSecondary(workspace)) secondary.push(workspace);
        else primary.push(workspace);
    }
    return { primary, secondary };
}

/** How many rows the "show N hidden" toggle would reveal (0 hides the toggle). */
export function countSecondary(list: readonly WorkspaceInfo[]): number {
    return partitionWorkspaces(list).secondary.length;
}

/** `localStorage` read; default off and any failure means off. */
export function readShowAll(): boolean {
    try {
        return localStorage.getItem(SHOW_ALL_STORAGE_KEY) === "1";
    } catch {
        return false;
    }
}

/** `localStorage` write; storage failures must never break the page. */
export function writeShowAll(showAll: boolean): void {
    try {
        localStorage.setItem(SHOW_ALL_STORAGE_KEY, showAll ? "1" : "0");
    } catch {
        // private mode / quota: the in-memory toggle still works
    }
}
