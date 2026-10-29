import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { extractTarGz, parseTar, safeEntryPath, TarError } from "../../src/core/tarball.js";
import { buildReleaseArchive, buildTar, buildTarGz } from "./tar-fixture.js";

let dirs: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi2-tar-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
});

describe("parseTar", () => {
    it("reads a release asset: names, sizes, modes", () => {
        const entries = parseTar(gunzipSync(buildReleaseArchive()));
        const paths = entries.map((entry) => entry.path);
        expect(paths).toContain("bin/pi2");
        expect(paths).toContain("share/pi2d/web/dist/index.html");
        expect(paths).toContain("LICENSE");
        const bin = entries.find((entry) => entry.path === "bin/pi2");
        expect(bin?.type).toBe("file");
        expect(bin?.mode & 0o777).toBe(0o755);
        expect(bin?.data.toString("utf8")).toContain("pi2 0.1.7");
        expect(entries.find((entry) => entry.path === "share")?.type).toBe("directory");
    });

    it("rejects a corrupted header checksum", () => {
        const archive = gunzipSync(buildReleaseArchive());
        // Flip a byte inside the first header's name field.
        archive[3] = (archive[3] ?? 0) ^ 0xff;
        expect(() => parseTar(archive)).toThrow(TarError);
    });

    it("refuses symlink entries instead of skipping them", () => {
        const archive = buildTar([{ name: "bin/pi2", data: "x", type: "symlink" }]);
        expect(() => parseTar(archive)).toThrow(/unsupported entry type/);
    });
});

describe("extractTarGz", () => {
    it("writes the tree, keeping the executable bit", () => {
        const dest = join(tmp(), "tree");
        extractTarGz(buildReleaseArchive("0.1.8"), dest);
        expect(readFileSync(join(dest, "LICENSE"), "utf8")).toBe("MIT\n");
        expect(statSync(join(dest, "bin", "pi2")).mode & 0o777).toBe(0o755);
        expect(readFileSync(join(dest, "share", "pi2d", "web", "dist", "index.html"), "utf8")).toContain("<html>");
    });

    it("rejects a path traversal", () => {
        const dest = join(tmp(), "tree");
        expect(() => extractTarGz(buildTarGz([{ name: "../../etc/passwd", data: "x" }]), dest)).toThrow(
            /path traversal/,
        );
    });

    it("rejects an absolute path", () => {
        const dest = join(tmp(), "tree");
        expect(() => extractTarGz(buildTarGz([{ name: "/etc/passwd", data: "x" }]), dest)).toThrow(
            /absolute path/,
        );
    });
});

describe("safeEntryPath", () => {
    it("keeps nested entries under the destination", () => {
        expect(safeEntryPath("/tmp/x", "a/b/c")).toBe("/tmp/x/a/b/c");
    });

    it("rejects escapes", () => {
        expect(() => safeEntryPath("/tmp/x", "../y")).toThrow(TarError);
    });
});
