/**
 * State normalization — one state, one meaning (design/CHAT-TOOL-RENDER.md §3).
 *
 * `pending`/`queued` is *not* "running": it renders with the completed tense and a
 * static dot, never a spinner. Unknown or missing states degrade to `done`
 * (CHG-09), never to a spinner.
 */
import type { ToolState } from "./types";

export const STATE_ALIAS: Record<string, ToolState> = {
    running: "running",
    spinning: "running",
    in_progress: "running",
    "in-progress": "running",
    pending: "queued",
    queued: "queued",
    done: "done",
    completed: "done",
    success: "done",
    ok: "done",
    failed: "failed",
    error: "failed",
    err: "failed",
    timeout: "timeout",
    timed_out: "timeout",
    interrupted: "interrupted",
    aborted: "interrupted",
    rejected: "rejected",
    cancelled: "cancelled",
    canceled: "cancelled",
    stopped: "cancelled",
};

/** Canonical state → aria state word (`state.*` / `chat.meta.*` key). */
export const STATE_KEY: Record<ToolState, string> = {
    running: "state.running",
    queued: "state.queued",
    done: "state.completed",
    failed: "state.failed",
    interrupted: "state.interrupted",
    timeout: "chat.meta.timedOut",
    rejected: "chat.meta.rejected",
    cancelled: "state.stopped",
};

/** Accepts a `ToolView`-like object, a raw state string, or nothing. */
export function stateOf(tool?: { state?: string | null } | string | null): ToolState {
    const raw = typeof tool === "string" ? tool : String(tool?.state ?? "");
    return STATE_ALIAS[raw.trim().toLowerCase()] ?? "done";
}

export function isFailure(state: ToolState): boolean {
    return state === "failed" || state === "timeout";
}

export function isRunning(state: ToolState): boolean {
    return state === "running";
}

/** Interrupted / rejected / cancelled: no error line unless the tool gave a reason. */
export function isSoft(state: ToolState): boolean {
    return state === "interrupted" || state === "rejected" || state === "cancelled";
}
