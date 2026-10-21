import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceIdForCwd } from "../../src/core/paths.js";
import { WorkspaceError, WorkspaceRegistry } from "../../src/workspaces/registry.js";
import { cleanup, makeSandbox } from "./helpers.js";

describe("workspace registry", () => {
    let sandbox: string;
    let file: string;
    let project: string;

    beforeEach(() => {
        sandbox = makeSandbox("pi2d-registry-");
        file = join(sandbox, "data", "workspaces.json");
        project = join(sandbox, "project");
        mkdirSync(project, { recursive: true });
    });

    afterEach(() => cleanup(sandbox));

    it("defaults to dataDir()/workspaces.json", async () => {
        const previous = process.env.PI2_DATA_DIR;
        process.env.PI2_DATA_DIR = join(sandbox, "xdg-data");
        try {
            const registry = new WorkspaceRegistry();
            await registry.ensureForCwd(project);
            expect(registry.filePath).toBe(join(sandbox, "xdg-data", "workspaces.json"));
            expect(existsSync(registry.filePath)).toBe(true);
        } finally {
            if (previous === undefined) delete process.env.PI2_DATA_DIR;
            else process.env.PI2_DATA_DIR = previous;
        }
    });

    it("serialises concurrent writes without losing entries", async () => {
        const other = join(sandbox, "other");
        mkdirSync(other);
        const registry = new WorkspaceRegistry({ filePath: file });

        await Promise.all([registry.ensureForCwd(project), registry.ensureForCwd(other)]);
        expect(registry.list()).toHaveLength(2);
        expect(new WorkspaceRegistry({ filePath: file }).list()).toHaveLength(2);
    });

    it("starts empty when the file does not exist", () => {
        const registry = new WorkspaceRegistry({ filePath: file });
        expect(registry.list()).toEqual([]);
        expect(registry.get("nope")).toBeUndefined();
    });

    it("writes atomically with mode 0600 and leaves no temp files behind", async () => {
        const registry = new WorkspaceRegistry({ filePath: file });
        const record = await registry.ensureForCwd(project);

        expect(existsSync(file)).toBe(true);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(readdirSync(join(sandbox, "data")).filter((n) => n.includes(".tmp"))).toEqual([]);

        const parsed = JSON.parse(readFileSync(file, "utf8")) as {
            version: number;
            workspaces: Record<string, { cwd: string; trusted: boolean }>;
        };
        expect(parsed.version).toBe(1);
        expect(parsed.workspaces[record.workspaceId]?.cwd).toBe(record.entry.cwd);
        expect(parsed.workspaces[record.workspaceId]?.trusted).toBe(false);
    });

    it("forces 0600 even when a pre-existing file was world readable", async () => {
        const registry = new WorkspaceRegistry({ filePath: file });
        await registry.ensureForCwd(project);
        chmodSync(file, 0o644);
        expect(statSync(file).mode & 0o777).toBe(0o644);

        await registry.update(workspaceIdForCwd(project), { pinned: true });
        expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it("backs up a corrupt registry and starts empty", () => {
        mkdirSync(join(sandbox, "data"), { recursive: true });
        const corrupt = '{"version":1,"workspaces":{"broken":';
        writeFileSync(file, corrupt);
        const warnings: string[] = [];

        const registry = new WorkspaceRegistry({
            filePath: file,
            logger: { warn: (msg) => warnings.push(msg) },
        });

        expect(registry.list()).toEqual([]);
        expect(readFileSync(`${file}.bak`, "utf8")).toBe(corrupt);
        expect(warnings.some((w) => w.includes("corrupt"))).toBe(true);
    });

    it("rejects malformed-but-valid JSON as corrupt", () => {
        mkdirSync(join(sandbox, "data"), { recursive: true });
        writeFileSync(file, JSON.stringify({ version: 2, workspaces: {} }));

        const registry = new WorkspaceRegistry({ filePath: file });
        expect(registry.list()).toEqual([]);
        expect(existsSync(`${file}.bak`)).toBe(true);
    });

    it("supports CRUD and persists across instances", async () => {
        const registry = new WorkspaceRegistry({ filePath: file });
        const real = await registry.ensureForCwd(project);
        expect(real.workspaceId).toBe(workspaceIdForCwd(project));
        expect(real.entry.createdAt).toBeGreaterThan(0);

        const byCwd = registry.byCwd(project);
        expect(byCwd?.workspaceId).toBe(real.workspaceId);

        const updated = await registry.update(real.workspaceId, {
            alias: "  My Project  ",
            pinned: true,
            hidden: true,
            trusted: true,
        });
        expect(updated.entry).toMatchObject({
            alias: "My Project",
            pinned: true,
            hidden: true,
            trusted: true,
        });

        const reloaded = new WorkspaceRegistry({ filePath: file });
        expect(reloaded.get(real.workspaceId)?.entry).toMatchObject({
            cwd: real.entry.cwd,
            alias: "My Project",
            pinned: true,
            hidden: true,
            trusted: true,
        });

        const cleared = await reloaded.update(real.workspaceId, { alias: null });
        expect(cleared.entry.alias).toBeUndefined();

        await reloaded.remove(real.workspaceId);
        expect(reloaded.get(real.workspaceId)).toBeUndefined();
        expect(new WorkspaceRegistry({ filePath: file }).list()).toEqual([]);
    });

    it("does not change createdAt or duplicate entries on repeated ensureForCwd", async () => {
        const registry = new WorkspaceRegistry({ filePath: file });
        const first = await registry.ensureForCwd(project);
        const second = await registry.ensureForCwd(project);

        expect(second.workspaceId).toBe(first.workspaceId);
        expect(second.entry.createdAt).toBe(first.entry.createdAt);
        expect(registry.list()).toHaveLength(1);
    });

    it("rejects relative and missing cwds", async () => {
        const registry = new WorkspaceRegistry({ filePath: file });

        await expect(registry.ensureForCwd("relative/path")).rejects.toBeInstanceOf(WorkspaceError);
        await expect(registry.ensureForCwd("relative/path")).rejects.toMatchObject({ code: "E_BAD_REQUEST" });
        await expect(registry.ensureForCwd(join(sandbox, "missing"))).rejects.toMatchObject({
            code: "E_NOT_FOUND",
        });
        expect(registry.list()).toEqual([]);
    });

    it("canonicalises symlinks to one workspace", async () => {
        const { symlinkSync, realpathSync } = await import("node:fs");
        const link = join(sandbox, "link");
        symlinkSync(project, link);

        const registry = new WorkspaceRegistry({ filePath: file });
        const a = await registry.ensureForCwd(project);
        const b = await registry.ensureForCwd(link);

        expect(b.workspaceId).toBe(a.workspaceId);
        expect(b.entry.cwd).toBe(realpathSync(project));
        expect(registry.list()).toHaveLength(1);
    });
});
