/**
 * Kind → spec registry — all 11 registered kinds (prototype `core.js` registry).
 *
 * `web` / `vision` / `plan` / `subagent` are still owned by WS-E: until those families
 * land they resolve to the `generic` spec (JSON input/result), which is the contract's
 * safe fallback — never blank, never throws.
 */
import { readSpec, writeSpec } from "./families/file";
import { genericSpec } from "./families/generic";
import { findSpec, searchSpec } from "./families/search";
import { shellSpec, taskSpec } from "./families/shell";
import type { FamilyId, ToolSpec } from "./types";

export const REGISTRY: Record<FamilyId, ToolSpec> = {
    shell: shellSpec,
    task: taskSpec,
    read: readSpec,
    write: writeSpec,
    search: searchSpec,
    find: findSpec,
    // TODO(WS-E): dedicated `web` spec — target from query/url, sources + preview body.
    web: genericSpec,
    // TODO(WS-E): dedicated `vision` spec — thumbnails + description body.
    vision: genericSpec,
    // TODO(WS-E): dedicated `plan` spec — todo list body + counts fact.
    plan: genericSpec,
    // TODO(WS-E): dedicated `subagent` spec — dispatch/inline modes + batch card body.
    subagent: genericSpec,
    generic: genericSpec,
};

/** Never throws: unknown ids fall back to the generic spec. */
export function specFor(kind: FamilyId | string | null | undefined): ToolSpec {
    const key = String(kind ?? "") as FamilyId;
    return REGISTRY[key] ?? REGISTRY.generic;
}
