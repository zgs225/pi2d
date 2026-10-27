import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    capacityBytes,
    encodeQr,
    fitsQr,
    MAX_VERSION,
    MIN_VERSION,
    versionSpecs,
} from "../../src/core/qr.js";

/** Render `rows` as a scaled PBM so an external decoder can read it back. */
function toPbm(rows: string[], scale = 5, quiet = 4): string {
    const size = rows.length;
    const total = (size + quiet * 2) * scale;
    const out: string[] = ["P1", `${total} ${total}`];
    for (let y = 0; y < total; y += 1) {
        const row = rows[Math.floor(y / scale) - quiet];
        const cells: string[] = [];
        for (let x = 0; x < total; x += 1) {
            const col = Math.floor(x / scale) - quiet;
            cells.push(row !== undefined && col >= 0 && col < size && row[col] === "1" ? "1" : "0");
        }
        out.push(cells.join(" "));
    }
    return `${out.join("\n")}\n`;
}

function decoder<T>(command: string, args: string[], input?: string): T | undefined {
    try {
        const result = spawnSync(command, args, { encoding: "utf8", input, timeout: 5_000 });
        return result.status === 0 ? (result.stdout as T) : undefined;
    } catch {
        return undefined;
    }
}

const hasImageToolchain = (): boolean => {
    const dir = mkdtempSync(join(tmpdir(), "pi2-qr-"));
    try {
        writeFileSync(join(dir, "probe.pbm"), "P1\n1 1\n0\n");
        return (
            decoder<string>("magick", [join(dir, "probe.pbm"), join(dir, "probe.png")]) !== undefined &&
            decoder<number>("zbarimg", ["--version"]) !== undefined
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

describe("qr encoder", () => {
    it("keeps every version table internally consistent", () => {
        for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
            const spec = versionSpecs()[version];
            expect(spec, `version ${version}`).toBeDefined();
            const data = spec!.groups.reduce((total, group) => total + group.count * group.dataCodewords, 0);
            const blocks = spec!.groups.reduce((total, group) => total + group.count, 0);
            expect(data + blocks * spec!.ecCodewordsPerBlock, `version ${version} codewords`).toBe(spec!.totalCodewords);
        }
    });

    it("shapes the symbol and only reports dark/light modules", () => {
        const qr = encodeQr("http://192.168.2.10:7676/pair/ABCD2345");
        expect(qr.ecc).toBe("M");
        expect(qr.size).toBe(qr.version * 4 + 17);
        expect(qr.rows).toHaveLength(qr.size);
        for (const row of qr.rows) {
            expect(row).toHaveLength(qr.size);
            expect(row).toMatch(/^[01]+$/);
        }
        expect(qr.mask).toBeGreaterThanOrEqual(0);
        expect(qr.mask).toBeLessThanOrEqual(7);
    });

    it("grows the version only when the previous one no longer fits", () => {
        for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
            expect(encodeQr("a".repeat(capacityBytes(version))).version).toBe(version);
            if (version < MAX_VERSION) {
                expect(encodeQr("a".repeat(capacityBytes(version) + 1)).version).toBeGreaterThan(version);
            }
        }
        expect(encodeQr("a".repeat(capacityBytes(MAX_VERSION))).version).toBe(MAX_VERSION);
    });

    it("refuses payloads beyond the largest symbol", () => {
        const tooBig = "a".repeat(capacityBytes(MAX_VERSION) + 1);
        expect(fitsQr(tooBig)).toBe(false);
        expect(() => encodeQr(tooBig)).toThrow(/do not fit/);
        expect(fitsQr("a".repeat(capacityBytes(MAX_VERSION)))).toBe(true);
    });

    it("measures capacity in UTF-8 bytes, not characters", () => {
        expect(fitsQr("扫一扫配对")).toBe(true);
        // 6 characters, 18 UTF-8 bytes: too wide for a version-1 symbol (14 bytes).
        expect(encodeQr("扫一扫配对").version).toBe(2);
        expect(encodeQr("扫码").version).toBe(1);
        // Three bytes per character: the version has to account for the encoding.
        expect(encodeQr("扫".repeat(capacityBytes(1))).version).toBeGreaterThan(1);
    });

    it("honours forced version and mask overrides", () => {
        expect(encodeQr("hello", { version: 5 }).version).toBe(5);
        for (let mask = 0; mask <= 7; mask += 1) {
            expect(encodeQr("hello", { mask }).mask).toBe(mask);
        }
        expect(() => encodeQr("hello", { version: 0 })).toThrow(/version/);
        expect(() => encodeQr("hello", { mask: 8 })).toThrow(/mask/);
    });

    it("is deterministic", () => {
        const first = encodeQr("https://myhost.tail1234.ts.net/pair/ZZZZ9999");
        const second = encodeQr("https://myhost.tail1234.ts.net/pair/ZZZZ9999");
        expect(second).toEqual(first);
    });

    it("matches the recorded matrices (decoded with zbarimg when the change landed)", () => {
        // The hashes pin the whole symbol — data, EC, interleaving, mask choice
        // and format/version bits. Each one was round-tripped through
        // `magick` + `zbarimg` before being written down.
        const golden = [
            {
                text: "pi2 pairing",
                version: 1,
                mask: 2,
                sha: "96c5668a81f06621d3db59a1d33b703a6d1c4f7ff51db8ae61a9f84f8c13821c",
            },
            {
                text: "http://192.168.2.10:7676/pair/ABCD2345",
                version: 3,
                mask: 4,
                sha: "709a345cb1f9efaf69c839aea177da472921a8a964d27220076e9924d28f11fc",
            },
            {
                text: "https://myhost.tail1234.ts.net/pair/ZZZZ9999",
                version: 4,
                mask: 4,
                sha: "5b42b9ac0c90756e0db86c4941538ebe49809b5319299fb098813d219d627798",
            },
        ];
        for (const expected of golden) {
            const qr = encodeQr(expected.text);
            expect(qr.version, expected.text).toBe(expected.version);
            expect(qr.mask, expected.text).toBe(expected.mask);
            expect(createHash("sha256").update(qr.rows.join("\n")).digest("hex"), expected.text).toBe(expected.sha);
        }
    });

    it.skipIf(!hasImageToolchain())("round-trips through a real decoder", () => {
        const dir = mkdtempSync(join(tmpdir(), "pi2-qr-"));
        try {
            const payloads = [
                "http://192.168.2.10:7676/pair/ABCD2345",
                "https://myhost.tail1234.ts.net/pair/ZZZZ9999",
                "扫一扫配对：pi2",
                "x".repeat(capacityBytes(10)),
            ];
            for (const [index, payload] of payloads.entries()) {
                writeFileSync(join(dir, "qr.pbm"), toPbm(encodeQr(payload).rows));
                expect(decoder<string>("magick", [join(dir, "qr.pbm"), join(dir, `qr-${index}.png`)]), "render").toBeDefined();
                const decoded = decoder<string>("zbarimg", ["--raw", "-q", join(dir, `qr-${index}.png`)]).replace(/\n$/, "");
                expect(decoded, payload).toBe(payload);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
