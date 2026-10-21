/**
 * Console logger for the CLI entry points.
 *
 * `pi2d` prints exactly one machine-readable line on stdout (`pi2d listening
 * on …`); every log record therefore goes to stderr in JSONL so it can be
 * piped into a log file or a systemd journal without corrupting stdout.
 */
import type { Logger, LogLevel } from "../core/interfaces.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface ConsoleLoggerOptions {
    level?: LogLevel | "silent";
    /** Defaults to `process.stderr`. */
    write?: (line: string) => void;
    now?: () => number;
}

export class ConsoleLogger implements Logger {
    private readonly threshold: number;
    private readonly write: (line: string) => void;
    private readonly now: () => number;
    private readonly fields: Record<string, unknown>;

    constructor(options: ConsoleLoggerOptions = {}, fields: Record<string, unknown> = {}) {
        const level = options.level ?? "info";
        this.threshold = level === "silent" ? Number.POSITIVE_INFINITY : LEVELS[level];
        this.write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
        this.now = options.now ?? Date.now;
        this.fields = fields;
    }

    debug(msg: string, fields?: Record<string, unknown>): void {
        this.log("debug", msg, fields);
    }

    info(msg: string, fields?: Record<string, unknown>): void {
        this.log("info", msg, fields);
    }

    warn(msg: string, fields?: Record<string, unknown>): void {
        this.log("warn", msg, fields);
    }

    error(msg: string, fields?: Record<string, unknown>): void {
        this.log("error", msg, fields);
    }

    child(fields: Record<string, unknown>): Logger {
        return new ConsoleLogger(
            { level: this.threshold === Number.POSITIVE_INFINITY ? "silent" : levelFor(this.threshold), now: this.now },
            { ...this.fields, ...fields },
        );
    }

    private log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
        if (LEVELS[level] < this.threshold) return;
        try {
            this.write(JSON.stringify({ ts: this.now(), level, msg, ...this.fields, ...(fields ?? {}) }));
        } catch {
            // A non-serialisable field must never take the daemon down.
            this.write(JSON.stringify({ ts: this.now(), level, msg }));
        }
    }
}

function levelFor(threshold: number): LogLevel {
    if (threshold <= LEVELS.debug) return "debug";
    if (threshold <= LEVELS.info) return "info";
    if (threshold <= LEVELS.warn) return "warn";
    return "error";
}

export function createLogger(level?: LogLevel | "silent"): ConsoleLogger {
    const envLevel = process.env.PI2_LOG_LEVEL?.trim().toLowerCase();
    const resolved = level ?? (isLogLevel(envLevel) ? envLevel : "info");
    return new ConsoleLogger({ level: resolved });
}

function isLogLevel(value: string | undefined): value is LogLevel | "silent" {
    return value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent";
}
