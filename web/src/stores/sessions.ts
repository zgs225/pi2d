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
            const next = index === -1 ? [...list, session] : list.map((s, i) => (i === index ? session : s));
            return { byWorkspace: { ...state.byWorkspace, [session.workspaceId]: next } };
        }),

    renameSessionId: (from, to) =>
        set((state) => {
            if (!from || !to || from === to) return state;
            const byWorkspace: Record<string, SessionState[]> = {};
            let moved = false;
            for (const [workspaceId, list] of Object.entries(state.byWorkspace)) {
                const index = list.findIndex((session) => session.sessionId === from);
                if (index === -1) {
                    byWorkspace[workspaceId] = list;
                    continue;
                }
                moved = true;
                byWorkspace[workspaceId] = list
                    .map((session, position) =>
                        position === index ? { ...session, sessionId: to } : session,
                    )
                    // A row already cached under the new id would now duplicate the
                    // migrated one (the REST list can be ahead of the event).
                    .filter((session, position) => position === index || session.sessionId !== to);
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
                byWorkspace[workspaceId] = list.filter((s) => s.sessionId !== sessionId);
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
