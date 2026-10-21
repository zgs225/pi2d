import type { CommandRequest, ModelRef, ThinkingLevel } from "@protocol/types";
import { api } from "@/lib/api";

export interface PromptImage {
    mimeType: string;
    data: string;
}

/**
 * `prompt.send` mode. The plugin maps it to pi's RPC command
 * (`follow_up` → queue, `steer` → interrupt the run); omit it for a plain
 * `prompt`.
 */
export type PromptMode = "follow_up" | "steer";

/**
 * `attention.respond` answer, forwarded verbatim to the plugin
 * (`pi.attention.resolve`): `{value}` for select/input/editor, `{confirmed}`
 * for confirm, `{cancelled}` for a dismissal.
 */
export type AttentionResponse = { value: unknown } | { confirmed: boolean } | { cancelled: true };

export interface ChatCommand extends CommandRequest {
    method: string;
}

function requestId(): string | undefined {
    try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch {
        /* older browsers */
    }
    return undefined;
}

function command(method: string, sessionId: string | undefined, params?: Record<string, unknown>): ChatCommand {
    const clientRequestId = requestId();
    return {
        method,
        ...(sessionId ? { sessionId } : {}),
        ...(params ? { params } : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
    };
}

/**
 * Command payload builders for `POST /api/v1/cmd`.
 *
 * Parameter names follow the plugin handlers
 * (`pi2.nvim-web/lua/pi/web/commands.lua`), which are the authority for every
 * payload shape here.
 */
export const chatCommands = {
    /** `mode` omitted → a plain prompt; `follow_up` queues, `steer` interrupts. */
    sendPrompt: (sessionId: string, text: string, images: PromptImage[] = [], mode?: PromptMode): ChatCommand =>
        command("prompt.send", sessionId, {
            text,
            ...(mode ? { mode } : {}),
            ...(images.length ? { images } : {}),
        }),

    abort: (sessionId: string): ChatCommand => command("prompt.abort", sessionId, {}),

    /** Queue entries are addressed by pi's queue id (`queue[i].id`). */
    removeQueued: (sessionId: string, id: string): ChatCommand => command("queue.remove", sessionId, { id }),

    /** Steering is a session-wide mode, not a per-message flag. */
    setQueueSteer: (sessionId: string, steer: boolean): ChatCommand =>
        command("queue.setSteer", sessionId, { mode: steer ? "all" : "one-at-a-time" }),

    setModel: (sessionId: string, model: ModelRef): ChatCommand =>
        command("session.setModel", sessionId, { model: { provider: model.provider, id: model.id } }),

    setThinking: (sessionId: string, level: ThinkingLevel): ChatCommand =>
        command("session.setThinking", sessionId, { level }),

    renameSession: (sessionId: string, name: string): ChatCommand => command("session.rename", sessionId, { name }),

    closeSession: (sessionId: string): ChatCommand => command("session.close", sessionId, { mode: "close" }),

    createSession: (workspaceId: string): ChatCommand => command("session.create", undefined, { workspaceId }),

    respondAttention: (sessionId: string, requestIdValue: string, response: AttentionResponse | string): ChatCommand =>
        command("attention.respond", sessionId, { requestId: requestIdValue, response }),

    /** One batch item per dispatch; the plugin's snake_case params are literal. */
    dispatchSubagent: (
        sessionId: string,
        input: {
            task: string;
            name?: string;
            model?: ModelRef;
            thinking?: ThinkingLevel;
            wait?: boolean;
            cancelSiblingsOnFail?: boolean;
        },
    ): ChatCommand =>
        command("subagent.dispatch", sessionId, {
            items: [
                {
                    task: input.task,
                    ...(input.name ? { name: input.name } : {}),
                    ...(input.model ? { model: input.model } : {}),
                    ...(input.thinking ? { thinking_level: input.thinking } : {}),
                },
            ],
            wait: input.wait === true,
            cancel_siblings_on_fail: input.cancelSiblingsOnFail === true,
        }),

    steerSubagent: (sessionId: string, target: string, message: string): ChatCommand =>
        command("subagent.steer", sessionId, { target, message }),

    readSubagent: (sessionId: string, target: string): ChatCommand =>
        command("subagent.read", sessionId, { target }),

    stopTask: (sessionId: string, taskId: string): ChatCommand => command("task.stop", sessionId, { taskId }),

    taskOutput: (sessionId: string, taskId: string): ChatCommand => command("task.output", sessionId, { taskId }),
};

export type CommandResult = { accepted?: boolean; disposition?: string; [key: string]: unknown };

/** Execute one command; errors surface as `ApiError` with a stable code. */
export async function runCommand(command: ChatCommand, signal?: AbortSignal): Promise<CommandResult> {
    return api.command(command, signal) as Promise<CommandResult>;
}

/** `select` / `input` / `editor` answer: the chosen option id (or typed value). */
export function selectResponse(value: string): AttentionResponse {
    return { value };
}

/** `confirm` answer: an explicit yes/no. */
export function confirmResponse(confirmed: boolean): AttentionResponse {
    return { confirmed };
}

/** Dismiss/deny without choosing anything (the plugin's `cancelled` path). */
export function cancelResponse(): AttentionResponse {
    return { cancelled: true };
}

/**
 * Diff review answer: `pi.ui.diff` decodes the **value** as JSON
 * `{result, path?}`, so the caller wraps it in `{value}` before sending.
 */
export function diffResponse(result: "Accepted" | "Rejected", path?: string): string {
    return JSON.stringify({ result, ...(path ? { path } : {}) });
}

/** `attention.respond` answer for an accept/reject of the diff review. */
export function diffAnswer(result: "Accepted" | "Rejected", path?: string): AttentionResponse {
    return { value: diffResponse(result, path) };
}

export function promptImage(file: File): Promise<PromptImage> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error ?? new Error("cannot read file"));
        reader.onload = () => {
            const result = String(reader.result ?? "");
            const comma = result.indexOf(",");
            if (comma < 0) {
                reject(new Error("cannot read file"));
                return;
            }
            resolve({ mimeType: file.type || "image/png", data: result.slice(comma + 1) });
        };
        reader.readAsDataURL(file);
    });
}
