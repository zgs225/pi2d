import type { TaskItem } from "@protocol/types";
import { create } from "zustand";

import type { EntriesCursor, ProjectedEntry } from "@/lib/entry-projection";
import { prependUnique } from "@/lib/entry-projection";

/**
 * Session tray tabs (v0.1.1 Chat IA v3). The old right panel had a third
 * `subagents` tab; subagents now live in the session tree, the tray keeps only
 * the two session-scoped, read-mostly panels.
 */
export type TrayTab = "todo" | "tasks";

/** localStorage key for the IA "active only" filter (default on). */
export const ACTIVE_ONLY_KEY = "pi2-active-only";

function readActiveOnly(): boolean {
    try {
        const value = localStorage.getItem(ACTIVE_ONLY_KEY);
        return value == null ? true : value === "1";
    } catch {
        // Private mode / no storage: the design default is "active only".
        return true;
    }
}

function writeActiveOnly(value: boolean): void {
    try {
        localStorage.setItem(ACTIVE_ONLY_KEY, value ? "1" : "0");
    } catch {
        // ignore
    }
}

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

export interface ChatStore {
    history: Record<string, HistoryState>;
    /** Active tray tab (`todo` / `tasks`). */
    trayTab: TrayTab;
    /** Tray visibility. The chips in the stream head toggle it. */
    trayOpen: boolean;
    filter: string;
    collapsed: Record<string, boolean>;
    /** Render sub-sessions the plugin hid (`:PiSessions` policy) — not the IA filter. */
    showHidden: boolean;
    /**
     * IA filter "only live rows". Deliberately separate from `showHidden`:
     * `showHidden` is the plugin's visibility policy, this is the user's lens.
     */
    activeOnly: boolean;
    treeOpen: boolean;
    /** Subagent shown in the in-place child view (mirrors `?sub=` in the URL). */
    activeSubagentId: string | null;
    /** Session id whose row actions popover (`…`) is open, or `null`. */
    rowMenuId: string | null;
    /** Workspace switch menu (`ws-menu`) visibility. */
    wsMenuOpen: boolean;
    sending: { sessionId: string; text: string } | null;
    attachments: Attachment[];
    taskOutput: TaskItem | null;
    dispatchOpen: boolean;

    setTrayTab: (tab: TrayTab) => void;
    setTrayOpen: (open: boolean) => void;
    /** Same tab again = close (the chip is a toggle). */
    toggleTray: (tab: TrayTab) => void;
    setFilter: (filter: string) => void;
    toggleCollapsed: (id: string) => void;
    setAllCollapsed: (ids: string[], collapsed: boolean) => void;
    toggleShowHidden: () => void;
    setShowHidden: (show: boolean) => void;
    setActiveOnly: (activeOnly: boolean) => void;
    toggleActiveOnly: () => void;
    setTreeOpen: (open: boolean) => void;
    setActiveSubagentId: (id: string | null) => void;
    setRowMenuId: (id: string | null) => void;
    setWsMenuOpen: (open: boolean) => void;
    closeDrawers: () => void;

    setSending: (sending: { sessionId: string; text: string } | null) => void;
    addAttachment: (attachment: Attachment) => void;
    removeAttachment: (id: string) => void;
    clearAttachments: () => void;
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
     * and the optimistic `sending` chip.
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
    trayTab: "todo",
    trayOpen: false,
    filter: "",
    collapsed: {},
    showHidden: false,
    activeOnly: readActiveOnly(),
    treeOpen: false,
    activeSubagentId: null,
    rowMenuId: null,
    wsMenuOpen: false,
    sending: null,
    attachments: [],
    taskOutput: null,
    dispatchOpen: false,

    setTrayTab: (trayTab) => set({ trayTab }),
    setTrayOpen: (trayOpen) => set({ trayOpen }),
    toggleTray: (tab) =>
        set((state) => (state.trayOpen && state.trayTab === tab ? { trayOpen: false } : { trayTab: tab, trayOpen: true })),
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
    toggleShowHidden: () => set((state) => ({ showHidden: !state.showHidden })),
    setShowHidden: (showHidden) => set({ showHidden }),
    setActiveOnly: (activeOnly) => {
        writeActiveOnly(activeOnly);
        set({ activeOnly });
    },
    toggleActiveOnly: () =>
        set((state) => {
            writeActiveOnly(!state.activeOnly);
            return { activeOnly: !state.activeOnly };
        }),
    setTreeOpen: (treeOpen) => set({ treeOpen }),
    setActiveSubagentId: (activeSubagentId) => set({ activeSubagentId }),
    setRowMenuId: (rowMenuId) => set({ rowMenuId }),
    setWsMenuOpen: (wsMenuOpen) => set({ wsMenuOpen }),
    closeDrawers: () => set({ treeOpen: false }),

    setSending: (sending) => set({ sending }),
    addAttachment: (attachment) => set((state) => ({ attachments: [...state.attachments, attachment] })),
    removeAttachment: (id) => set((state) => ({ attachments: state.attachments.filter((item) => item.id !== id) })),
    clearAttachments: () => set({ attachments: [] }),
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
            };
        }),
}));
