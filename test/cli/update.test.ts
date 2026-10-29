import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReceipt, readReceipt, receiptPath, writeReceiptAtomic } from "../../src/core/self-update.js";
import { sha256Hex } from "../../src/core/release.js";
import {
    parseUpdateArgs,
    resolveInstall,
    runUpdate,
    type ExecResult,
    type UpdateDeps,
} from "../../src/cli/update.js";
import { UsageError } from "../../src/cli/util.js";
import { buildReleaseArchive } from "../core/tar-fixture.js";

let dirs: string[] = [];

function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi2-update-"));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
});

interface Install {
    root: string;
    prefix: string;
    bin: string;
    installer?: string;
}

/** A curl-channel install: `<prefix>/versions/<v>/…` + `current` + the receipt. */
function makeInstall(version: string, installer = "curl"): Install {
    const root = tmp();
    const prefix = join(root, "prefix");
    const versionDir = join(prefix, "versions", version);
    mkdirSync(join(versionDir, "bin"), { recursive: true });
    mkdirSync(join(versionDir, "share", "pi2d", "web", "dist"), { recursive: true });
    const bin = join(versionDir, "bin", "pi2");
    writeFileSync(bin, `#!/bin/sh\necho "pi2 ${version}"\n`, { mode: 0o755 });
    writeFileSync(join(versionDir, "share", "pi2d", "web", "dist", "index.html"), "<html></html>\n");
    writeFileSync(receiptPath(prefix), "");
    writeReceiptAtomic(prefix, buildReceipt({ prefix, version, bin, installer }));
    symlinkSync(`versions/${version}`, join(prefix, "current"));
    return { root, prefix, bin, installer };
}

function releaseFetch(version: string, options: { sums?: string; archive?: Buffer; apiStatus?: number } = {}) {
    const archive = options.archive ?? buildReleaseArchive(version);
    const asset = `pi2d-${version}-linux-x64.tar.gz`;
    const sums = options.sums ?? `${sha256Hex(archive)}  ${asset}\n`;
    return (async (input: unknown) => {
        const url = String(input);
        if (url.includes("api.github.com")) {
            return new Response(JSON.stringify({ tag_name: `v${version}` }), {
                status: options.apiStatus ?? 200,
                headers: { etag: '"etag-1"' },
            });
        }
        if (url.endsWith("/SHA256SUMS")) return new Response(sums);
        if (url.endsWith(asset)) return new Response(archive);
        return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
}

function fakeExec(options: { version?: string; gh?: boolean; attestation?: number } = {}) {
    const calls: string[][] = [];
    const exec = (argv: readonly string[]): ExecResult => {
        calls.push([...argv]);
        if (argv[0] === "gh") {
            if (argv[1] === "--version") {
                return options.gh === false
                    ? { code: 127, stdout: "", stderr: "gh: command not found" }
                    : { code: 0, stdout: "gh version 2.63.0 (2026-01-01)\n", stderr: "" };
            }
            return { code: options.attestation ?? 0, stdout: "Verified\n", stderr: options.attestation === 0 ? "" : "no attestation" };
        }
        const version = options.version ?? "0.1.7";
        return { code: 0, stdout: `pi2 ${version}\n`, stderr: "" };
    };
    return { exec, calls };
}

function deps(install: Install, fetchImpl: typeof fetch, exec: UpdateDeps["exec"]): UpdateDeps {
    return {
        fetchImpl,
        exec,
        execPath: install.bin,
        isBundled: () => true,
        currentVersion: "0.1.6",
        env: {},
        stateDirPath: join(install.root, "state"),
        print: () => {},
        warn: () => {},
    };
}

describe("parseUpdateArgs", () => {
    it("defaults to a plain update", () => {
        expect(parseUpdateArgs([])).toEqual({
            check: false,
            dryRun: false,
            force: false,
            json: false,
            requireAttestation: false,
            skipAttestation: false,
            help: false,
        });
    });

    it("normalises a pinned version and reads the modes", () => {
        const parsed = parseUpdateArgs(["--check", "--version", "v0.1.7", "--json"]);
        expect(parsed.check).toBe(true);
        expect(parsed.version).toBe("0.1.7");
        expect(parsed.json).toBe(true);
    });

    it("rejects unknown flags and positionals with the update usage", () => {
        expect(() => parseUpdateArgs(["--nope"])).toThrow(UsageError);
        try {
            parseUpdateArgs(["0.1.7"]);
        } catch (error) {
            expect((error as UsageError).usage).toContain("pi2 update");
        }
    });
});

describe("resolveInstall", () => {
    it("refuses an npm/Node run with the npm command", () => {
        expect(() => resolveInstall("/usr/bin/pi2", false)).toThrow(/npm i -g @yuez\/pi2d/);
    });

    it("refuses the flat layout and points at the installer", () => {
        expect(() => resolveInstall("/tmp/pi2d/bin/pi2", true)).toThrow(/re-run the installer/);
    });

    it("refuses a missing receipt", () => {
        const root = tmp();
        const prefix = join(root, "prefix");
        const bin = join(prefix, "versions", "0.1.6", "bin", "pi2");
        mkdirSync(join(prefix, "versions", "0.1.6", "bin"), { recursive: true });
        writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
        expect(() => resolveInstall(bin, true)).toThrow(/no install receipt/);
    });

    it("refuses a Homebrew-owned tree with the brew command", () => {
        const install = makeInstall("0.1.6", "brew");
        expect(() => resolveInstall(install.bin, true)).toThrow(/brew upgrade pi2d/);
    });

    it("refuses when the receipt describes another binary", () => {
        const install = makeInstall("0.1.6");
        const other = join(install.prefix, "versions", "0.1.6", "bin", "pi2-other");
        writeFileSync(other, "#!/bin/sh\n", { mode: 0o755 });
        writeReceiptAtomic(
            install.prefix,
            buildReceipt({ prefix: install.prefix, version: "0.1.6", bin: other }),
        );
        expect(() => resolveInstall(install.bin, true)).toThrow(/another copy of pi2/);
    });

    it("accepts a curl-channel install and returns its receipt", () => {
        const install = makeInstall("0.1.6");
        expect(resolveInstall(install.bin, true).receipt.installer).toBe("curl");
    });
});

describe("runUpdate", () => {
    it("--check reports the newer version without downloading", async () => {
        const install = makeInstall("0.1.6");
        const lines: string[] = [];
        const code = await runUpdate({
            argv: ["--check", "--json"],
            ...deps(install, releaseFetch("0.1.7"), fakeExec().exec),
            print: (line) => lines.push(line),
        });
        expect(code).toBe(0);
        const result = JSON.parse(lines.join("\n")) as { action: string; latest: string; updatable: boolean };
        expect(result.action).toBe("checked");
        expect(result.latest).toBe("0.1.7");
        expect(result.updatable).toBe(true);
        expect(readlinkSync(join(install.prefix, "current"))).toBe("versions/0.1.6");
    });

    it("reports up-to-date without --force", async () => {
        const install = makeInstall("0.1.6");
        const lines: string[] = [];
        await runUpdate({
            argv: ["--json"],
            ...deps(install, releaseFetch("0.1.6"), fakeExec().exec),
            currentVersion: "0.1.6",
            print: (line) => lines.push(line),
        });
        expect(JSON.parse(lines.join("\n")).action).toBe("up-to-date");
    });

    it("refuses a downgrade unless --force is passed", async () => {
        const install = makeInstall("0.1.6");
        await expect(
            runUpdate({ argv: ["--version", "0.1.5"], ...deps(install, releaseFetch("0.1.5"), fakeExec().exec) }),
        ).rejects.toThrow(/refusing to downgrade/);
    });

    it("--dry-run changes nothing", async () => {
        const install = makeInstall("0.1.6");
        const before = readReceipt(install.prefix).receipt;
        const lines: string[] = [];
        await runUpdate({
            argv: ["--dry-run"],
            ...deps(install, releaseFetch("0.1.7"), fakeExec().exec),
            print: (line) => lines.push(line),
        });
        expect(lines.join("\n")).toContain("would install pi2 0.1.7");
        expect(readReceipt(install.prefix).receipt).toEqual(before);
        expect(readlinkSync(join(install.prefix, "current"))).toBe("versions/0.1.6");
        expect(existsSync(join(install.prefix, "versions", "0.1.7"))).toBe(false);
    });

    it("installs, verifies provenance, smoke-tests and switches current", async () => {
        const install = makeInstall("0.1.6");
        const fake = fakeExec({ version: "0.1.7" });
        const lines: string[] = [];
        const code = await runUpdate({
            argv: ["--json"],
            ...deps(install, releaseFetch("0.1.7"), fake.exec),
            print: (line) => lines.push(line),
        });
        expect(code).toBe(0);
        const result = JSON.parse(lines.join("\n")) as {
            action: string;
            attestation: string;
            previous: string;
            latest: string;
            restart: string;
        };
        expect(result.action).toBe("installed");
        expect(result.attestation).toBe("verified");
        expect(result.previous).toBe("0.1.6");
        expect(result.latest).toBe("0.1.7");
        expect(result.restart).toContain("pi2");

        expect(readlinkSync(join(install.prefix, "current"))).toBe("versions/0.1.7");
        expect(existsSync(join(install.prefix, "versions", "0.1.6"))).toBe(true);
        expect(readFileSync(join(install.prefix, "versions", "0.1.7", "bin", "pi2"), "utf8")).toContain("pi2 0.1.7");
        const receipt = readReceipt(install.prefix).receipt;
        expect(receipt?.version).toBe("0.1.7");
        expect(receipt?.sha256).toHaveLength(64);
        expect(receipt?.asset).toBe("pi2d-0.1.7-linux-x64.tar.gz");
        // The staged binary was executed before the swap.
        expect(fake.calls.some((argv) => argv[1] === "--version" && argv[0].includes(".staging-"))).toBe(true);
        // No staging residue.
        expect(existsSync(join(install.prefix, "versions", ".staging-update"))).toBe(false);
    });

    it("fails on a checksum mismatch and leaves the install alone", async () => {
        const install = makeInstall("0.1.6");
        const archive = buildReleaseArchive("0.1.7");
        const sums = `${"c".repeat(64)}  pi2d-0.1.7-linux-x64.tar.gz\n`;
        await expect(
            runUpdate({ argv: [], ...deps(install, releaseFetch("0.1.7", { sums, archive }), fakeExec().exec) }),
        ).rejects.toThrow(/checksum mismatch/);
        expect(readlinkSync(join(install.prefix, "current"))).toBe("versions/0.1.6");
        expect(existsSync(join(install.prefix, "versions", "0.1.7"))).toBe(false);
    });

    it("fails when the release does not publish this platform", async () => {
        const install = makeInstall("0.1.6");
        const sums = `${"d".repeat(64)}  pi2d-0.1.7-darwin-arm64.tar.gz\n`;
        await expect(
            runUpdate({ argv: [], ...deps(install, releaseFetch("0.1.7", { sums }), fakeExec().exec) }),
        ).rejects.toThrow(/has no entry for pi2d-0\.1\.7-linux-x64\.tar\.gz/);
    });

    it("warns but continues when provenance cannot be verified", async () => {
        const install = makeInstall("0.1.6");
        const warnings: string[] = [];
        const fake = fakeExec({ attestation: 1 });
        const lines: string[] = [];
        await runUpdate({
            argv: ["--json"],
            ...deps(install, releaseFetch("0.1.7"), fake.exec),
            warn: (line) => warnings.push(line),
            print: (line) => lines.push(line),
        });
        expect(warnings.join("\n")).toContain("provenance");
        expect(JSON.parse(lines.join("\n")).attestation).toBe("failed");
        expect(readlinkSync(join(install.prefix, "current"))).toBe("versions/0.1.7");
    });

    it("--require-attestation fails when gh is missing", async () => {
        const install = makeInstall("0.1.6");
        const fake = fakeExec({ gh: false });
        await expect(
            runUpdate({
                argv: ["--require-attestation"],
                ...deps(install, releaseFetch("0.1.7"), fake.exec),
            }),
        ).rejects.toThrow(/gh` is not installed/);
        expect(readlinkSync(join(install.prefix, "current"))).toBe("versions/0.1.6");
    });

    it("--skip-attestation never calls gh", async () => {
        const install = makeInstall("0.1.6");
        const fake = fakeExec();
        const lines: string[] = [];
        await runUpdate({
            argv: ["--skip-attestation", "--json"],
            ...deps(install, releaseFetch("0.1.7"), fake.exec),
            print: (line) => lines.push(line),
        });
        expect(fake.calls.some((argv) => argv[0] === "gh")).toBe(false);
        expect(JSON.parse(lines.join("\n")).attestation).toBe("skipped");
    });

    it("rejects an asset whose binary reports another version", async () => {
        const install = makeInstall("0.1.6");
        const fake = fakeExec({ version: "0.1.5" });
        await expect(
            runUpdate({ argv: [], ...deps(install, releaseFetch("0.1.7"), fake.exec) }),
        ).rejects.toThrow(/reports 0\.1\.5, expected 0\.1\.7/);
        expect(readlinkSync(join(install.prefix, "current"))).toBe("versions/0.1.6");
    });

    it("--version pins the asset without asking the API", async () => {
        const install = makeInstall("0.1.6");
        let apiCalls = 0;
        const fetchImpl = (async (input: unknown) => {
            const url = String(input);
            if (url.includes("api.github.com")) {
                apiCalls += 1;
                return new Response("{}", { status: 500 });
            }
            const archive = buildReleaseArchive("0.1.7");
            if (url.endsWith("/SHA256SUMS")) {
                return new Response(`${sha256Hex(archive)}  pi2d-0.1.7-linux-x64.tar.gz\n`);
            }
            return new Response(archive);
        }) as unknown as typeof fetch;
        await runUpdate({
            argv: ["--version", "0.1.7", "--skip-attestation"],
            ...deps(install, fetchImpl, fakeExec().exec),
        });
        expect(apiCalls).toBe(0);
        expect(readlinkSync(join(install.prefix, "current"))).toBe("versions/0.1.7");
    });
});
