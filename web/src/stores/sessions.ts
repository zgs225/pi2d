import { create } from "zustand";

import type { SessionState } from "@/lib/protocol";

export interface SessionsStore {
    /** Sessions grouped by workspace — the chat tree is per workspace. */
    byWorkspace: Record<string, SessionState[]>;
    selectedSessionId: string | null;
    status: "idle" | "loading" | "error";
    error: string | null;

    setSessions: (workspaceId: string, sessions: SessionState[]) => void;
    upsertSession: (session: SessionState) => void;
    /** Re-key a session after the plugin migrates `tmp-N` → the real id. */
    renameSessionId: (from: string, to: string) => void;
    removeSession: (sessionId: string) => void;
    selectSession: (sessionId: string | null) => void;
    listFor: (workspaceId: string) => SessionState[];
    getSession: (sessionId: string) => SessionState | undefined;
    setStatus: (status: "idle" | "loading" | "error", error?: string | null) => void;
    reset: () => void;
}

const initial = {
    byWorkspace: {} as Record<string, SessionState[]>,
    selectedSessionId: null as string | null,
    status: "idle" as const,
    error: null as string | null,
};

export const useSessionsStore = create<SessionsStore>((set, get) => ({
    ...initial,

    setSessions: (workspaceId, sessions) =>
        set((state) => ({
            byWorkspace: { ...state.byWorkspace, [workspaceId]: sessions },
            status: "idle",
            error: null,
        })),

    upsertSession: (session) =>
        set((state) => {
            const list = state.byWorkspace[session.workspaceId] ?? [];
            const index = list.findIndex((s) => s.sessionId === session.sessionId);
            if (index === -1) {
                return { byWorkspace: { ...state.byWorkspace, [session.workspaceId]: [...list, session] } };
            }
            // Tree metadata is list metadata: a live update (`pi2:session`,
            // reducer events, a rename) carries no `parentId`/`visible`/`task` and
            // must not orphan the row. Explicit `undefined` is the only
            // "not carried" marker — an explicit `parentId: null` means root and
            // wins, which `??` would invert.
            const previous = list[index] as SessionState;
            const merged: SessionState = {
                ...session,
                parentId: session.parentId !== undefined ? session.parentId : previous.parentId,
                visible: session.visible !== undefined ? session.visible : previous.visible,
                task: session.task !== undefined ? session.task : previous.task,
            };
            const next = list.map((s, i) => (i === index ? merged : s));
            return { byWorkspace: { ...state.byWorkspace, [session.workspaceId]: next } };
        }),

    renameSessionId: (from, to) =>
        set((state) => {
            if (!from || !to || from === to) return state;
            const byWorkspace: Record<string, SessionState[]> = {};
            let moved = false;
            for (const [workspaceId, list] of Object.entries(state.byWorkspace)) {
                const index = list.findIndex((session) => session.sessionId === from);
                let changed = false;
                let next = list.map((session, position) => {
                    let row = session;
                    if (position === index) {
                        row = { ...row, sessionId: to };
                        changed = true;
                    }
                    // `tmp-N` → real id migration: children (sub-session rows) keep
                    // pointing at their parent, now under its real id.
                    if (row.parentId === from) {
                        row = { ...row, parentId: to };
                        changed = true;
                    }
                    return row;
                });
                if (index !== -1) {
                    // A row already cached under the new id would now duplicate the
                    // migrated one (the REST list can be ahead of the event).
                    const deduped = next.filter(
                        (session, position) => position === index || session.sessionId !== to,
                    );
                    if (deduped.length !== next.length) changed = true;
                    next = deduped;
                }
                if (changed) moved = true;
                byWorkspace[workspaceId] = next;
            }
            if (!moved) return state;
            return {
                byWorkspace,
                selectedSessionId: state.selectedSessionId === from ? to : state.selectedSessionId,
            };
        }),

    removeSession: (sessionId) =>
        set((state) => {
            const byWorkspace: Record<string, SessionState[]> = {};
            for (const [workspaceId, list] of Object.entries(state.byWorkspace)) {
                byWorkspace[workspaceId] = list
                    .filter((s) => s.sessionId !== sessionId)
                    // Never orphan a child: a removed parent promotes its children to
                    // roots instead of hiding them behind a missing row.
                    .map((s) => (s.parentId === sessionId ? { ...s, parentId: null } : s));
            }
            return { byWorkspace, selectedSessionId: state.selectedSessionId === sessionId ? null : state.selectedSessionId };
        }),

    selectSession: (selectedSessionId) => set({ selectedSessionId }),

    listFor: (workspaceId) => get().byWorkspace[workspaceId] ?? [],

    getSession: (sessionId) => {
        for (const list of Object.values(get().byWorkspace)) {
            const found = list.find((s) => s.sessionId === sessionId);
            if (found) return found;
        }
        return undefined;
    },

    setStatus: (status, error = null) => set({ status, error }),

    reset: () => set(initial),
}));
