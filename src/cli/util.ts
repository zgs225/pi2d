/** Small shared helpers for the `pi2` command line front end (and `pi2 daemon`). */
import { realpathSync } from "node:fs";
import { version } from "../core/install.js";

/** Bad arguments; the CLI prints the usage block and exits 2. */
export class UsageError extends Error {
    readonly usage: string | undefined;

    constructor(message: string, usage?: string) {
        super(message);
        this.name = "UsageError";
        this.usage = usage;
    }
}

/** A user-facing failure: printed as-is, exits with `code`. */
export class CliError extends Error {
    readonly code: number;

    constructor(message: string, code = 1) {
        super(message);
        this.name = "CliError";
        this.code = code;
    }
}

export type FlagValue = string | boolean;

export interface FlagSpec {
    /** Flags that take a value (`--port 7676` or `--port=7676`). */
    values?: readonly string[];
    /** Flags that do not (`--force`). */
    booleans?: readonly string[];
    /** Short aliases: `{ "-h": "--help" }`. */
    aliases?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
    positionals: string[];
    flags: Record<string, FlagValue>;
}

export function parseArgs(argv: readonly string[], spec: FlagSpec = {}): ParsedArgs {
    const values = new Set(spec.values ?? []);
    const booleans = new Set(spec.booleans ?? []);
    const aliases = spec.aliases ?? {};
    const flags: Record<string, FlagValue> = {};
    const positionals: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const raw = argv[index]!;
        if (raw === "--") {
            positionals.push(...argv.slice(index + 1));
            break;
        }
        if (!raw.startsWith("-") || raw === "-") {
            positionals.push(raw);
            continue;
        }
        const [head, inline] = splitFlag(raw);
        const name = aliases[head] ?? head;
        if (booleans.has(name)) {
            if (inline !== undefined) throw new UsageError(`${name} does not take a value`);
            flags[name] = true;
            continue;
        }
        if (values.has(name)) {
            if (inline !== undefined) {
                flags[name] = inline;
                continue;
            }
            const next = argv[index + 1];
            if (next === undefined || (next.startsWith("-") && next !== "-")) {
                throw new UsageError(`${name} requires a value`);
            }
            flags[name] = next;
            index += 1;
            continue;
        }
        throw new UsageError(`unknown option ${head}`);
    }

    return { positionals, flags };
}

function splitFlag(raw: string): [string, string | undefined] {
    const equals = raw.indexOf("=");
    if (equals === -1) return [raw, undefined];
    return [raw.slice(0, equals), raw.slice(equals + 1)];
}

export function stringFlag(flags: Record<string, FlagValue>, name: string): string | undefined {
    const value = flags[name];
    return typeof value === "string" ? value : undefined;
}

export function boolFlag(flags: Record<string, FlagValue>, name: string): boolean {
    return flags[name] === true;
}

/** Version of the installed package (`dist/cli/*` sits two levels below it). */
export function packageVersion(): string {
    return version();
}

export function realpathOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** Fixed-width text table; the last column is never padded. */
export function formatTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
    const widths = header.map((cell, column) =>
        Math.max(cell.length, ...rows.map((row) => (row[column] ?? "").length)),
    );
    const line = (cells: readonly string[]): string =>
        cells
            .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
            .join("  ")
            .trimEnd();
    return [line(header), line(header.map((_, column) => "-".repeat(widths[column] ?? 0))), ...rows.map(line)].join(
        "\n",
    );
}

/** `1234567` → `1.2 MiB`. */
export function formatBytes(bytes: number | null | undefined): string {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "-";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "-";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h${minutes % 60}m`;
    return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
