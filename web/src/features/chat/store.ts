import type { TaskItem } from "@protocol/types";
import { create } from "zustand";

import type { EntriesCursor, ProjectedEntry } from "@/lib/entry-projection";
import { prependUnique } from "@/lib/entry-projection";

export type PanelTab = "subagents" | "todo" | "tasks";

export interface Attachment {
    id: string;
    name: string;
    mimeType: string;
    /** Base64 payload (no data: prefix), ready for `prompt.send {images}`. */
    data: string;
    /** Data URL for the preview thumbnail. */
    preview: string;
}

export interface HistoryState {
    entries: ProjectedEntry[];
    cursor: EntriesCursor | null;
    loaded: boolean;
    loadingInitial: boolean;
    loadingOlder: boolean;
    error: string | null;
    /** Incremented by `resync_required`; the history hook reloads when it changes. */
    resyncToken: number;
}

export const EMPTY_HISTORY: HistoryState = {
    entries: [],
    cursor: null,
    loaded: false,
    loadingInitial: false,
    loadingOlder: false,
    error: null,
    resyncToken: 0,
};

export interface PreviewTarget {
    sessionId: string;
    subagentId: string;
}

export interface ChatStore {
    history: Record<string, HistoryState>;
    tab: PanelTab;
    filter: string;
    collapsed: Record<string, boolean>;
    treeOpen: boolean;
    panelOpen: boolean;
    treeCollapsed: boolean;
    treeWidth: number;
    panelWidth: number;
    sending: { sessionId: string; text: string } | null;
    attachments: Attachment[];
    preview: PreviewTarget | null;
    taskOutput: TaskItem | null;
    dispatchOpen: boolean;

    setTab: (tab: PanelTab) => void;
    setFilter: (filter: string) => void;
    toggleCollapsed: (id: string) => void;
    setAllCollapsed: (ids: string[], collapsed: boolean) => void;
    setTreeOpen: (open: boolean) => void;
    setPanelOpen: (open: boolean) => void;
    setTreeCollapsed: (collapsed: boolean) => void;
    setWidths: (widths: { treeWidth?: number; panelWidth?: number }) => void;
    closeDrawers: () => void;

    setSending: (sending: { sessionId: string; text: string } | null) => void;
    addAttachment: (attachment: Attachment) => void;
    removeAttachment: (id: string) => void;
    clearAttachments: () => void;
    setPreview: (preview: PreviewTarget | null) => void;
    setTaskOutput: (task: TaskItem | null) => void;
    setDispatchOpen: (open: boolean) => void;

    beginInitial: (sessionId: string) => void;
    beginOlder: (sessionId: string) => void;
    receiveInitial: (sessionId: string, entries: ProjectedEntry[], cursor: EntriesCursor) => void;
    receiveOlder: (sessionId: string, entries: ProjectedEntry[], cursor: EntriesCursor) => void;
    historyError: (sessionId: string, error: string) => void;
    bumpResync: (sessionId: string) => void;
    clearHistory: (sessionId: string) => void;
    /**
     * Re-key every per-session slice after the plugin migrates `tmp-N` → the
     * real id: history (so an in-flight prompt and its page are not lost),
     * the optimistic `sending` chip and the preview target.
     */
    migrateSession: (from: string, to: string) => void;
}

function updateHistory(
    state: ChatStore,
    sessionId: string,
    patch: Partial<HistoryState>,
): Pick<ChatStore, "history"> {
    const current = state.history[sessionId] ?? EMPTY_HISTORY;
    return { history: { ...state.history, [sessionId]: { ...current, ...patch } } };
}

export const useChatStore = create<ChatStore>((set) => ({
    history: {},
    tab: "subagents",
    filter: "",
    collapsed: {},
    treeOpen: false,
    panelOpen: false,
    treeCollapsed: false,
    treeWidth: 300,
    panelWidth: 340,
    sending: null,
    attachments: [],
    preview: null,
    taskOutput: null,
    dispatchOpen: false,

    setTab: (tab) => set({ tab }),
    setFilter: (filter) => set({ filter }),
    toggleCollapsed: (id) =>
        set((state) => {
            const collapsed = { ...state.collapsed };
            if (collapsed[id]) delete collapsed[id];
            else collapsed[id] = true;
            return { collapsed };
        }),
    setAllCollapsed: (ids, collapsed) =>
        set(() => ({ collapsed: collapsed ? Object.fromEntries(ids.map((id) => [id, true])) : {} })),
    setTreeOpen: (treeOpen) => set({ treeOpen }),
    setPanelOpen: (panelOpen) => set({ panelOpen }),
    setTreeCollapsed: (treeCollapsed) => set({ treeCollapsed }),
    setWidths: (widths) => set(widths),
    closeDrawers: () => set({ treeOpen: false, panelOpen: false }),

    setSending: (sending) => set({ sending }),
    addAttachment: (attachment) => set((state) => ({ attachments: [...state.attachments, attachment] })),
    removeAttachment: (id) => set((state) => ({ attachments: state.attachments.filter((item) => item.id !== id) })),
    clearAttachments: () => set({ attachments: [] }),
    setPreview: (preview) => set({ preview }),
    setTaskOutput: (taskOutput) => set({ taskOutput }),
    setDispatchOpen: (dispatchOpen) => set({ dispatchOpen }),

    beginInitial: (sessionId) =>
        set((state) => updateHistory(state, sessionId, { loadingInitial: true, error: null })),
    beginOlder: (sessionId) =>
        set((state) => updateHistory(state, sessionId, { loadingOlder: true, error: null })),
    receiveInitial: (sessionId, entries, cursor) =>
        set((state) => {
            const current = state.history[sessionId] ?? EMPTY_HISTORY;
            return updateHistory(state, sessionId, {
                entries: entries.length || !current.entries.length ? entries : current.entries,
                cursor,
                loaded: true,
                loadingInitial: false,
                loadingOlder: false,
                error: null,
                resyncToken: current.resyncToken,
            });
        }),
    receiveOlder: (sessionId, entries, cursor) =>
        set((state) => {
            const current = state.history[sessionId] ?? EMPTY_HISTORY;
            return updateHistory(state, sessionId, {
                entries: prependUnique(current.entries, entries) as ProjectedEntry[],
                cursor,
                loadingOlder: false,
                error: null,
            });
        }),
    historyError: (sessionId, error) =>
        set((state) =>
            updateHistory(state, sessionId, {
                loadingInitial: false,
                loadingOlder: false,
                error,
            }),
        ),
    bumpResync: (sessionId) =>
        set((state) => {
            const current = state.history[sessionId] ?? EMPTY_HISTORY;
            return updateHistory(state, sessionId, {
                loaded: false,
                loadingInitial: false,
                loadingOlder: false,
                error: null,
                resyncToken: current.resyncToken + 1,
            });
        }),
    clearHistory: (sessionId) =>
        set((state) => {
            const history = { ...state.history };
            delete history[sessionId];
            return { history };
        }),
    migrateSession: (from, to) =>
        set((state) => {
            if (!from || !to || from === to) return state;
            const history = { ...state.history };
            const moved = history[from];
            delete history[from];
            if (moved) {
                const existing = history[to];
                // Keep whichever side already rendered more of the transcript.
                history[to] = !existing || moved.entries.length >= existing.entries.length ? moved : existing;
            }
            return {
                history,
                sending: state.sending?.sessionId === from ? { ...state.sending, sessionId: to } : state.sending,
                preview: state.preview?.sessionId === from ? { ...state.preview, sessionId: to } : state.preview,
            };
        }),
}));
