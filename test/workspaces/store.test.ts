import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceIdForCwd } from "../../src/core/paths.js";
import type { InstanceManager } from "../../src/core/interfaces.js";
import type { InstanceState } from "../../src/protocol/types.js";
import { createDiscovery } from "../../src/workspaces/discovery.js";
import { createWorkspaceStore } from "../../src/workspaces/index.js";
import { WorkspaceRegistry } from "../../src/workspaces/registry.js";
import { cleanup, encodedDirName, makeSandbox, sessionHeader, writeSessionDir } from "./helpers.js";

type FakeInstanceState = InstanceState & { sessions?: unknown[]; sessionCount?: number };

function fakeInstances(listed: FakeInstanceState[], connected = listed): InstanceManager {
    return {
        list: () => listed,
        instanceStates: () => connected,
    } as unknown as InstanceManager;
}

function instance(workspaceId: string, overrides: Partial<FakeInstanceState> = {}): FakeInstanceState {
    return {
        workspaceId,
        instanceId: `i-${workspaceId.slice(0, 4)}`,
        status: "ready",
        nvimPid: 4242,
        pluginVersion: "1.8.0",
        hasUI: true,
        attachedClients: 1,
        listenAddr: null,
        startedAt: Date.now(),
        ...overrides,
    };
}

describe("workspace store", () => {
    let sandbox: string;
    let sessions: string;
    let dataFile: string;
    let allowRoot: string;
    let projectA: string;
    let projectB: string;
    let projectGhost: string;

    beforeEach(() => {
        sandbox = makeSandbox("pi2-daemon-store-");
        sessions = join(sandbox, "agent", "sessions");
        dataFile = join(sandbox, "data", "workspaces.json");
        allowRoot = join(sandbox, "code");
        projectA = join(allowRoot, "alpha");
        projectB = join(allowRoot, "beta");
        projectGhost = join(allowRoot, "ghost");
        for (const dir of [sessions, allowRoot, projectA, projectB, projectGhost]) mkdirSync(dir, { recursive: true });

        writeSessionDir(sessions, encodedDirName(projectA), [
            {
                name: "2026-10-10T06-40-33-032Z_a1.jsonl",
                cwd: projectA,
                id: "a1",
                timestamp: "2026-10-10T06:40:33.032Z",
                mtime: new Date("2026-10-10T06:40:33.032Z"),
            },
            {
                name: "2026-10-11T06-40-33-032Z_a2.jsonl",
                cwd: projectA,
                id: "a2",
                timestamp: "2026-10-11T06:40:33.032Z",
                mtime: new Date("2026-10-11T06:40:33.032Z"),
            },
        ]);
        writeSessionDir(sessions, encodedDirName(projectB), [
            {
                name: "2026-10-12T06-40-33-032Z_b1.jsonl",
                cwd: projectB,
                id: "b1",
                timestamp: "2026-10-12T06:40:33.032Z",
                mtime: new Date("2026-10-12T06:40:33.032Z"),
            },
        ]);
        writeSessionDir(sessions, encodedDirName(projectGhost), [
            {
                name: "2026-10-13T06-40-33-032Z_g1.jsonl",
                cwd: projectGhost,
                id: "g1",
                timestamp: "2026-10-13T06:40:33.032Z",
                mtime: new Date("2026-10-13T06:40:33.032Z"),
            },
        ]);
        rmSync(projectGhost, { recursive: true, force: true });
    });

    afterEach(() => cleanup(sandbox));

    function setup(opts: Parameters<typeof createWorkspaceStore>[0] = {}) {
        const discovery = createDiscovery({ root: sessions });
        const registry = new WorkspaceRegistry({ filePath: dataFile });
        const store = createWorkspaceStore({ discovery, registry, roots: [allowRoot], ...opts });
        return { store, discovery, registry };
    }

    it("merges registry entries with disk discovery and instance state", async () => {
        const aId = workspaceIdForCwd(projectA);
        const { store, registry } = setup({
            instances: fakeInstances([instance(aId, { sessions: [{}, {}, {}] })]),
        });
        await registry.ensureForCwd(projectA);
        await store.update(aId, { alias: "Alpha", pinned: true, trusted: true });

        const all = store.list();
        expect(all).toHaveLength(3);

        const a = store.get(aId);
        expect(a).toMatchObject({
            workspaceId: aId,
            cwd: projectA,
            name: "Alpha",
            alias: "Alpha",
            pinned: true,
            hidden: false,
            trusted: true,
            exists: true,
            sessionCount: 2,
            liveCount: 3,
        });
        expect(a?.instance).toMatchObject({ workspaceId: aId, instanceId: `i-${aId.slice(0, 4)}` });

        const b = store.byCwd(projectB);
        expect(b).toMatchObject({
            workspaceId: workspaceIdForCwd(projectB),
            name: "beta",
            alias: null,
            trusted: false,
            exists: true,
            sessionCount: 1,
            liveCount: 0,
            instance: null,
        });

        const ghost = store.get(workspaceIdForCwd(projectGhost));
        expect(ghost).toMatchObject({ exists: false, sessionCount: 1, lastActiveAt: expect.any(Number) });
    });

    it("lists the newest session files across workspaces for the activity feed", () => {
        const { store } = setup();

        const rows = store.recentSessions(3);
        expect(rows.map((row) => row.sessionId)).toEqual(["g1", "b1", "a2"]);
        expect(rows.map((row) => row.workspaceId)).toEqual([
            workspaceIdForCwd(projectGhost),
            workspaceIdForCwd(projectB),
            workspaceIdForCwd(projectA),
        ]);
        expect(rows[0]).toMatchObject({
            workspaceName: "ghost",
            cwd: projectGhost,
            timestamp: Date.parse("2026-10-13T06:40:33.032Z"),
            modified: Date.parse("2026-10-13T06:40:33.032Z"),
            sessionFile: expect.stringContaining("g1"),
            // The helper writes a user message "hi": the disk preview labels
            // the row that has no live instance.
            firstMessage: "hi",
        });
        // The default (no limit) still returns every discovered session, and an
        // out-of-range limit is clamped instead of exploding the header scan.
        expect(store.recentSessions()).toHaveLength(4);
        expect(store.recentSessions(0)).toHaveLength(4);
    });

    it("keeps hidden entries in list(); the UI decides ordering", async () => {
        const { store } = setup();
        const bId = workspaceIdForCwd(projectB);
        await store.update(bId, { hidden: true, pinned: true, alias: "Bee" });
        expect(store.list().find((w) => w.workspaceId === bId)).toMatchObject({
            hidden: true,
            pinned: true,
            alias: "Bee",
        });
        expect(store.get(bId)?.hidden).toBe(true);
    });

    it("keeps secondary rows in list() and get() so deep links still resolve", async () => {
        // The sandbox lives under $TMPDIR, so temp-hiding is switched off here to
        // isolate the hidden/ghost rules (and to exercise the env injection).
        const { store } = setup({ env: { PI2_WORKSPACE_HIDE_TEMP: "0" } });
        const bId = workspaceIdForCwd(projectB);
        await store.update(bId, { hidden: true });
        const ghostId = workspaceIdForCwd(projectGhost);

        const all = store.list();
        expect(all).toHaveLength(3);
        expect(all.map((workspace) => workspace.workspaceId).sort()).toEqual(
            [workspaceIdForCwd(projectA), bId, ghostId].sort(),
        );

        expect(store.get(bId)).toMatchObject({ hidden: true, visibility: "secondary", visibilityReason: "hidden" });
        expect(store.get(ghostId)).toMatchObject({
            exists: false,
            visibility: "secondary",
            visibilityReason: "ghost",
        });
        expect(store.get(workspaceIdForCwd(projectA))).toMatchObject({ visibility: "default" });
        expect(store.get(workspaceIdForCwd(projectA))).not.toHaveProperty("visibilityReason");
    });

    it("classifies sandbox paths under $TMPDIR as temp when the policy is on", () => {
        const { store } = setup({ env: {} });
        expect(store.get(workspaceIdForCwd(projectA))).toMatchObject({
            visibility: "secondary",
            visibilityReason: "temp",
        });
    });

    it("add() clears hidden on a previously hidden workspace", async () => {
        const { store, registry } = setup({ env: { PI2_WORKSPACE_HIDE_TEMP: "0" } });
        const info = await store.add({ cwd: projectA });
        await store.update(info.workspaceId, { hidden: true });
        expect(store.get(info.workspaceId)).toMatchObject({
            hidden: true,
            visibility: "secondary",
            visibilityReason: "hidden",
        });

        const reopened = await store.add({ cwd: projectA });
        expect(reopened).toMatchObject({ hidden: false, visibility: "default" });
        expect(reopened).not.toHaveProperty("visibilityReason");
        expect(registry.get(info.workspaceId)?.entry.hidden).toBe(false);
        expect(registry.list()).toHaveLength(1);
    });

    it("adds existing, readable, writable directories inside the allowlist", async () => {
        const { store, registry } = setup();
        const info = await store.add({ cwd: projectA, alias: "  Alpha  ", trust: true });

        expect(info).toMatchObject({
            workspaceId: workspaceIdForCwd(projectA),
            alias: "Alpha",
            trusted: true,
            pinned: false,
            hidden: false,
        });
        expect(registry.list()).toHaveLength(1);

        const again = await store.add({ cwd: projectA, alias: "Renamed" });
        expect(again.workspaceId).toBe(info.workspaceId);
        expect(again.alias).toBe("Renamed");
        expect(again.trusted).toBe(true);
        expect(registry.list()).toHaveLength(1);
    });

    it("rejects paths outside the allowlist with E_FORBIDDEN", async () => {
        const outside = join(sandbox, "outside");
        mkdirSync(outside);
        const { store } = setup();

        await expect(store.add({ cwd: outside })).rejects.toMatchObject({
            code: "E_FORBIDDEN",
            name: "WorkspaceError",
        });
        await expect(store.add({ cwd: sandbox })).rejects.toMatchObject({ code: "E_FORBIDDEN" });
    });

    it("rejects symlinks that escape the allowlist", async () => {
        const outside = join(sandbox, "outside");
        mkdirSync(outside);
        const link = join(allowRoot, "escape");
        symlinkSync(outside, link);
        const { store } = setup();

        await expect(store.add({ cwd: link })).rejects.toMatchObject({ code: "E_FORBIDDEN" });
    });

    it("honours PI2_WORKSPACE_ROOTS (comma separated) when no explicit roots are given", async () => {
        const outside = join(sandbox, "outside");
        mkdirSync(outside);
        const previous = process.env.PI2_WORKSPACE_ROOTS;
        process.env.PI2_WORKSPACE_ROOTS = `${join(sandbox, "nope")}, ${allowRoot}`;
        try {
            const { store } = setup({ roots: undefined });
            await expect(store.add({ cwd: projectB })).resolves.toMatchObject({ cwd: projectB });
            await expect(store.add({ cwd: outside })).rejects.toMatchObject({ code: "E_FORBIDDEN" });
        } finally {
            if (previous === undefined) delete process.env.PI2_WORKSPACE_ROOTS;
            else process.env.PI2_WORKSPACE_ROOTS = previous;
        }
    });

    it("expands ~ and ~/… against the store's home before the allowlist check", async () => {
        const home = join(allowRoot, "home");
        const project = join(home, "project");
        mkdirSync(project, { recursive: true });
        const { store, registry } = setup({ env: { PI2_WORKSPACE_HIDE_TEMP: "0" }, home });

        const root = await store.add({ cwd: "~" });
        expect(root.workspaceId).toBe(workspaceIdForCwd(home));
        expect(root.cwd).toBe(home);
        expect(root.alias).toBeNull();

        const child = await store.add({ cwd: "~/project", alias: "Project" });
        expect(child.workspaceId).toBe(workspaceIdForCwd(project));
        expect(child.cwd).toBe(project);
        expect(child.alias).toBe("Project");
        expect(registry.list()).toHaveLength(2);
    });

    it("rejects ~user/… and names the accepted forms in the message", async () => {
        const { store } = setup({ home: allowRoot });

        await expect(store.add({ cwd: "~alice/project" })).rejects.toMatchObject({
            code: "E_BAD_REQUEST",
            message: expect.stringContaining("cwd must be an absolute path (or start with ~/)"),
        });
        await expect(store.add({ cwd: "relative/project" })).rejects.toMatchObject({
            code: "E_BAD_REQUEST",
            message: expect.stringContaining("cwd must be an absolute path (or start with ~/)"),
        });
    });

    it("validates relative, missing and non-directory paths", async () => {
        const file = join(allowRoot, "file.txt");
        writeFileSync(file, "x");
        const { store } = setup();

        await expect(store.add({ cwd: "relative/project" })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
        await expect(store.add({ cwd: join(allowRoot, "missing") })).rejects.toMatchObject({
            code: "E_NOT_FOUND",
        });
        await expect(store.add({ cwd: file })).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    });

    it("makes ensureForCwd idempotent without applying the allowlist (instance connects)", async () => {
        const outside = join(sandbox, "outside");
        mkdirSync(outside);
        const { store, registry } = setup();

        const first = await store.ensureForCwd(projectA);
        const second = await store.ensureForCwd(projectA);
        expect(second.workspaceId).toBe(first.workspaceId);
        expect(registry.list()).toHaveLength(1);

        const external = await store.ensureForCwd(outside);
        expect(external.cwd).toBe(outside);
        expect(external.trusted).toBe(false);

        await expect(store.ensureForCwd("relative")).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
    });

    it("updates discovered-only workspaces by registering them first", async () => {
        const { store, registry } = setup();
        const bId = workspaceIdForCwd(projectB);
        expect(registry.get(bId)).toBeUndefined();

        const updated = await store.update(bId, { pinned: true, trusted: true });
        expect(updated).toMatchObject({ workspaceId: bId, pinned: true, trusted: true });
        expect(registry.get(bId)?.entry.cwd).toBe(projectB);

        await expect(store.update("0000000000000000", { pinned: true })).rejects.toMatchObject({
            code: "E_NOT_FOUND",
        });
    });

    it("removes only the registry entry and leaves session files on disk", async () => {
        const { store, registry } = setup();
        const info = await store.add({ cwd: projectA, alias: "Alpha", trust: true });
        const sessionDir = join(sessions, encodedDirName(projectA));
        expect(readdirSync(sessionDir)).toHaveLength(2);

        await store.remove(info.workspaceId);
        expect(registry.get(info.workspaceId)).toBeUndefined();
        expect(existsSync(sessionDir)).toBe(true);
        expect(readdirSync(sessionDir)).toHaveLength(2);

        // The workspace reappears from disk discovery, but without registry metadata.
        const after = store.get(info.workspaceId);
        expect(after).toMatchObject({ exists: true, sessionCount: 2, trusted: false });
        expect(after?.alias).toBeNull();

        await expect(store.remove("0000000000000000")).resolves.toBeUndefined();
    });

    it("refresh() picks up new session files", async () => {
        const { store } = setup();
        const aId = workspaceIdForCwd(projectA);
        expect(store.get(aId)?.sessionCount).toBe(2);

        writeFileSync(
            join(sessions, encodedDirName(projectA), "2026-10-14T06-40-33-032Z_a3.jsonl"),
            `${sessionHeader(projectA, "a3")}\n`,
        );
        await store.refresh(aId);
        expect(store.get(aId)?.sessionCount).toBe(3);

        await store.refresh();
        expect(store.list()).toHaveLength(3);
    });

    it("tolerates a missing instance manager", () => {
        const { store } = setup({ instances: undefined });
        expect(store.list().every((w) => w.liveCount === 0 && w.instance === null)).toBe(true);
    });

    it("counts live sessions from instanceStates() even when list() has a stopped instance", async () => {
        const aId = workspaceIdForCwd(projectA);
        const listed = [instance(aId, { status: "stopped" })];
        const connected = [instance(aId, { sessionCount: 2 })];
        const { store } = setup({ instances: fakeInstances(listed, connected) });

        const info = store.get(aId);
        expect(info?.instance).toMatchObject({ status: "stopped" });
        expect(info?.liveCount).toBe(2);
    });
});
