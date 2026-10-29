/**
 * Tiny ustar writer for the update tests — the real artifacts come from
 * `tar -czf` in `scripts/build-binary.sh`, and `src/core/tarball.ts` has to read
 * that shape without a `tar` subprocess.
 */
import { gzipSync } from "node:zlib";

export interface FixtureEntry {
    name: string;
    data?: string;
    mode?: number;
    type?: "file" | "directory" | "symlink";
}

const BLOCK = 512;

function octal(value: number, length: number): string {
    const text = value.toString(8);
    return "0".repeat(Math.max(0, length - 1 - text.length)) + text + "\0";
}

function header(entry: FixtureEntry): Buffer {
    const buffer = Buffer.alloc(BLOCK);
    const typeflag = entry.type === "directory" ? "5" : entry.type === "symlink" ? "2" : "0";
    const data = Buffer.from(entry.data ?? "", "utf8");
    buffer.write(entry.name, 0, 100, "utf8");
    buffer.write(octal(entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644), 8), 100, 8, "ascii");
    buffer.write(octal(0, 8), 108, 8, "ascii");
    buffer.write(octal(0, 8), 116, 8, "ascii");
    buffer.write(octal(entry.type === "directory" ? 0 : data.length, 12), 124, 12, "ascii");
    buffer.write(octal(1_700_000_000, 12), 136, 12, "ascii");
    buffer.write("        ", 148, 8, "ascii");
    buffer.write(typeflag, 156, 1, "ascii");
    buffer.write("ustar\0", 257, 6, "ascii");
    buffer.write("00", 263, 2, "ascii");
    let sum = 0;
    for (const byte of buffer) sum += byte;
    buffer.write(`${octal(sum, 7)} `, 148, 8, "ascii");
    return buffer;
}

export function buildTar(entries: FixtureEntry[]): Buffer {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
        blocks.push(header(entry));
        if (entry.type === "directory" || entry.type === "symlink") continue;
        const data = Buffer.from(entry.data ?? "", "utf8");
        const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
        blocks.push(data, Buffer.alloc(pad));
    }
    blocks.push(Buffer.alloc(BLOCK * 2));
    return Buffer.concat(blocks);
}

export function buildTarGz(entries: FixtureEntry[]): Buffer {
    return gzipSync(buildTar(entries));
}

/** The two trees `scripts/build-binary.sh` ships in a release asset. */
export function buildReleaseArchive(version = "0.1.7"): Buffer {
    return buildTarGz([
        { name: "bin/", type: "directory" },
        { name: "bin/pi2", data: `#!/bin/sh\necho "pi2 ${version}"\n`, mode: 0o755 },
        { name: "share/", type: "directory" },
        { name: "share/pi2d/", type: "directory" },
        { name: "share/pi2d/web/", type: "directory" },
        { name: "share/pi2d/web/dist/", type: "directory" },
        { name: "share/pi2d/web/dist/index.html", data: "<html></html>\n" },
        { name: "LICENSE", data: "MIT\n" },
    ]);
}
