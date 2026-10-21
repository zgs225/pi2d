/**
 * Type surface for the canonical reducer (`../src/protocol/reducer.ts`).
 *
 * The implementation is imported at runtime through the `@protocol` Vite alias
 * so the browser reuses the daemon's reducer instead of a copy. TypeScript
 * consumes this declaration rather than the upstream file because the daemon
 * source is compiled with different lint flags (it has an unused type import
 * that `noUnusedLocals` would reject here). Keep this in sync with the exports
 * of `src/protocol/reducer.ts`.
 */
import type { ModelRef, SessionEvent, SessionState, ThinkingLevel } from "@protocol/types";

export interface ReducerContext {
    nextEntry: number;
    assistantEntryId: string | null;
    userEntryId: string | null;
    /** toolCallId -> location of the tool block */
    toolBlocks: Map<string, { entryId: string; index: number }>;
    /** streamed tool call argument buffers, keyed by toolCallId */
    toolArgs: Map<string, string>;
}

export interface Reducer {
    state: SessionState;
    ctx: ReducerContext;
}

export interface StateInit {
    sessionId: string;
    workspaceId?: string;
    cwd?: string;
    name?: string | null;
    status?: SessionState["status"];
    model?: ModelRef | null;
    thinking?: ThinkingLevel | null;
}

export function createReducer(init: StateInit): Reducer;
export function applyEvent(reducer: Reducer, event: SessionEvent): void;
export function reduceAll(init: StateInit, events: SessionEvent[]): SessionState;
