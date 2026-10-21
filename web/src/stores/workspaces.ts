import { create } from "zustand";

import type { WorkspaceInfo } from "@/lib/protocol";

export type LoadStatus = "idle" | "loading" | "error" | "ready";

export interface WorkspacesStore {
    items: WorkspaceInfo[];
    status: LoadStatus;
    error: string | null;
    selectedId: string | null;

    setWorkspaces: (items: WorkspaceInfo[]) => void;
    upsert: (item: WorkspaceInfo) => void;
    remove: (workspaceId: string) => void;
    select: (workspaceId: string | null) => void;
    setStatus: (status: LoadStatus, error?: string | null) => void;
    reset: () => void;
}

const initial = {
    items: [] as WorkspaceInfo[],
    status: "idle" as LoadStatus,
    error: null as string | null,
    selectedId: null as string | null,
};

export const useWorkspacesStore = create<WorkspacesStore>((set) => ({
    ...initial,

    setWorkspaces: (items) => set({ items, status: "ready", error: null }),

    upsert: (item) =>
        set((state) => {
            const index = state.items.findIndex((w) => w.workspaceId === item.workspaceId);
            if (index === -1) return { items: [...state.items, item] };
            const items = state.items.slice();
            items[index] = item;
            return { items };
        }),

    remove: (workspaceId) =>
        set((state) => ({
            items: state.items.filter((w) => w.workspaceId !== workspaceId),
            selectedId: state.selectedId === workspaceId ? null : state.selectedId,
        })),

    select: (selectedId) => set({ selectedId }),

    setStatus: (status, error = null) => set({ status, error }),

    reset: () => set(initial),
}));
