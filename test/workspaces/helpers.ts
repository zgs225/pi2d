import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SessionSpec {
    /** File name inside the encoded session directory. */
    name: string;
    /** cwd written into the session header (authoritative). */
    cwd: string;
    id?: string;
    timestamp?: string;
    /** Extra JSONL lines appended after the header (never parsed by discovery). */
    body?: string;
    /** File mtime, used to test newest-file selection. */
    mtime?: Date | number;
}

export function makeSandbox(prefix = "pi2d-ws-"): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string | undefined): void {
    if (dir) rmSync(dir, { recursive: true, force: true });
}

/** Mimics pi's `--<cwd with slashes replaced by dashes>--` directory naming. */
export function encodedDirName(cwd: string): string {
    return `--${cwd.replace(/^\/+/, "").replace(/\//g, "-")}--`;
}

export function sessionHeader(cwd: string, id: string, timestamp = "2026-10-10T06:40:33.032Z"): string {
    return JSON.stringify({ type: "session", version: 3, id, timestamp, cwd });
}

/** Creates an encoded sessions directory with real-looking JSONL files. */
export function writeSessionDir(root: string, dirName: string, files: SessionSpec[]): string {
    const dir = join(root, dirName);
    mkdirSync(dir, { recursive: true });
    for (const file of files) {
        const id = file.id ?? "01a00000-0000-7000-8000-000000000000";
        const timestamp = file.timestamp ?? "2026-10-10T06:40:33.032Z";
        const body = file.body ?? '{"type":"message","id":"m1","message":{"role":"user","content":"hi"}}\n';
        const path = join(dir, file.name);
        writeFileSync(path, `${sessionHeader(file.cwd, id, timestamp)}\n${body}`);
        if (file.mtime !== undefined) utimesSync(path, file.mtime, file.mtime);
    }
    return dir;
}
