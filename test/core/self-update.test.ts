import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    applyVersionedInstall,
    buildReceipt,
    currentVersion,
    pruneVersions,
    readReceipt,
    receiptPath,
    removeStaleStaging,
    stagingDir,
    switchCurrent,
    versionOfBinary,
    writeReceiptAtomic,
} from "../../src/core/self-update.js";

let dirs: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi2-selfupdate-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
});

/** `<prefix>/versions/<version>/{bin,share,LICENSE}` + `current`, like install.sh writes it. */
function makeInstall(prefix: string, version: string): { bin: string; versionDir: string } {
    const versionDir = join(prefix, "versions", version);
    mkdirSync(join(versionDir, "bin"), { recursive: true });
    mkdirSync(join(versionDir, "share", "pi2d", "web", "dist"), { recursive: true });
    const bin = join(versionDir, "bin", "pi2");
    writeFileSync(bin, `#!/bin/sh\necho "pi2 ${version}"\n`, { mode: 0o755 });
    writeFileSync(join(versionDir, "share", "pi2d", "web", "dist", "index.html"), "<html></html>\n");
    writeFileSync(join(versionDir, "LICENSE"), "MIT\n");
    return { bin, versionDir };
}

function stagingTree(prefix: string, label: string): string {
    const dir = stagingDir(prefix, label);
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "share", "pi2d", "web", "dist"), { recursive: true });
    writeFileSync(join(dir, "bin", "pi2"), "#!/bin/sh\necho new\n", { mode: 0o755 });
    writeFileSync(join(dir, "share", "pi2d", "web", "dist", "index.html"), "<html>new</html>\n");
    return dir;
}

describe("receipt", () => {
    it("round-trips through the atomic writer", () => {
        const prefix = tmp();
        const receipt = buildReceipt({
            prefix,
            version: "0.1.7",
            bin: join(prefix, "versions", "0.1.7", "bin", "pi2"),
            asset: "pi2d-0.1.7-linux-x64.tar.gz",
            sha256: "a".repeat(64),
            now: new Date("2026-10-29T08:00:00Z"),
        });
        writeReceiptAtomic(prefix, receipt);
        const read = readReceipt(prefix);
        expect(read.error).toBeUndefined();
        expect(read.receipt).toEqual({
            ...receipt,
            installed_at: "2026-10-29T08:00:00Z",
        });
        expect(existsSync(receiptPath(prefix))).toBe(true);
        // Written through a temp file, so no residue is left next to it.
        expect(readdirSync(prefix).filter((entry) => entry.includes(".tmp."))).toEqual([]);
    });

    it("reports a missing receipt instead of throwing", () => {
        expect(readReceipt(tmp()).error).toMatch(/no install receipt/);
    });

    it("reports invalid JSON and unknown shapes", () => {
        const prefix = tmp();
        writeFileSync(receiptPath(prefix), "{not json");
        expect(readReceipt(prefix).error).toMatch(/not valid JSON/);
        writeFileSync(receiptPath(prefix), JSON.stringify({ schema: 1, version: "0.1.7" }));
        expect(readReceipt(prefix).error).toMatch(/missing prefix\/version\/bin/);
    });

    it("refuses a receipt written by a newer schema", () => {
        const prefix = tmp();
        writeFileSync(
            receiptPath(prefix),
            JSON.stringify({ schema: 99, prefix, version: "0.1.7", bin: join(prefix, "bin", "pi2") }),
        );
        expect(readReceipt(prefix).error).toMatch(/newer pi2/);
    });

    it("defaults fields a hand-written receipt may omit", () => {
        const prefix = tmp();
        writeFileSync(
            receiptPath(prefix),
            JSON.stringify({ prefix, version: "0.1.7", bin: join(prefix, "bin", "pi2") }),
        );
        const receipt = readReceipt(prefix).receipt;
        expect(receipt?.schema).toBe(1);
        expect(receipt?.installer).toBe("unknown");
        expect(receipt?.layout).toBe("versioned");
        expect(receipt?.current).toBe(join(prefix, "current"));
    });
});

describe("current symlink", () => {
    it("switches atomically and reads back", () => {
        const prefix = tmp();
        makeInstall(prefix, "0.1.6");
        makeInstall(prefix, "0.1.7");
        switchCurrent(prefix, "versions/0.1.6");
        expect(currentVersion(prefix)).toBe("0.1.6");
        switchCurrent(prefix, "versions/0.1.7");
        expect(currentVersion(prefix)).toBe("0.1.7");
        expect(readlinkSync(join(prefix, "current"))).toBe("versions/0.1.7");
        // No temp symlink left behind.
        expect(existsSync(join(prefix, `.current.${process.pid}`))).toBe(false);
    });

    it("ignores a current that points somewhere else", () => {
        const prefix = tmp();
        symlinkSync("/somewhere/else", join(prefix, "current"));
        expect(currentVersion(prefix)).toBeUndefined();
    });
});

describe("applyVersionedInstall", () => {
    it("installs a tree, switches current, writes the receipt and prunes", () => {
        const prefix = tmp();
        const previous = makeInstall(prefix, "0.1.6");
        writeReceiptAtomic(
            prefix,
            buildReceipt({ prefix, version: "0.1.6", bin: previous.bin }),
        );
        switchCurrent(prefix, "versions/0.1.6");

        const staged = stagingTree(prefix, "test");
        const applied = applyVersionedInstall({
            prefix,
            version: "0.1.7",
            stagedDir: staged,
            asset: "pi2d-0.1.7-linux-x64.tar.gz",
            sha256: "b".repeat(64),
            now: new Date("2026-10-29T09:00:00Z"),
        });

        expect(applied.previous).toBe("0.1.6");
        expect(currentVersion(prefix)).toBe("0.1.7");
        expect(readFileSync(join(prefix, "versions", "0.1.7", "bin", "pi2"), "utf8")).toContain("echo new");
        expect(existsSync(staged)).toBe(false);
        const receipt = readReceipt(prefix).receipt;
        expect(receipt?.version).toBe("0.1.7");
        expect(receipt?.sha256).toBe("b".repeat(64));
        expect(receipt?.asset).toBe("pi2d-0.1.7-linux-x64.tar.gz");
        // current + one previous survive.
        expect(existsSync(join(prefix, "versions", "0.1.6"))).toBe(true);
    });

    it("replaces a tree when the same version is reinstalled", () => {
        const prefix = tmp();
        makeInstall(prefix, "0.1.7");
        switchCurrent(prefix, "versions/0.1.7");
        const staged = stagingTree(prefix, "reinstall");
        const applied = applyVersionedInstall({ prefix, version: "0.1.7", stagedDir: staged });
        expect(applied.previous).toBe("0.1.7");
        expect(readFileSync(join(prefix, "versions", "0.1.7", "bin", "pi2"), "utf8")).toContain("echo new");
    });

    it("rolls back the symlink and the tree when the swap fails", () => {
        const prefix = tmp();
        const previous = makeInstall(prefix, "0.1.6");
        writeReceiptAtomic(prefix, buildReceipt({ prefix, version: "0.1.6", bin: previous.bin }));
        switchCurrent(prefix, "versions/0.1.6");

        expect(() =>
            applyVersionedInstall({
                prefix,
                version: "0.1.7",
                stagedDir: join(prefix, "versions", "does-not-exist"),
            }),
        ).toThrow();

        expect(currentVersion(prefix)).toBe("0.1.6");
        expect(existsSync(join(prefix, "versions", "0.1.7"))).toBe(false);
        expect(readReceipt(prefix).receipt?.version).toBe("0.1.6");
        expect(readFileSync(previous.bin, "utf8")).toContain("pi2 0.1.6");
    });

    it("prunes every tree except current and previous", () => {
        const prefix = tmp();
        for (const version of ["0.1.4", "0.1.5", "0.1.6"]) makeInstall(prefix, version);
        mkdirSync(join(prefix, "versions", ".staging-leftover"), { recursive: true });
        const removed = pruneVersions(prefix, ["0.1.6", "0.1.5"]);
        expect(removed).toEqual(["0.1.4"]);
        expect(existsSync(join(prefix, "versions", "0.1.4"))).toBe(false);
        expect(existsSync(join(prefix, "versions", "0.1.6"))).toBe(true);
        // Dot entries are staging, cleaned separately.
        expect(existsSync(join(prefix, "versions", ".staging-leftover"))).toBe(true);
        expect(removeStaleStaging(prefix)).toEqual([".staging-leftover"]);
    });
});

describe("versionOfBinary", () => {
    it("recognises the versioned layout", () => {
        expect(versionOfBinary("/home/u/.local/lib/pi2d/versions/0.1.7/bin/pi2")).toBe("0.1.7");
        expect(versionOfBinary("/usr/bin/pi2")).toBeUndefined();
    });
});
