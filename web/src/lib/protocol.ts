// synced from pi2d/src/protocol/types.ts — do not edit by hand; re-copy when the wire types change.
/**
 * pi2 wire protocol — shared types.
 *
 * Three surfaces, one vocabulary:
 *   browser  <-> daemon   (HTTP + WS)
 *   plugin   <-> daemon   (JSONL over unix socket)
 *   daemon   <-> plugin   (same JSONL envelope, reversed direction)
 *
 * The plugin is the single source of truth for session state; the daemon only
 * routes, the browser only renders.
 */

export const PROTOCOL_VERSION = 1;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type SessionStatus = "starting" | "busy" | "compacting" | "idle" | "exited" | "interrupted";

export type ClientKind = "nvim" | "web" | "cli" | "daemon" | "system";

export interface ClientRef {
    clientId: string;
    kind: ClientKind;
}

export interface ModelRef {
    provider: string;
    id: string;
}

export interface UsageTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}

export interface ContextUsage {
    tokens: number;
    window: number;
    percent: number;
}

export interface ToolOutput {
    text?: string;
    details?: unknown;
    isError?: boolean;
}

export type Block =
    | { type: "text"; text: string }
    | { type: "thinking"; text: string; redacted?: boolean }
    | {
          type: "tool";
          toolCallId: string;
          name: string;
          args?: unknown;
          output?: ToolOutput;
          state: "pending" | "running" | "done" | "error";
          durationMs?: number;
      }
    | { type: "error"; text: string };

export type EntryRole = "user" | "assistant" | "system" | "notice";

export interface Entry {
    id: string;
    role: EntryRole;
    ts: number;
    blocks: Block[];
    done: boolean;
    messageId?: string;
    images?: { mimeType: string; data: string }[];
}

export interface TodoItem {
    content: string;
    status: "pending" | "in_progress" | "completed";
    activeForm?: string;
}

export interface QueueItem {
    id: string;
    text: string;
    steer: boolean;
}

export interface TaskItem {
    id: string;
    command: string;
    status: "running" | "completed" | "failed" | "stopped";
    startTime: number;
    durationMs?: number;
    exitCode?: number | null;
    outputFile?: string;
}

export type BatchItemStatus = "queued" | "spawning" | "running" | "ok" | "failed" | "cancelled";

export interface BatchItem {
    ref: string;
    name?: string;
    status: BatchItemStatus;
    error?: string;
}

export interface BatchItemCounts {
    total: number;
    done: number;
    ok: number;
    failed: number;
    cancelled: number;
    running: number;
}

export interface Batch {
    batchId: string;
    status: "running" | "completed" | "partial" | "failed" | "cancelled";
    items: BatchItem[];
    summary?: BatchItemCounts;
}

export interface Subagent {
    id: string;
    name?: string;
    status: "active" | "completed" | "failed" | "interrupted" | "dormant";
    model?: string;
    thinking?: ThinkingLevel;
    task?: string;
    createdAt?: number;
    lastActiveAt?: number;
    live?: boolean;
    children?: Subagent[];
}

export interface AttentionOption {
    id: string;
    label: string;
}

export interface AttentionItem {
    requestId: string;
    method: string;
    title?: string;
    message?: string;
    options?: AttentionOption[];
    /** Free-form payload; `diff` requests carry `{files:[{path,before,after}]}`. */
    payload?: unknown;
    timeoutSec?: number;
    createdAt: number;
    receivedAt: number;
}

export interface SessionFlags {
    attention: boolean;
    done: boolean;
    error: boolean;
}

export interface SessionState {
    sessionId: string;
    workspaceId: string;
    cwd: string;
    name: string | null;
    status: SessionStatus;
    flags: SessionFlags;
    model: ModelRef | null;
    thinking: ThinkingLevel | null;
    usage: UsageTotals;
    contextUsage: ContextUsage | null;
    queue: QueueItem[];
    todos: TodoItem[];
    tasks: TaskItem[];
    batches: Batch[];
    subagents: Subagent[];
    attention: AttentionItem[];
    entries: Entry[];
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

/**
 * Pi native events are relayed verbatim (`message_start`, `message_update`,
 * `tool_execution_*`, `queue_update`, `agent_*`, `turn_*`, `compaction_*`,
 * `session_info_changed`, `thinking_level_changed`, `entry_appended`).
 *
 * Derived events are prefixed `pi2:` and are computed by the plugin only.
 */
export type SessionEventType =
    | "agent_start"
    | "agent_end"
    | "agent_settled"
    | "turn_start"
    | "turn_end"
    | "message_start"
    | "message_update"
    | "message_end"
    | "tool_execution_start"
    | "tool_execution_update"
    | "tool_execution_end"
    | "queue_update"
    | "session_info_changed"
    | "thinking_level_changed"
    | "entry_appended"
    | "compaction_start"
    | "compaction_end"
    | "pi2:session"
    | "pi2:todo"
    | "pi2:batch"
    | "pi2:task"
    | "pi2:subagents"
    | "pi2:attention_request"
    | "pi2:attention_resolved"
    | "pi2:process_exit"
    | "pi2:error";

export interface SessionEvent {
    type: SessionEventType | string;
    ts: number;
    [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Envelopes                                                           */
/* ------------------------------------------------------------------ */

export interface InstanceState {
    workspaceId: string;
    instanceId: string;
    status: "starting" | "ready" | "degraded" | "stopping" | "stopped" | "unmanaged";
    nvimPid: number | null;
    pluginVersion: string | null;
    hasUI: boolean;
    attachedClients: number;
    listenAddr: string | null;
    startedAt: number | null;
    reason?: string;
}

export interface WorkspaceInfo {
    workspaceId: string;
    cwd: string;
    name: string;
    alias?: string | null;
    pinned?: boolean;
    hidden?: boolean;
    trusted: boolean;
    exists: boolean;
    /** Number of session files discovered on disk (header scan). */
    sessionCount: number;
    /** Number of live sessions reported by the instance, if any. */
    liveCount: number;
    lastActiveAt: number | null;
    instance: InstanceState | null;
}

export type DaemonCommandMethod =
    | "instance.ensure"
    | "instance.shutdown"
    | "workspace.add"
    | "workspace.update"
    | "workspace.remove"
    | "workspace.refresh"
    | "pair.create"
    | "pair.redeem"
    | "device.revoke"
    | "session.create"
    | "session.open"
    | "session.close"
    | "session.resume"
    | "session.rename"
    | "session.fork"
    | "session.compact"
    | "session.setModel"
    | "session.setThinking"
    | "session.hibernate"
    | "prompt.send"
    | "prompt.abort"
    | "queue.remove"
    | "queue.setSteer"
    | "attention.respond"
    | "subagent.dispatch"
    | "subagent.stop"
    | "subagent.steer"
    | "subagent.read"
    | "task.stop"
    | "system.doctor"
    | "system.shutdown";

export interface CommandRequest {
    method: DaemonCommandMethod | string;
    params?: Record<string, unknown>;
    sessionId?: string;
    clientRequestId?: string;
}

export interface ErrorBody {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
}
