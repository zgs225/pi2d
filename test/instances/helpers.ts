/**
 * Test harness for the instance layer.
 *
 * Three pieces:
 *   - `makeTempEnv()` isolates `PI2_RUNTIME_DIR`/`PI2_DATA_DIR`/`PI2_STATE_DIR`
 *     so the real `core/paths.ts` helpers point into a scratch directory.
 *   - `PluginClient` speaks the plugin side of the JSONL protocol over a real
 *     unix socket (tests of `plugin-server` / `connection`).
 *   - `writeFakeNvim()` generates an executable node script that impersonates
 *     `nvim` for `PI2_NVIM_BIN`: it dials the daemon, says `hello`, answers
 *     commands with `ack`/`error`, emits snapshots/instance_state, and can be
 *     told to crash or ignore shutdown.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonTokenPath } from "../../src/core/paths.js";
import { FakeBus } from "../daemon/fakes.js";

export { FakeBus };

export interface TempEnv {
    dir: string;
    runtime: string;
    data: string;
    state: string;
    /** Restores the env vars captured at creation (call from afterEach/afterAll). */
    restore(): void;
    cleanup(): void;
}

const ENV_KEYS = [
    "PI2_RUNTIME_DIR",
    "PI2_DATA_DIR",
    "PI2_STATE_DIR",
    "PI2_NVIM_BIN",
    "PI2_NVIM_INIT",
    "PI2_PLUGIN_DIR",
    "PI2_ENSURE_TIMEOUT_MS",
] as const;

export function makeTempEnv(prefix = "pi2-daemon-instances-"): TempEnv {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const runtime = join(dir, "run");
    const data = join(dir, "data");
    const state = join(dir, "state");
    for (const path of [runtime, data, state]) mkdirSync(path, { recursive: true, mode: 0o700 });

    const saved = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) saved.set(key, process.env[key]);
    // The developer's own spawn knobs must not decide which init a test spawns
    // with: clear them so the default (generated host init) is what runs.
    for (const key of ["PI2_NVIM_BIN", "PI2_NVIM_INIT", "PI2_PLUGIN_DIR", "PI2_ENSURE_TIMEOUT_MS"] as const) {
        delete process.env[key];
    }
    process.env.PI2_RUNTIME_DIR = runtime;
    process.env.PI2_DATA_DIR = data;
    process.env.PI2_STATE_DIR = state;

    return {
        dir,
        runtime,
        data,
        state,
        restore() {
            for (const [key, value] of saved) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        },
        cleanup() {
            this.restore();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

export function readDaemonToken(): string {
    return readFileSync(daemonTokenPath(), "utf8").trim();
}

export function makeHello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        v: 1,
        type: "hello",
        token: readDaemonToken(),
        instanceId: "i-test-1",
        workspaceId: "ws-test",
        cwd: "/repo/ws-test",
        pid: process.pid,
        hasUI: false,
        listenAddr: "/tmp/i-test.sock",
        pluginVersion: "1.8.0",
        capabilities: ["snapshot", "attention"],
        ...overrides,
    };
}

export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
    predicate: () => T | undefined | false | null,
    timeoutMs = 3_000,
    intervalMs = 10,
    label = "condition",
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const value = predicate();
            if (value) return value;
        } catch (error) {
            lastError = error;
        }
        await delay(intervalMs);
    }
    throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ""}`);
}

export interface PluginClientOptions {
    socketPath: string;
    /** Defaults to `makeHello()`; pass `false` to send nothing automatically. */
    hello?: Record<string, unknown> | false;
    connectTimeoutMs?: number;
}

type RecordHandler = (record: Record<string, unknown>) => void;

interface Waiter {
    predicate: (record: Record<string, unknown>) => boolean;
    resolve: (record: Record<string, unknown>) => void;
    timer: NodeJS.Timeout;
}

/** A plugin-side JSONL client used by plugin-server / connection tests. */
export class PluginClient {
    readonly socket: Socket;
    readonly records: Record<string, unknown>[] = [];
    readonly rawLines: string[] = [];
    readonly closePromise: Promise<void>;

    private buffer = "";
    private waiters: Waiter[] = [];
    private handlers: RecordHandler[] = [];
    private closed = false;
    private closeReason = "";

    private constructor(socket: Socket) {
        this.socket = socket;
        this.closePromise = new Promise<void>((resolve) => {
            socket.once("close", () => {
                this.closed = true;
                resolve();
            });
        });
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => this.onData(chunk));
        socket.on("error", () => {
            // close event handles cleanup
        });
    }

    static async connect(options: PluginClientOptions): Promise<PluginClient> {
        const socket = connect(options.socketPath);
        socket.setEncoding("utf8");
        const client = new PluginClient(socket);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`connect to ${options.socketPath} timed out`)),
                options.connectTimeoutMs ?? 3_000,
            );
            timer.unref?.();
            socket.once("connect", () => {
                clearTimeout(timer);
                resolve();
            });
            socket.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
        });
        if (options.hello !== false) {
            client.send(options.hello ?? makeHello());
        }
        return client;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    get reason(): string {
        return this.closeReason;
    }

    send(record: Record<string, unknown>): void {
        this.sendRaw(`${JSON.stringify(record)}\n`);
    }

    sendRaw(text: string): void {
        if (this.socket.destroyed) return;
        this.socket.write(text);
    }

    onRecord(handler: RecordHandler): () => void {
        this.handlers.push(handler);
        return () => {
            this.handlers = this.handlers.filter((candidate) => candidate !== handler);
        };
    }

    /** Resolves with the first matching record (already received ones included). */
    async next(
        type: string,
        predicate: (record: Record<string, unknown>) => boolean = () => true,
        timeoutMs = 3_000,
    ): Promise<Record<string, unknown>> {
        const matches = (record: Record<string, unknown>): boolean => record.type === type && predicate(record);
        const existing = this.records.find(matches);
        if (existing) return existing;

        return new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
                reject(
                    new Error(
                        `timed out waiting for "${type}" after ${timeoutMs}ms; got ${JSON.stringify(this.records.map((r) => r.type))}`,
                    ),
                );
            }, timeoutMs);
            timer.unref?.();
            const waiter: Waiter = {
                predicate: matches,
                resolve: (record) => {
                    clearTimeout(timer);
                    resolve(record);
                },
                timer,
            };
            this.waiters.push(waiter);
            const late = this.records.find(matches);
            if (late) {
                this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
                clearTimeout(timer);
                resolve(late);
            }
        });
    }

    recordsOfType(type: string): Record<string, unknown>[] {
        return this.records.filter((record) => record.type === type);
    }

    async waitForClosed(timeoutMs = 3_000): Promise<void> {
        if (this.closed) return;
        await Promise.race([
            this.closePromise,
            delay(timeoutMs).then(() => {
                throw new Error(`socket did not close within ${timeoutMs}ms`);
            }),
        ]);
    }

    close(): void {
        if (!this.socket.destroyed) this.socket.destroy();
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
            let line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (line.trim() !== "") {
                this.rawLines.push(line);
                try {
                    const record = JSON.parse(line) as Record<string, unknown>;
                    this.records.push(record);
                    for (const handler of [...this.handlers]) {
                        try {
                            handler(record);
                        } catch {
                            // test handler failures surface through assertions
                        }
                    }
                    for (const waiter of [...this.waiters]) {
                        if (!waiter.predicate(record)) continue;
                        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
                        clearTimeout(waiter.timer);
                        waiter.resolve(record);
                    }
                } catch {
                    // non-JSON from the daemon is a test failure surfaced via rawLines
                }
            }
            newline = this.buffer.indexOf("\n");
        }
    }
}

export interface FakeNvimOptions {
    mode?: "ok" | "no-hello" | "bad-token" | "wrong-version" | "exit-immediately" | "exit-first-run";
    instanceId?: string;
    workspaceId?: string;
    pluginVersion?: string;
    hasUI?: boolean;
    /** Sessions reported via `instance_state` right after hello. */
    sessions?: string[];
    /** Snapshot state sent for each subscribed session. */
    snapshotState?: Record<string, unknown>;
    /** Snapshots emitted right after hello. */
    snapshots?: { sessionId: string; epoch?: string; seq?: number; state?: Record<string, unknown> }[];
    crashAfterMs?: number;
    crashExitCode?: number;
    ackDelayMs?: number;
    cmdMode?: "ack" | "error" | "silent";
    ignoreShutdown?: boolean;
    ignoreSigterm?: boolean;
    exitCode?: number;
    /** For `exit-first-run`: how many initial runs exit instead of connecting. */
    failRuns?: number;
    runLog?: string;
}

export interface FakeNvim {
    bin: string;
    runLog: string;
    counterFile: string;
}

/** Creates an executable node script that impersonates nvim on the daemon socket. */
export function writeFakeNvim(dir: string, options: FakeNvimOptions = {}): FakeNvim {
    const suffix = Math.random().toString(16).slice(2);
    const runLog = options.runLog ?? join(dir, `runs-${suffix}.jsonl`);
    const counterFile = join(dir, `runs-${suffix}.txt`);
    const bin = join(dir, `fake-nvim-${suffix}.mjs`);
    const payload = {
        ...options,
        runLog,
        counterFile,
    };
    writeFileSync(bin, fakeNvimScript(payload), { mode: 0o755 });
    chmodSync(bin, 0o755);
    return { bin, runLog, counterFile };
}

export function readRunLog(path: string): Record<string, unknown>[] {
    try {
        return readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
        return [];
    }
}

export function startRecords(runLog: string): Record<string, unknown>[] {
    return readRunLog(runLog).filter((entry) => entry.kind === "start");
}

function fakeNvimScript(options: FakeNvimOptions & { runLog: string; counterFile: string }): string {
    const literal = JSON.stringify(options);
    return `#!/usr/bin/env node
// Generated by test/instances/helpers.ts — impersonates nvim for PI2_NVIM_BIN.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const opts = ${literal};
const argv = process.argv.slice(2);
const listenIndex = argv.indexOf("--listen");
const listenAddr = listenIndex >= 0 ? argv[listenIndex + 1] : null;

function log(entry) {
    if (!opts.runLog) return;
    try {
        appendFileSync(opts.runLog, JSON.stringify({ pid: process.pid, at: Date.now(), ...entry }) + "\\n");
    } catch {
        // ignore
    }
}

log({
    kind: "start",
    argv,
    cwd: process.cwd(),
    listenAddr,
    env: {
        PI2_RUNTIME_DIR: process.env.PI2_RUNTIME_DIR,
        PI2_DAEMON_SOCKET: process.env.PI2_DAEMON_SOCKET,
        PI2_DAEMON_TOKEN_PATH: process.env.PI2_DAEMON_TOKEN_PATH,
        PI2_WORKSPACE_ID: process.env.PI2_WORKSPACE_ID,
    },
});

if (opts.mode === "exit-immediately") process.exit(opts.exitCode ?? 3);

if (opts.mode === "exit-first-run") {
    let runs = 0;
    try {
        runs = Number(readFileSync(opts.counterFile, "utf8")) || 0;
    } catch {
        runs = 0;
    }
    runs += 1;
    writeFileSync(opts.counterFile, String(runs));
    log({ kind: "run", runs });
    if (runs <= (opts.failRuns ?? 1)) process.exit(opts.exitCode ?? 3);
}

if (opts.ignoreShutdown || opts.ignoreSigterm) {
    // Keep the event loop alive after the daemon drops the socket so the test can
    // observe the SIGTERM -> SIGKILL escalation.
    setInterval(() => {}, 1_000);
    process.on("SIGTERM", () => log({ kind: "sigterm" }));
}

const token =
    opts.mode === "bad-token"
        ? "0".repeat(64)
        : readFileSync(process.env.PI2_DAEMON_TOKEN_PATH, "utf8").trim();
const workspaceId = opts.workspaceId ?? process.env.PI2_WORKSPACE_ID;
const instanceId = opts.instanceId ?? ("i-fake-" + process.pid);
const socket = connect(process.env.PI2_DAEMON_SOCKET);
socket.setEncoding("utf8");

let buffer = "";
let seq = 0;
let closed = false;

function rawSend(record) {
    if (closed || socket.destroyed) return;
    socket.write(JSON.stringify({ v: 1, ...record }) + "\\n");
}

socket.on("connect", () => {
    if (opts.mode === "no-hello") {
        log({ kind: "silent" });
        return;
    }
    rawSend({
        type: "hello",
        v: opts.mode === "wrong-version" ? 2 : 1,
        token,
        instanceId,
        workspaceId,
        cwd: process.cwd(),
        pid: process.pid,
        hasUI: opts.hasUI ?? false,
        listenAddr,
        pluginVersion: opts.pluginVersion ?? "9.9.9-fake",
        capabilities: ["snapshot", "attention"],
    });
    log({ kind: "hello-sent", instanceId });
    if (opts.mode === "bad-token" || opts.mode === "wrong-version") return;

    setTimeout(() => {
        if (opts.sessions) {
            rawSend({
                type: "instance_state",
                payload: {
                    status: "ready",
                    sessions: opts.sessions.map((sessionId) => ({ sessionId })),
                },
            });
        }
        if (opts.snapshots) {
            for (const snapshot of opts.snapshots) {
                const state = snapshot.state ?? { ...(opts.snapshotState ?? {}), sessionId: snapshot.sessionId };
                rawSend({
                    type: "snapshot",
                    sessionId: snapshot.sessionId,
                    epoch: snapshot.epoch ?? instanceId,
                    seq: snapshot.seq ?? ++seq,
                    payload: { state },
                });
            }
        }
    }, 0);

    if (opts.crashAfterMs !== undefined) {
        setTimeout(() => {
            log({ kind: "crash" });
            process.exit(opts.crashExitCode ?? 0);
        }, opts.crashAfterMs);
    }
});

function handleCmd(record) {
    log({ kind: "cmd", id: record.id, method: record.payload?.method });
    if (opts.cmdMode === "silent") return;
    const send = () => {
        if (opts.cmdMode === "error") {
            rawSend({ type: "error", id: record.id, payload: { code: "E_INTERNAL", message: "fake failure", retryable: false } });
        } else {
            rawSend({ type: "ack", id: record.id, seq: ++seq, payload: { disposition: "started" } });
        }
    };
    if (opts.ackDelayMs) setTimeout(send, opts.ackDelayMs);
    else send();
}

socket.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\\n");
    while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\\n");
        if (!line.trim()) continue;
        let record;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        log({ kind: "record", record });
        if (record.type === "hello_ack") {
            log({ kind: "hello-ack", rejected: record.rejected ?? null });
            if (record.rejected) {
                closed = true;
                socket.end();
                return;
            }
            continue;
        }
        if (record.type === "cmd") handleCmd(record);
        if (record.type === "sub.subscribe" && opts.snapshotState) {
            rawSend({
                type: "snapshot",
                sessionId: record.sessionId,
                epoch: instanceId,
                seq: ++seq,
                payload: { state: { ...opts.snapshotState, sessionId: record.sessionId } },
            });
        }
        if (record.type === "instance.shutdown") {
            log({ kind: "shutdown", mode: record.payload?.mode });
            if (!opts.ignoreShutdown) {
                rawSend({ type: "bye" });
                setTimeout(() => {
                    closed = true;
                    socket.end();
                    process.exit(0);
                }, 10);
            }
        }
        if (record.type === "test.exit") process.exit(record.payload?.code ?? 0);
    }
});

socket.on("error", () => {
    // the daemon may be gone; tests observe the run log
});
`;
}
