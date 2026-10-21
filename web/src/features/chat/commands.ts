import type { CommandRequest, ModelRef, ThinkingLevel } from "@protocol/types";
import { api } from "@/lib/api";

export interface PromptImage {
    mimeType: string;
    data: string;
}

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
 * Parameter names follow the daemon/plugin contract
 * (`docs/protocol.md`, design `explore/web-server-round2-contract.md` §4).
 */
export const chatCommands = {
    sendPrompt: (sessionId: string, text: string, images: PromptImage[] = []): ChatCommand =>
        command("prompt.send", sessionId, {
            text,
            mode: "queue",
            ...(images.length ? { images } : {}),
        }),

    abort: (sessionId: string): ChatCommand => command("prompt.abort", sessionId, {}),

    removeQueued: (sessionId: string, queueId: string): ChatCommand => command("queue.remove", sessionId, { queueId }),

    setQueueSteer: (sessionId: string, queueId: string, steer: boolean): ChatCommand =>
        command("queue.setSteer", sessionId, { queueId, steer }),

    setModel: (sessionId: string, model: ModelRef): ChatCommand =>
        command("session.setModel", sessionId, { provider: model.provider, id: model.id }),

    setThinking: (sessionId: string, level: ThinkingLevel): ChatCommand =>
        command("session.setThinking", sessionId, { level }),

    renameSession: (sessionId: string, name: string): ChatCommand => command("session.rename", sessionId, { name }),

    closeSession: (sessionId: string): ChatCommand => command("session.close", sessionId, { mode: "close" }),

    createSession: (workspaceId: string): ChatCommand => command("session.create", undefined, { workspaceId }),

    respondAttention: (sessionId: string, requestIdValue: string, response: unknown): ChatCommand =>
        command("attention.respond", sessionId, { requestId: requestIdValue, response }),

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
            task: input.task,
            ...(input.name ? { name: input.name } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.thinking ? { thinking: input.thinking } : {}),
            ...(input.wait !== undefined ? { wait: input.wait } : {}),
            ...(input.cancelSiblingsOnFail !== undefined
                ? { cancelSiblingsOnFail: input.cancelSiblingsOnFail }
                : {}),
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

/** Response value for the diff-review attention variant (matches the plugin's JSON payload). */
export function diffResponse(result: "Accepted" | "Rejected"): string {
    return JSON.stringify({ result });
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
