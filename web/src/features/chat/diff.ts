/** Unified-diff helpers shared by tool cards and the attention diff review. */

export interface DiffHunk {
    header: string;
    /** Lines prefixed with `+`, `-` or a space. */
    lines: string[];
}

export interface DiffFile {
    path: string;
    hunks: DiffHunk[];
    add: number;
    del: number;
    source?: string;
}

interface Op {
    type: "ctx" | "add" | "del";
    line: string;
}

const MAX_LCS_LINES = 900;

function splitLines(text: string): string[] {
    if (!text) return [];
    // Keep a trailing newline visible in the diff without producing a bogus
    // empty trailing line for files that do not have one.
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

function naiveOps(before: string[], after: string[]): Op[] {
    return [
        ...before.map<Op>((line) => ({ type: "del", line })),
        ...after.map<Op>((line) => ({ type: "add", line })),
    ];
}

/** Line-level LCS diff, with a size guard that degrades to del-all/add-all. */
export function diffOps(before: string[], after: string[]): Op[] {
    const n = before.length;
    const m = after.length;
    if (n === 0 && m === 0) return [];
    if (n * m > MAX_LCS_LINES * MAX_LCS_LINES) return naiveOps(before, after);

    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
            table[i * width + j] =
                before[i] === after[j]
                    ? (table[(i + 1) * width + j + 1] ?? 0) + 1
                    : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
        }
    }

    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (before[i] === after[j]) {
            ops.push({ type: "ctx", line: before[i] ?? "" });
            i += 1;
            j += 1;
        } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
            ops.push({ type: "del", line: before[i] ?? "" });
            i += 1;
        } else {
            ops.push({ type: "add", line: after[j] ?? "" });
            j += 1;
        }
    }
    while (i < n) {
        ops.push({ type: "del", line: before[i] ?? "" });
        i += 1;
    }
    while (j < m) {
        ops.push({ type: "add", line: after[j] ?? "" });
        j += 1;
    }
    return ops;
}

interface PositionedOp extends Op {
    oldLine: number;
    newLine: number;
}

/** Group a flat op list into `@@` hunks with `context` unchanged lines. */
export function toHunks(ops: Op[], context = 3): DiffHunk[] {
    if (!ops.some((op) => op.type !== "ctx")) return [];

    const positioned: PositionedOp[] = [];
    let oldLine = 0;
    let newLine = 0;
    for (const op of ops) {
        positioned.push({ ...op, oldLine, newLine });
        if (op.type !== "add") oldLine += 1;
        if (op.type !== "del") newLine += 1;
    }

    const changed = positioned
        .map((op, index) => (op.type === "ctx" ? -1 : index))
        .filter((index) => index >= 0);
    if (!changed.length) return [];

    const groups: { start: number; end: number }[] = [];
    for (const index of changed) {
        const start = Math.max(0, index - context);
        const end = Math.min(positioned.length - 1, index + context);
        const last = groups[groups.length - 1];
        if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
        else groups.push({ start, end });
    }

    return groups.map(({ start, end }) => {
        const slice = positioned.slice(start, end + 1);
        const first = slice[0];
        const oldStart = (first?.oldLine ?? 0) + 1;
        const newStart = (first?.newLine ?? 0) + 1;
        const oldCount = slice.filter((op) => op.type !== "add").length;
        const newCount = slice.filter((op) => op.type !== "del").length;
        return {
            header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
            lines: slice.map((op) => `${op.type === "add" ? "+" : op.type === "del" ? "-" : " "}${op.line}`),
        };
    });
}

export function unifiedDiff(before: string, after: string, context = 3): DiffHunk[] {
    return toHunks(diffOps(splitLines(before), splitLines(after)), context);
}

export function statsOf(hunks: DiffHunk[]): { add: number; del: number } {
    let add = 0;
    let del = 0;
    for (const hunk of hunks) {
        for (const line of hunk.lines) {
            if (line.startsWith("+")) add += 1;
            else if (line.startsWith("-")) del += 1;
        }
    }
    return { add, del };
}

export function fileDiff(path: string, before: string, after: string, source?: string): DiffFile {
    const hunks = unifiedDiff(before, after);
    const stats = statsOf(hunks);
    return { path, hunks, add: stats.add, del: stats.del, ...(source ? { source } : {}) };
}

function rec(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `attention_request{method:"diff"}` payload → files (also accepts `hunks`). */
export function diffFilesFromPayload(payload: unknown): DiffFile[] {
    const record = rec(payload);
    const list = Array.isArray(payload) ? payload : Array.isArray(record?.files) ? record.files : [];
    const files: DiffFile[] = [];
    for (const raw of list) {
        const file = rec(raw);
        if (!file) continue;
        const path = str(file.path ?? file.file) ?? "file";
        const rawHunks = Array.isArray(file.hunks) ? file.hunks : [];
        let hunks: DiffHunk[] = [];
        if (rawHunks.length) {
            hunks = rawHunks.map((value) => {
                const hunk = rec(value) ?? {};
                const lines = Array.isArray(hunk.lines) ? hunk.lines.map((line) => String(line)) : [];
                return { header: str(hunk.header) ?? "", lines };
            });
        } else if (typeof file.before === "string" || typeof file.after === "string") {
            hunks = unifiedDiff(str(file.before) ?? "", str(file.after) ?? "");
        } else if (typeof file.diff === "string") {
            hunks = [
                {
                    header: "",
                    lines: file.diff.split("\n").filter((line) => line !== ""),
                },
            ];
        }
        const stats = statsOf(hunks);
        files.push({
            path,
            hunks,
            add: num(file.add) ?? stats.add,
            del: num(file.del) ?? stats.del,
            ...(str(file.source ?? file.agent) ? { source: str(file.source ?? file.agent) } : {}),
        });
    }
    return files;
}
