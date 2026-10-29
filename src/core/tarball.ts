/**
 * A dependency-free `tar.gz` reader, for `pi2 update`.
 *
 * The standalone channel ships `<bin>/pi2` plus `<share>/pi2d/web/dist` inside a
 * tarball, and the updater has to unpack it without a `tar` subprocess: tests
 * must stay hermetic (`AGENTS.md` hard rule 5), and the binary should not depend
 * on a shell tool being present.
 *
 * Only what `scripts/build-binary.sh` produces is supported: regular files and
 * directories, ustar/PAX/GNU headers. Symlinks, hardlinks, devices and sparse
 * entries are rejected rather than silently skipped — an archive that contains
 * them is not one of ours.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

export class TarError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TarError";
    }
}

export interface TarEntry {
    /** Relative path, without a leading `./` or `/`. */
    path: string;
    type: "file" | "directory";
    mode: number;
    mtime: number;
    data: Buffer;
}

function readString(header: Buffer, offset: number, length: number): string {
    const slice = header.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}

/** Octal field; GNU writes space/NUL padded values, `base-256` for huge sizes. */
function readNumber(header: Buffer, offset: number, length: number): number {
    const slice = header.subarray(offset, offset + length);
    if ((slice[0] ?? 0) & 0x80) {
        // base-256 (GNU): the remaining bytes are a big-endian integer.
        let value = 0;
        for (let index = 1; index < slice.length; index += 1) value = value * 256 + (slice[index] ?? 0);
        return value;
    }
    const text = readString(header, offset, length).trim();
    if (text === "") return 0;
    const parsed = Number.parseInt(text, 8);
    if (Number.isNaN(parsed)) throw new TarError(`bad octal field at offset ${offset}: "${text}"`);
    return parsed;
}

function headerChecksumMatches(header: Buffer): boolean {
    const expected = readNumber(header, 148, 8);
    let sum = 0;
    for (let index = 0; index < BLOCK; index += 1) {
        sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    }
    return sum === expected;
}

/** `path=…` records out of a PAX extended header body. */
function parsePax(data: Buffer): Map<string, string> {
    const records = new Map<string, string>();
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space === -1) break;
        const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
        if (!Number.isFinite(length) || length <= 0) break;
        const record = data.subarray(space + 1, offset + length).toString("utf8");
        const end = record.indexOf("\n");
        const body = end === -1 ? record : record.slice(0, end);
        const equals = body.indexOf("=");
        if (equals > 0) records.set(body.slice(0, equals), body.slice(equals + 1));
        offset += length;
    }
    return records;
}

function joinPath(prefix: string, name: string): string {
    return prefix === "" ? name : `${prefix}/${name}`;
}

/**
 * Walk a tarball and return its entries in archive order. Throws `TarError` for
 * anything structurally wrong (bad header checksum, truncated data, unsupported
 * entry type).
 */
export function parseTar(archive: Buffer): TarEntry[] {
    const entries: TarEntry[] = [];
    let offset = 0;
    // Carried over from a `x` (per-entry) / `L` (GNU long name) header.
    let nextPax: Map<string, string> | undefined;
    let nextLongName: string | undefined;

    while (offset + BLOCK <= archive.length) {
        const header = archive.subarray(offset, offset + BLOCK);
        if (header.every((byte) => byte === 0)) break;
        if (!headerChecksumMatches(header)) {
            throw new TarError(`header checksum mismatch at offset ${offset}`);
        }

        const typeflag = String.fromCharCode(header[156] ?? 0);
        const size = readNumber(header, 124, 12);
        const mode = readNumber(header, 100, 8);
        const mtime = readNumber(header, 136, 12);
        const prefix = readString(header, 345, 155);
        let name = readString(header, 0, 100);
        const dataStart = offset + BLOCK;
        const dataEnd = dataStart + size;
        if (dataEnd > archive.length) throw new TarError(`truncated entry at offset ${offset}`);
        const body = archive.subarray(dataStart, dataEnd);
        const padded = dataStart + Math.ceil(size / BLOCK) * BLOCK;

        if (typeflag === "x" || typeflag === "g") {
            const records = parsePax(body);
            if (typeflag === "x") nextPax = records;
            offset = padded;
            continue;
        }
        if (typeflag === "L") {
            nextLongName = body.toString("utf8").replace(/\0+$/, "");
            offset = padded;
            continue;
        }
        if (typeflag === "K") {
            offset = padded;
            continue;
        }
        if (typeflag === "1" || typeflag === "2" || typeflag === "3" || typeflag === "4" || typeflag === "6") {
            throw new TarError(`unsupported entry type "${typeflag}" for ${name}`);
        }
        if (typeflag === "S") throw new TarError(`sparse entries are not supported (${name})`);

        if (nextLongName !== undefined) name = nextLongName;
        const paxPath = nextPax?.get("path");
        if (paxPath !== undefined) name = paxPath;
        const fullPath = joinPath(prefix, name);
        nextPax = undefined;
        nextLongName = undefined;

        const isDirectory = typeflag === "5" || fullPath.endsWith("/");
        const clean = normalize(fullPath).replace(/^\.\//, "").replace(/\/+$/, "");
        if (clean === "" || clean === ".") {
            offset = padded;
            continue;
        }
        entries.push({
            path: clean,
            type: isDirectory ? "directory" : "file",
            mode: mode === 0 ? (isDirectory ? 0o755 : 0o644) : mode,
            mtime,
            data: isDirectory ? Buffer.alloc(0) : Buffer.from(body),
        });
        offset = padded;
    }
    return entries;
}

/** Reject absolute paths and `..` segments — an archive must not escape `root`. */
export function safeEntryPath(root: string, entryPath: string): string {
    if (isAbsolute(entryPath)) throw new TarError(`absolute path in archive: ${entryPath}`);
    const segments = entryPath.split("/");
    if (segments.some((segment) => segment === "..")) {
        throw new TarError(`path traversal in archive: ${entryPath}`);
    }
    const target = normalize(join(root, entryPath));
    const prefix = root.endsWith(sep) ? root : root + sep;
    if (target !== root && !target.startsWith(prefix)) {
        throw new TarError(`entry escapes the destination: ${entryPath}`);
    }
    return target;
}

/**
 * Extract a `.tar.gz` into `destDir` (created if missing) and return the
 * entries that were written, in archive order.
 */
export function extractTarGz(archive: Uint8Array, destDir: string): TarEntry[] {
    const entries = parseTar(gunzipSync(archive));
    mkdirSync(destDir, { recursive: true });
    for (const entry of entries) {
        const target = safeEntryPath(destDir, entry.path);
        if (entry.type === "directory") {
            mkdirSync(target, { recursive: true });
            continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, entry.data);
        chmodSync(target, entry.mode & 0o777);
    }
    return entries;
}
