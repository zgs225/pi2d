import { QueryClient } from "@tanstack/react-query";
import i18n from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyWorkspaceUpdate, parseWorkspaceUpdate } from "@/features/workspaces/live";
import { instanceState } from "@/features/workspaces/workspace-card";
import { setLanguage } from "@/lib/i18n";
import type { WorkspaceInfo } from "@/lib/protocol";
import type { WsFrame } from "@/lib/ws";
import { useWorkspacesStore } from "@/stores/workspaces";

function sampleWorkspace(overrides: Partial<WorkspaceInfo> & Pick<WorkspaceInfo, "workspaceId" | "cwd" | "name">): WorkspaceInfo {
    return {
        trusted: true,
        exists: true,
        sessionCount: 0,
        liveCount: 0,
        lastActiveAt: 0,
        instance: null,
        ...overrides,
    };
}

describe("workspaces live updates", () => {
    beforeEach(async () => {
        await setLanguage("en");
        useWorkspacesStore.getState().reset();
    });

    describe("parseWorkspaceUpdate", () => {
        it("rejects garbage input (null payload, missing workspaceId, empty workspaceId, missing cwd)", () => {
            expect(parseWorkspaceUpdate(null as unknown as WsFrame)).toBeNull();
            expect(parseWorkspaceUpdate(undefined as unknown as WsFrame)).toBeNull();
            expect(parseWorkspaceUpdate({} as WsFrame)).toBeNull();
            expect(parseWorkspaceUpdate({ type: "workspace_update" } as WsFrame)).toBeNull();
            expect(parseWorkspaceUpdate({ type: "workspace_update", payload: null as unknown as Record<string, unknown> })).toBeNull();
            expect(parseWorkspaceUpdate({ type: "workspace_update", payload: "not-an-object" as unknown as Record<string, unknown> })).toBeNull();
            expect(parseWorkspaceUpdate({ type: "workspace_update", payload: {} })).toBeNull();
            expect(parseWorkspaceUpdate({ type: "workspace_update", payload: { cwd: "/work" } })).toBeNull();
            expect(parseWorkspaceUpdate({ type: "workspace_update", payload: { workspaceId: "", cwd: "/work" } })).toBeNull();
            expect(parseWorkspaceUpdate({ type: "workspace_update", payload: { workspaceId: "   ", cwd: "/work" } })).toBeNull();
            expect(parseWorkspaceUpdate({ type: "workspace_update", payload: { workspaceId: "ws-1" } })).toBeNull();
            expect(parseWorkspaceUpdate({ type: "workspace_update", payload: { workspaceId: "ws-1", cwd: 123 as unknown as string } })).toBeNull();
        });

        it("accepts a real workspace row", () => {
            const row = sampleWorkspace({ workspaceId: "ws-1", cwd: "/work/1", name: "One" });
            const frame: WsFrame = {
                v: 1,
                type: "workspace_update",
                workspaceId: "ws-1",
                ts: 1000,
                payload: row as unknown as Record<string, unknown>,
            };

            const parsed = parseWorkspaceUpdate(frame);
            expect(parsed).toEqual(row);
        });
    });

    describe("applyWorkspaceUpdate", () => {
        it("replaces matching row in QueryClient ['workspaces'] cache and appends an unknown one", () => {
            const queryClient = new QueryClient();
            const initial1 = sampleWorkspace({ workspaceId: "ws-1", cwd: "/work/1", name: "One" });
            const initial2 = sampleWorkspace({ workspaceId: "ws-2", cwd: "/work/2", name: "Two" });
            queryClient.setQueryData<WorkspaceInfo[]>(["workspaces"], [initial1, initial2]);

            // Replace matching row
            const updated1 = sampleWorkspace({ workspaceId: "ws-1", cwd: "/work/1", name: "One Updated", sessionCount: 5 });
            applyWorkspaceUpdate(queryClient, updated1);

            const cachedAfterReplace = queryClient.getQueryData<WorkspaceInfo[]>(["workspaces"]);
            expect(cachedAfterReplace).toEqual([updated1, initial2]);

            // Append unknown row
            const newRow3 = sampleWorkspace({ workspaceId: "ws-3", cwd: "/work/3", name: "Three" });
            applyWorkspaceUpdate(queryClient, newRow3);

            const cachedAfterAppend = queryClient.getQueryData<WorkspaceInfo[]>(["workspaces"]);
            expect(cachedAfterAppend).toEqual([updated1, initial2, newRow3]);
        });

        it("updates ['chat-workspaces'] only when cached and updates the zustand store", () => {
            const queryClient = new QueryClient();
            const row1 = sampleWorkspace({ workspaceId: "ws-1", cwd: "/work/1", name: "One" });
            const row2 = sampleWorkspace({ workspaceId: "ws-2", cwd: "/work/2", name: "Two" });

            // ['chat-workspaces'] has cached data
            queryClient.setQueryData<WorkspaceInfo[]>(["chat-workspaces"], [row1]);

            const updatedRow1 = sampleWorkspace({ workspaceId: "ws-1", cwd: "/work/1", name: "One Updated" });
            applyWorkspaceUpdate(queryClient, updatedRow1);

            expect(queryClient.getQueryData<WorkspaceInfo[]>(["chat-workspaces"])).toEqual([updatedRow1]);
            expect(useWorkspacesStore.getState().items).toEqual([updatedRow1]);

            // Add row2
            applyWorkspaceUpdate(queryClient, row2);
            expect(queryClient.getQueryData<WorkspaceInfo[]>(["chat-workspaces"])).toEqual([updatedRow1, row2]);
            expect(useWorkspacesStore.getState().items).toEqual([updatedRow1, row2]);
        });

        it("invalidates ['health'] queries", () => {
            const queryClient = new QueryClient();
            const spy = vi.spyOn(queryClient, "invalidateQueries");
            const row = sampleWorkspace({ workspaceId: "ws-1", cwd: "/work/1", name: "One" });

            applyWorkspaceUpdate(queryClient, row);

            expect(spy).toHaveBeenCalledWith({ queryKey: ["health"] });
        });

        it("maps a stopped row into the instance stopped label via instanceState()", () => {
            const stoppedRow = sampleWorkspace({
                workspaceId: "ws-stopped",
                cwd: "/work/stopped",
                name: "Stopped WS",
                instance: {
                    workspaceId: "ws-stopped",
                    instanceId: "inst-1",
                    status: "stopped",
                    nvimPid: 1234,
                    pluginVersion: "0.1.1",
                    hasUI: true,
                    attachedClients: 0,
                    listenAddr: "127.0.0.1:8888",
                    startedAt: 1000,
                },
            });

            const state = instanceState(stoppedRow);
            expect(state.status).toBe("exited");
            expect(state.labelKey).toBe("workspaces.instanceStopped");
            expect(i18n.t(state.labelKey)).toBe("Instance stopped");
        });
    });
});
