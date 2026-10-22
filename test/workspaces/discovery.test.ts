import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workspaceIdForCwd } from "../../src/core/paths.js";
import { createDiscovery } from "../../src/workspaces/discovery.js";
import { cleanup, encodedDirName, makeSandbox, sessionHeader, writeSessionDir } from "./helpers.js";

describe("workspace disk discovery", () => {
    let sandbox: string;
    let root: string;

    beforeEach(() => {
        sandbox = makeSandbox("pi2-daemon-discovery-");
        root = join(sandbox, "agent", "sessions");
        mkdirSync(root, { recursive: true });
    });

    afterEach(() => cleanup(sandbox));

    it("returns nothing when the sessions root is missing", () => {
        const discovery = createDiscovery({ root: join(sandbox, "nope") });
        expect(discovery.discover()).toEqual([]);
        expect(discovery.listSessions("/tmp")).toEqual([]);
    });

    it("uses the header cwd as authoritative for dashed and unicode paths", () => {
        // A path where '-' is both a literal path character and the encoded separator.
        const project = join(sandbox, "weird-dir", "日本語", "sub-dir");
        mkdirSync(project, { recursive: true });
        // Deliberately misleading directory name: it cannot be reversed.
        writeSessionDir(root, "--definitely-not-weird-dir--", [
            { name: "2026-10-10T06-40-33-032Z_a.jsonl", cwd: project, id: "session-a" },
        ]);

        const [entry] = createDiscovery({ root }).discover();
        expect(entry).toMatchObject({
            cwd: project,
            workspaceId: workspaceIdForCwd(project),
            sessionCount: 1,
            exists: true,
            dir: join(root, "--definitely-not-weird-dir--"),
        });
        expect(entry?.lastActiveAt).toBeTypeOf("number");
    });

    it("selects the newest file by mtime, not by file name", () => {
        const oldProject = join(sandbox, "old-project");
        const newProject = join(sandbox, "new-project");
        mkdirSync(oldProject);
        mkdirSync(newProject);
        writeSessionDir(root, encodedDirName(newProject), [
            {
                name: "2026-12-31T23-59-59-999Z_lexicographically-newest.jsonl",
                cwd: oldProject,
                id: "old",
                mtime: new Date("2026-01-01T00:00:00.000Z"),
            },
            {
                name: "2000-01-01T00-00-00-000Z_actually-newest.jsonl",
                cwd: newProject,
                id: "new",
                mtime: new Date("2026-06-01T00:00:00.000Z"),
            },
        ]);

        const [entry] = createDiscovery({ root }).discover();
        expect(entry?.cwd).toBe(newProject);
        expect(entry?.sessionCount).toBe(2);
        expect(entry?.lastActiveAt).toBe(Date.parse("2026-06-01T00:00:00.000Z"));
    });

    it("keeps ghost workspaces flagged instead of dropping them", () => {
        const gone = join(sandbox, "deleted-project");
        writeSessionDir(root, encodedDirName(gone), [
            { name: "2026-10-10T06-40-33-032Z_ghost.jsonl", cwd: gone, id: "ghost" },
        ]);

        const [entry] = createDiscovery({ root }).discover();
        expect(entry).toMatchObject({ cwd: gone, exists: false, sessionCount: 1 });
    });

    it("skips directories with no session files and ignores non-jsonl files", () => {
        mkdirSync(join(root, "--empty--"));
        writeSessionDir(root, "--only-noise--", []);
        writeFileSync(join(root, "--only-noise--", "notes.txt"), "not a session");
        writeSessionDir(root, "--real--", [
            { name: "2026-10-10T06-40-33-032Z_real.jsonl", cwd: sandbox, id: "real" },
        ]);

        expect(createDiscovery({ root }).discover()).toHaveLength(1);
    });

    it("never parses past the first line", () => {
        const dir = writeSessionDir(root, encodedDirName(sandbox), [
            {
                name: "2026-10-10T06-40-33-032Z_header.jsonl",
                cwd: sandbox,
                id: "header",
                body: "this is not json at all\n{}]\n",
            },
        ]);

        const discovery = createDiscovery({ root });
        expect(discovery.discover()[0]?.cwd).toBe(sandbox);
        expect(discovery.listSessions(sandbox)[0]?.id).toBe("header");
        expect(statSync(join(dir, "2026-10-10T06-40-33-032Z_header.jsonl")).isFile()).toBe(true);
    });

    it("serves a cache hit without re-reading the header", () => {
        const dir = writeSessionDir(root, encodedDirName(sandbox), [
            { name: "2026-10-10T06-40-33-032Z_cached.jsonl", cwd: sandbox, id: "cached" },
        ]);
        const file = join(dir, "2026-10-10T06-40-33-032Z_cached.jsonl");
        const discovery = createDiscovery({ root });
        expect(discovery.discover()[0]?.cwd).toBe(sandbox);

        // Corrupt the header in place (directory mtime and file count unchanged).
        writeFileSync(file, `${JSON.stringify({ type: "not-a-session", cwd: "/definitely/wrong" })}\n`);

        // Still served from cache: the header was not read again.
        expect(discovery.discover()[0]?.cwd).toBe(sandbox);

        // Explicit invalidation forces a re-read and the header is now unusable.
        discovery.invalidate();
        expect(discovery.discover()).toEqual([]);
    });

    it("detects newly created session files via the directory signature", () => {
        const dir = writeSessionDir(root, encodedDirName(sandbox), [
            { name: "2026-10-10T06-40-33-032Z_one.jsonl", cwd: sandbox, id: "one" },
        ]);
        const discovery = createDiscovery({ root });
        expect(discovery.discover()[0]?.sessionCount).toBe(1);

        writeFileSync(
            join(dir, "2026-10-11T06-40-33-032Z_two.jsonl"),
            `${sessionHeader(sandbox, "two")}\n`,
        );
        expect(discovery.discover()[0]?.sessionCount).toBe(2);
        expect(discovery.listSessions(sandbox)).toHaveLength(2);
    });

    it("invalidates a single directory when asked", () => {
        const other = join(sandbox, "other");
        mkdirSync(other);
        const dirA = writeSessionDir(root, encodedDirName(sandbox), [
            { name: "2026-10-10T06-40-33-032Z_a.jsonl", cwd: sandbox, id: "a" },
        ]);
        writeSessionDir(root, encodedDirName(other), [
            { name: "2026-10-10T06-40-33-032Z_b.jsonl", cwd: other, id: "b" },
        ]);
        const discovery = createDiscovery({ root });
        expect(discovery.discover()).toHaveLength(2);

        discovery.invalidate(dirA);
        // Both still discoverable; the cache entry for A was dropped and rebuilt.
        expect(discovery.discover()).toHaveLength(2);
    });

    it("lists sessions from the header only, newest first", () => {
        const dir = writeSessionDir(root, encodedDirName(sandbox), [
            {
                name: "2026-01-01T00-00-00-000Z_old.jsonl",
                cwd: sandbox,
                id: "header-old",
                timestamp: "2026-01-01T00:00:00.000Z",
                mtime: new Date("2026-01-02T00:00:00.000Z"),
                body: "garbage that must never be parsed\n",
            },
            {
                name: "2026-02-02T00-00-00-000Z_new.jsonl",
                cwd: sandbox,
                id: "header-new",
                timestamp: "2026-02-02T00:00:00.000Z",
                mtime: new Date("2026-02-03T00:00:00.000Z"),
            },
        ]);

        const sessions = createDiscovery({ root }).listSessions(sandbox);
        expect(sessions.map((s) => s.id)).toEqual(["header-new", "header-old"]);
        expect(sessions[0]).toMatchObject({
            file: join(dir, "2026-02-02T00-00-00-000Z_new.jsonl"),
            timestamp: Date.parse("2026-02-02T00:00:00.000Z"),
            modified: Date.parse("2026-02-03T00:00:00.000Z"),
        });
        expect(sessions.every((s) => s.firstMessage === undefined)).toBe(true);
    });

    it("falls back to the file name when a header is unreadable", () => {
        const dir = writeSessionDir(root, encodedDirName(sandbox), [
            { name: "2026-03-01T00-00-00-000Z_good.jsonl", cwd: sandbox, id: "good" },
        ]);
        const broken = join(dir, "2026-03-04T05-06-07-008Z_fallback-id.jsonl");
        writeFileSync(broken, "not a session header\n");
        // Newer mtime so the fallback entry is first.
        utimesSync(broken, new Date("2026-03-05T00:00:00.000Z"), new Date("2026-03-05T00:00:00.000Z"));

        const sessions = createDiscovery({ root }).listSessions(sandbox);
        expect(sessions).toHaveLength(2);
        expect(sessions.find((s) => s.id === "fallback-id")).toMatchObject({
            id: "fallback-id",
            timestamp: Date.parse("2026-03-04T05:06:07.008Z"),
        });
    });

    it("returns no sessions for unknown cwds", () => {
        writeSessionDir(root, encodedDirName(sandbox), [
            { name: "2026-10-10T06-40-33-032Z_a.jsonl", cwd: sandbox, id: "a" },
        ]);
        expect(createDiscovery({ root }).listSessions(join(sandbox, "unknown"))).toEqual([]);
    });

    it("defaults the root to PI_CODING_AGENT_DIR/sessions", () => {
        const agent = join(sandbox, "custom-agent");
        const sessions = join(agent, "sessions");
        mkdirSync(sessions, { recursive: true });
        writeSessionDir(sessions, encodedDirName(sandbox), [
            { name: "2026-10-10T06-40-33-032Z_env.jsonl", cwd: sandbox, id: "env" },
        ]);
        const previous = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = agent;
        try {
            expect(createDiscovery().discover()).toHaveLength(1);
        } finally {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previous;
        }
    });

    it("ignores a vanished directory gracefully", () => {
        const dir = writeSessionDir(root, encodedDirName(sandbox), [
            { name: "2026-10-10T06-40-33-032Z_a.jsonl", cwd: sandbox, id: "a" },
        ]);
        const discovery = createDiscovery({ root });
        expect(discovery.discover()).toHaveLength(1);
        rmSync(dir, { recursive: true, force: true });
        discovery.invalidate();
        expect(discovery.discover()).toEqual([]);
    });
});
