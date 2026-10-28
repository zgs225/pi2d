/**
 * Deterministic fakes for the daemon surface tests.
 *
 * W2/W3 will provide the real `InstanceManager` / `WorkspaceStore`; the daemon
 * only depends on `src/core/interfaces.ts`, so these fakes mirror those shapes.
 */
import type {
    Bus,
    InstanceManager,
    InstanceResourcesSnapshot,
    PluginConnection,
    WorkspaceStore,
} from "../../src/core/interfaces.js";
import type { InstanceState, SessionState, WorkspaceInfo } from "../../src/protocol/types.js";

export interface CommandCall {
    id: string;
    sessionId?: string;
    method: string;
    params?: Record<string, unknown>;
    clientRequestId?: string;
}

let deviceCounter = 0;

export class FakeConnection implements PluginConnection {
    readonly instanceId: string;
    readonly workspaceId: string;
    readonly cwd: string;
    readonly pid = process.pid;
    readonly hasUI = true;
    readonly listenAddr: string | null = null;
    readonly pluginVersion = "test-1.0.0";

    subscribed = new Set<string>();
    snapshots = new Map<string, SessionState>();
    seqs = new Map<string, number>();
    commands: CommandCall[] = [];
    sendRecords: Record<string, unknown>[] = [];
    closedReason: string | undefined;
    commandHandler: ((call: CommandCall) => Promise<{ seq?: number; disposition?: string }>) | undefined;
    private commandCounter = 0;

    constructor(workspaceId: string, instanceId = `i-${++deviceCounter}`) {
        this.workspaceId = workspaceId;
        this.instanceId = instanceId;
        this.cwd = `/repo/${workspaceId}`;
    }

    send(record: Record<string, unknown>): void {
        this.sendRecords.push(record);
    }

    async command(call: CommandCall): Promise<{ seq?: number; disposition?: string }> {
        this.commands.push(call);
        if (this.commandHandler) return this.commandHandler(call);
        return { seq: ++this.commandCounter, disposition: "started" };
    }

    subscribe(sessionId: string): void {
        this.subscribed.add(sessionId);
    }

    unsubscribe(sessionId: string): void {
        this.subscribed.delete(sessionId);
    }

    sessionIds(): string[] {
        return [...this.snapshots.keys()];
    }

    snapshot(sessionId: string): SessionState | undefined {
        return this.snapshots.get(sessionId);
    }

    lastSeq(sessionId: string): number {
        return this.seqs.get(sessionId) ?? 0;
    }

    close(reason: string): void {
        this.closedReason = reason;
    }
}

export function makeSessionState(sessionId: string, workspaceId: string): SessionState {
    return {
        sessionId,
        workspaceId,
        cwd: `/repo/${workspaceId}`,
        name: `Session ${sessionId}`,
        status: "idle",
        flags: { attention: false, done: true, error: false },
        model: { provider: "anthropic", id: "claude-sonnet-4-5" },
        thinking: "medium",
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
        contextUsage: null,
        queue: [],
        todos: [],
        tasks: [],
        batches: [],
        subagents: [],
        attention: [],
        entries: [],
    };
}

export function makeInstanceState(workspaceId: string, instanceId: string): InstanceState {
    return {
        workspaceId,
        instanceId,
        status: "ready",
        nvimPid: 1234,
        pluginVersion: "test-1.0.0",
        hasUI: true,
        attachedClients: 0,
        listenAddr: null,
        startedAt: Date.now(),
    };
}

export class FakeInstanceManager implements InstanceManager {
    readonly instances = new Map<string, FakeConnection>();
    readonly states = new Map<string, InstanceState>();
    readonly sessionOwners = new Map<string, string>();
    ensureCalls: string[] = [];
    shutdownCalls: { workspaceId: string; mode: "drain" | "stop" }[] = [];
    maybeUnsubscribeCalls: { workspaceId: string; sessionId: string }[] = [];
    resourcesValue: InstanceResourcesSnapshot = {
        instances: [],
        totalRssBytes: 0,
        physicalMemoryBytes: 16 * 1024 ** 3,
        warn: false,
    };
    private changeHandlers: ((state: InstanceState) => void)[] = [];

    addWorkspace(workspaceId: string, instanceId = `i-${workspaceId}`): FakeConnection {
        const conn = new FakeConnection(workspaceId, instanceId);
        this.instances.set(workspaceId, conn);
        this.states.set(workspaceId, makeInstanceState(workspaceId, instanceId));
        return conn;
    }

    async ensure(workspaceId: string): Promise<InstanceState> {
        this.ensureCalls.push(workspaceId);
        let state = this.states.get(workspaceId);
        if (!state) {
            const conn = this.addWorkspace(workspaceId);
            state = this.states.get(workspaceId)!;
            for (const handler of this.changeHandlers) handler(state);
            void conn;
        }
        return state;
    }

    async shutdown(workspaceId: string, mode: "drain" | "stop"): Promise<void> {
        this.shutdownCalls.push({ workspaceId, mode });
        this.instances.delete(workspaceId);
        this.states.delete(workspaceId);
    }

    get(workspaceId: string): PluginConnection | undefined {
        return this.instances.get(workspaceId);
    }

    list(): InstanceState[] {
        return [...this.states.values()];
    }

    instanceStates(): InstanceState[] {
        return this.list();
    }

    findWorkspaceBySession(sessionId: string): string | undefined {
        for (const conn of this.instances.values()) {
            if (conn.subscribed.has(sessionId)) return conn.workspaceId;
        }
        return this.sessionOwners.get(sessionId);
    }

    async resources(): Promise<InstanceResourcesSnapshot> {
        return this.resourcesValue;
    }

    maybeUnsubscribe(workspaceId: string, sessionId: string): void {
        this.maybeUnsubscribeCalls.push({ workspaceId, sessionId });
    }

    onInstanceChange(handler: (state: InstanceState) => void): void {
        this.changeHandlers.push(handler);
    }
}

export function makeWorkspaceInfo(workspaceId: string, overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
    return {
        workspaceId,
        cwd: `/repo/${workspaceId}`,
        name: `Workspace ${workspaceId}`,
        trusted: true,
        exists: true,
        sessionCount: 0,
        liveCount: 0,
        lastActiveAt: null,
        instance: null,
        ...overrides,
    };
}

export class FakeWorkspaceStore implements WorkspaceStore {
    readonly workspaces = new Map<string, WorkspaceInfo>();
    addCalls: { cwd: string; alias?: string; trust?: boolean }[] = [];
    updateCalls: { workspaceId: string; patch: Record<string, unknown> }[] = [];
    removeCalls: string[] = [];
    refreshCalls: (string | undefined)[] = [];

    constructor(seed: WorkspaceInfo[] = []) {
        for (const workspace of seed) this.workspaces.set(workspace.workspaceId, workspace);
    }

    list(): WorkspaceInfo[] {
        return [...this.workspaces.values()];
    }

    get(workspaceId: string): WorkspaceInfo | undefined {
        return this.workspaces.get(workspaceId);
    }

    byCwd(cwd: string): WorkspaceInfo | undefined {
        return this.list().find((workspace) => workspace.cwd === cwd);
    }

    async add(input: { cwd: string; alias?: string; trust?: boolean }): Promise<WorkspaceInfo> {
        this.addCalls.push(input);
        const workspace = makeWorkspaceInfo(`ws-${this.workspaces.size + 1}`, {
            cwd: input.cwd,
            alias: input.alias ?? null,
            trusted: input.trust ?? false,
        });
        this.workspaces.set(workspace.workspaceId, workspace);
        return workspace;
    }

    async update(
        workspaceId: string,
        patch: Partial<{ alias: string | null; pinned: boolean; hidden: boolean; trusted: boolean }>,
    ): Promise<WorkspaceInfo> {
        this.updateCalls.push({ workspaceId, patch });
        const current = this.workspaces.get(workspaceId) ?? makeWorkspaceInfo(workspaceId);
        const next = { ...current, ...patch };
        this.workspaces.set(workspaceId, next);
        return next;
    }

    async remove(workspaceId: string): Promise<void> {
        this.removeCalls.push(workspaceId);
        this.workspaces.delete(workspaceId);
    }

    async refresh(workspaceId?: string): Promise<void> {
        this.refreshCalls.push(workspaceId);
    }

    async ensureForCwd(cwd: string): Promise<WorkspaceInfo> {
        return this.byCwd(cwd) ?? this.add({ cwd });
    }
}

export class FakeBus implements Bus {
    readonly published: Record<string, unknown>[] = [];
    readonly handlers = new Set<(record: Record<string, unknown>) => void>();

    publish(record: Record<string, unknown>): void {
        this.published.push(record);
        for (const handler of this.handlers) handler(record);
    }

    subscribe(handler: (record: Record<string, unknown>) => void): () => void {
        this.handlers.add(handler);
        return () => {
            this.handlers.delete(handler);
        };
    }
}
