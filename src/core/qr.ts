/**
 * Minimal QR Code encoder — byte mode, error-correction level M, versions 1–10.
 *
 * Why hand-rolled: `pi2 pairing` must be able to print something a phone camera
 * can scan, and the daemon keeps a deliberately tiny dependency set (`hono`,
 * `ws`, `zod`). A byte-mode-only encoder with a single EC level is ~300 lines
 * of tables and bit shuffling, and it is fully covered by `test/core/qr.test.ts`
 * (decoded with `zbarimg` when it is on `PATH`).
 *
 * Output is presentation-agnostic: `rows` is one string per module row, `1` for
 * a dark module and `0` for a light one, without a quiet zone — every renderer
 * (a Neovim float, a terminal, a canvas) adds its own margin and colors.
 *
 * Reference: ISO/IEC 18004; structure mirrors the well-known
 * `qrcode-generator` implementation (mask patterns, format/version placement).
 */

/** Error-correction level: M (15% recovery) is the screen-scanning sweet spot. */
export type QrEcc = "M";

export interface QrMatrix {
    /** QR version (1..10): the symbol is `4 * version + 17` modules wide. */
    version: number;
    ecc: QrEcc;
    /** Mask pattern (0..7) that produced the lowest penalty score. */
    mask: number;
    /** Module count per side (no quiet zone). */
    size: number;
    /** `size` rows of `size` characters: `1` = dark, `0` = light. */
    rows: string[];
}

export interface QrOptions {
    /** Force a version instead of picking the smallest one that fits. */
    version?: number;
    /** Force a mask (0..7) instead of choosing by penalty score. Debug/tests. */
    mask?: number;
}

export const MIN_VERSION = 1;
export const MAX_VERSION = 10;
export const ECC: QrEcc = "M";

/** ECC level bits used in the format information (M = 00). */
const ECC_FORMAT_BITS = 0b00;

interface BlockGroup {
    /** Number of identical blocks. */
    count: number;
    /** Data codewords per block. */
    dataCodewords: number;
}

interface VersionSpec {
    /** EC codewords appended to every block. */
    ecCodewordsPerBlock: number;
    groups: BlockGroup[];
    /** Total codewords (data + EC) the symbol carries. */
    totalCodewords: number;
}

/**
 * ECC-M block layout per version (ISO/IEC 18004 table 9). `totalCodewords`
 * checks out against `data + ec` for every row; `test/core/qr.test.ts` asserts
 * it so a typo cannot silently ship a mis-sized symbol.
 */
const VERSIONS: Record<number, VersionSpec> = {
    1: { ecCodewordsPerBlock: 10, groups: [{ count: 1, dataCodewords: 16 }], totalCodewords: 26 },
    2: { ecCodewordsPerBlock: 16, groups: [{ count: 1, dataCodewords: 28 }], totalCodewords: 44 },
    3: { ecCodewordsPerBlock: 26, groups: [{ count: 1, dataCodewords: 44 }], totalCodewords: 70 },
    4: { ecCodewordsPerBlock: 18, groups: [{ count: 2, dataCodewords: 32 }], totalCodewords: 100 },
    5: { ecCodewordsPerBlock: 24, groups: [{ count: 2, dataCodewords: 43 }], totalCodewords: 134 },
    6: { ecCodewordsPerBlock: 16, groups: [{ count: 4, dataCodewords: 27 }], totalCodewords: 172 },
    7: { ecCodewordsPerBlock: 18, groups: [{ count: 4, dataCodewords: 31 }], totalCodewords: 196 },
    8: {
        ecCodewordsPerBlock: 22,
        groups: [
            { count: 2, dataCodewords: 38 },
            { count: 2, dataCodewords: 39 },
        ],
        totalCodewords: 242,
    },
    9: {
        ecCodewordsPerBlock: 22,
        groups: [
            { count: 3, dataCodewords: 36 },
            { count: 2, dataCodewords: 37 },
        ],
        totalCodewords: 292,
    },
    10: {
        ecCodewordsPerBlock: 26,
        groups: [
            { count: 4, dataCodewords: 43 },
            { count: 1, dataCodewords: 44 },
        ],
        totalCodewords: 346,
    },
};

/** Alignment-pattern centre coordinates per version (0 length = none). */
const ALIGNMENT_CENTERS: Record<number, number[]> = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
};

/** Remainder bits after the last full codeword (version 1 and 7+ have none). */
const REMAINDER_BITS: Record<number, number> = {
    1: 0,
    2: 7,
    3: 7,
    4: 7,
    5: 7,
    6: 7,
    7: 0,
    8: 0,
    9: 0,
    10: 0,
};

const dataCodewords = (spec: VersionSpec): number =>
    spec.groups.reduce((total, group) => total + group.count * group.dataCodewords, 0);

/** Character-count indicator width for byte mode. */
const charCountBits = (version: number): number => (version <= 9 ? 8 : 16);

/* -------------------------------------------------------------------------- */
/* GF(256) arithmetic + Reed-Solomon                                          */
/* -------------------------------------------------------------------------- */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
    let value = 1;
    for (let i = 0; i < 255; i += 1) {
        GF_EXP[i] = value;
        GF_LOG[value] = i;
        value <<= 1;
        if ((value & 0x100) !== 0) value ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255] as number;
}

function gfMultiply(a: number, b: number): number {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[(GF_LOG[a] as number) + (GF_LOG[b] as number)] as number;
}

/** Generator polynomial of the requested degree, highest-order coefficient first. */
function rsGenerator(degree: number): number[] {
    let poly = [1];
    for (let i = 0; i < degree; i += 1) {
        const root = GF_EXP[i] as number;
        const next = new Array<number>(poly.length + 1).fill(0);
        next[0] = poly[0] as number;
        for (let j = 1; j < poly.length; j += 1) {
            next[j] = (poly[j] as number) ^ gfMultiply(root, poly[j - 1] as number);
        }
        next[poly.length] = gfMultiply(root, poly[poly.length - 1] as number);
        poly = next;
    }
    return poly;
}

/** EC codewords for one block, computed as the polynomial remainder. */
function rsEncode(data: number[], generator: number[]): number[] {
    const degree = generator.length - 1;
    const remainder = new Array<number>(degree).fill(0);
    for (const byte of data) {
        const factor = byte ^ (remainder[0] as number);
        remainder.shift();
        remainder.push(0);
        for (let i = 0; i < degree; i += 1) {
            remainder[i] = (remainder[i] as number) ^ gfMultiply(generator[i + 1] as number, factor);
        }
    }
    return remainder;
}

/* -------------------------------------------------------------------------- */
/* Bit stream + codewords                                                     */
/* -------------------------------------------------------------------------- */

function pushBits(bits: number[], value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

/** Smallest version whose data capacity holds `byteLength` bytes. */
function pickVersion(byteLength: number): number {
    for (let version = MIN_VERSION; version <= MAX_VERSION; version += 1) {
        const spec = VERSIONS[version] as VersionSpec;
        const capacityBits = dataCodewords(spec) * 8;
        const neededBits = 4 + charCountBits(version) + byteLength * 8;
        if (neededBits <= capacityBits) return version;
    }
    throw new RangeError(
        `qr: ${byteLength} bytes do not fit in a version-${MAX_VERSION} ECC-M symbol (max ${Math.floor(
            (dataCodewords(VERSIONS[MAX_VERSION] as VersionSpec) * 8 - 4 - charCountBits(MAX_VERSION)) / 8,
        )} bytes)`,
    );
}

/** Header + payload, terminator, byte padding, alternating 0xEC/0x11 fill. */
function buildDataCodewords(bytes: number[], version: number): number[] {
    const spec = VERSIONS[version] as VersionSpec;
    const capacityBits = dataCodewords(spec) * 8;
    const bits: number[] = [];
    pushBits(bits, 0b0100, 4); // byte mode
    pushBits(bits, bytes.length, charCountBits(version));
    for (const byte of bytes) pushBits(bits, byte, 8);

    pushBits(bits, 0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit += 1) byte = (byte << 1) | (bits[i + bit] as number);
        codewords.push(byte);
    }
    let pad = 0;
    while (codewords.length < dataCodewords(spec)) {
        codewords.push(pad % 2 === 0 ? 0xec : 0x11);
        pad += 1;
    }
    return codewords;
}

/** Split into blocks, append EC, then interleave (data first, then EC). */
function buildCodewordStream(bytes: number[], version: number): number[] {
    const spec = VERSIONS[version] as VersionSpec;
    const flat = buildDataCodewords(bytes, version);
    const generator = rsGenerator(spec.ecCodewordsPerBlock);

    const blocks: { data: number[]; ec: number[] }[] = [];
    let offset = 0;
    for (const group of spec.groups) {
        for (let i = 0; i < group.count; i += 1) {
            const data = flat.slice(offset, offset + group.dataCodewords);
            offset += group.dataCodewords;
            blocks.push({ data, ec: rsEncode(data, generator) });
        }
    }

    const longestData = Math.max(...blocks.map((block) => block.data.length));
    const stream: number[] = [];
    for (let i = 0; i < longestData; i += 1) {
        for (const block of blocks) {
            const value = block.data[i];
            if (value !== undefined) stream.push(value);
        }
    }
    for (let i = 0; i < spec.ecCodewordsPerBlock; i += 1) {
        for (const block of blocks) stream.push(block.ec[i] as number);
    }
    return stream;
}

/* -------------------------------------------------------------------------- */
/* Symbol construction                                                        */
/* -------------------------------------------------------------------------- */

type Grid = Int8Array[]; // -1 = unset, 0 = light, 1 = dark

const makeGrid = (size: number): Grid =>
    Array.from({ length: size }, () => new Int8Array(size).fill(-1));

const inBounds = (size: number, row: number, col: number): boolean =>
    row >= 0 && col >= 0 && row < size && col < size;

function setModule(grid: Grid, size: number, row: number, col: number, dark: boolean): void {
    if (inBounds(size, row, col)) grid[row]![col] = dark ? 1 : 0;
}

function placeFinder(grid: Grid, size: number, row: number, col: number): void {
    // 7x7 eye + the light separator ring around it.
    for (let dr = -1; dr <= 7; dr += 1) {
        for (let dc = -1; dc <= 7; dc += 1) {
            const r = row + dr;
            const c = col + dc;
            if (!inBounds(size, r, c)) continue;
            const inEye = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
            const dark = inEye && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
            grid[r]![c] = dark ? 1 : 0;
        }
    }
}

function placeAlignment(grid: Grid, size: number, centreRow: number, centreCol: number): void {
    for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
            const dark = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            setModule(grid, size, centreRow + dr, centreCol + dc, dark);
        }
    }
}

/** Finder eyes, separators, timing, alignment, dark module, reserved info areas. */
function placeFunctionPatterns(grid: Grid, size: number, version: number): void {
    placeFinder(grid, size, 0, 0);
    placeFinder(grid, size, 0, size - 7);
    placeFinder(grid, size, size - 7, 0);

    for (let i = 8; i < size - 8; i += 1) {
        const dark = i % 2 === 0;
        if (grid[6]![i] === -1) grid[6]![i] = dark ? 1 : 0;
        if (grid[i]![6] === -1) grid[i]![6] = dark ? 1 : 0;
    }

    const centres = ALIGNMENT_CENTERS[version] as number[];
    for (const row of centres) {
        for (const col of centres) {
            // Skip the three positions that collide with the finder eyes.
            const overlapsFinder = (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
            if (overlapsFinder) continue;
            placeAlignment(grid, size, row, col);
        }
    }

    // Format information areas (written later) and the always-dark module.
    for (let i = 0; i < 9; i += 1) {
        if (grid[8]![i] === -1) grid[8]![i] = 0;
        if (grid[i]![8] === -1) grid[i]![8] = 0;
    }
    for (let i = 0; i < 8; i += 1) {
        if (grid[8]![size - 1 - i] === -1) grid[8]![size - 1 - i] = 0;
        if (grid[size - 1 - i]![8] === -1) grid[size - 1 - i]![8] = 0;
    }
    grid[size - 8]![8] = 1;

    if (version >= 7) {
        for (let i = 0; i < 18; i += 1) {
            const row = Math.floor(i / 3);
            const col = (i % 3) + size - 11;
            if (grid[row]![col] === -1) grid[row]![col] = 0;
            if (grid[col]![row] === -1) grid[col]![row] = 0;
        }
    }
}

/** Zigzag data placement, MSB first, skipping the vertical timing column. */
function placeData(grid: Grid, size: number, codewords: number[], mask: number): void {
    let bitIndex = 7;
    let byteIndex = 0;
    let row = size - 1;
    let direction = -1;

    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col -= 1;
        for (;;) {
            for (let offset = 0; offset < 2; offset += 1) {
                const c = col - offset;
                if (grid[row]![c] !== -1) continue;
                const byte = codewords[byteIndex];
                let dark = byte !== undefined && ((byte >>> bitIndex) & 1) === 1;
                if (maskApplies(mask, row, c)) dark = !dark;
                grid[row]![c] = dark ? 1 : 0;
                bitIndex -= 1;
                if (bitIndex < 0) {
                    bitIndex = 7;
                    byteIndex += 1;
                }
            }
            row += direction;
            if (row < 0 || row >= size) {
                row -= direction;
                direction = -direction;
                break;
            }
        }
    }
}

/** The eight mask conditions, `i` = row, `j` = column. */
function maskApplies(mask: number, row: number, col: number): boolean {
    switch (mask) {
        case 0:
            return (row + col) % 2 === 0;
        case 1:
            return row % 2 === 0;
        case 2:
            return col % 3 === 0;
        case 3:
            return (row + col) % 3 === 0;
        case 4:
            return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
        case 5:
            return ((row * col) % 2) + ((row * col) % 3) === 0;
        case 6:
            return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
        case 7:
            return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
        default:
            throw new RangeError(`qr: mask must be 0..7, got ${mask}`);
    }
}

/** Polynomial remainder over GF(2): `data << shift` mod `poly`. */
function bchRemainder(data: number, poly: number, shift: number): number {
    let remainder = data << shift;
    while (remainder !== 0 && bitLength(remainder) >= bitLength(poly)) {
        remainder ^= poly << (bitLength(remainder) - bitLength(poly));
    }
    return remainder;
}

/** BCH(15,5) remainder for the format information. */
function formatBits(mask: number): number {
    const data = (ECC_FORMAT_BITS << 3) | mask;
    return (((data << 10) | bchRemainder(data, 0x537, 10)) ^ 0x5412) & 0x7fff;
}

/** BCH(18,6) remainder for the version information (version >= 7). */
function versionBits(version: number): number {
    return ((version << 12) | bchRemainder(version, 0x1f25, 12)) & 0x3ffff;
}

function bitLength(value: number): number {
    let length = 0;
    let rest = value;
    while (rest !== 0) {
        length += 1;
        rest >>>= 1;
    }
    return length;
}

function writeFormatInfo(grid: Grid, size: number, mask: number): void {
    const bits = formatBits(mask);
    for (let i = 0; i < 15; i += 1) {
        const dark = ((bits >>> i) & 1) === 1;
        // Vertical strip (column 8) …
        if (i < 6) grid[i]![8] = dark ? 1 : 0;
        else if (i < 8) grid[i + 1]![8] = dark ? 1 : 0;
        else grid[size - 15 + i]![8] = dark ? 1 : 0;
        // … and its mirrored horizontal copy (row 8).
        if (i < 8) grid[8]![size - 1 - i] = dark ? 1 : 0;
        else if (i < 9) grid[8]![15 - i] = dark ? 1 : 0;
        else grid[8]![14 - i] = dark ? 1 : 0;
    }
    grid[size - 8]![8] = 1;
}

function writeVersionInfo(grid: Grid, size: number, version: number): void {
    if (version < 7) return;
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
        const dark = ((bits >>> i) & 1) === 1;
        const row = Math.floor(i / 3);
        const col = (i % 3) + size - 11;
        grid[row]![col] = dark ? 1 : 0;
        grid[col]![row] = dark ? 1 : 0;
    }
}

/** ISO/IEC 18004 §8.8.2 penalty rules N1..N4; the mask with the lowest score wins. */
function penaltyScore(grid: Grid, size: number): number {
    let score = 0;

    // N1: runs of five or more identical modules in a row/column.
    for (let i = 0; i < size; i += 1) {
        let rowRun = 1;
        let colRun = 1;
        for (let j = 1; j < size; j += 1) {
            if (grid[i]![j] === grid[i]![j - 1]) rowRun += 1;
            else {
                if (rowRun >= 5) score += 3 + (rowRun - 5);
                rowRun = 1;
            }
            if (grid[j]![i] === grid[j - 1]![i]) colRun += 1;
            else {
                if (colRun >= 5) score += 3 + (colRun - 5);
                colRun = 1;
            }
        }
        if (rowRun >= 5) score += 3 + (rowRun - 5);
        if (colRun >= 5) score += 3 + (colRun - 5);
    }

    // N2: 2x2 blocks of one colour.
    for (let row = 0; row < size - 1; row += 1) {
        for (let col = 0; col < size - 1; col += 1) {
            const value = grid[row]![col];
            if (value === grid[row]![col + 1] && value === grid[row + 1]![col] && value === grid[row + 1]![col + 1]) {
                score += 3;
            }
        }
    }

    // N3: finder-like 1:1:3:1:1 patterns with four light modules on either side.
    const finderLike = [1, 0, 1, 1, 1, 0, 1] as const;
    const matchesAt = (line: number[], start: number, pattern: readonly number[]): boolean =>
        pattern.every((expected, offset) => line[start + offset] === expected);
    const rows: number[][] = [];
    const cols: number[][] = [];
    for (let i = 0; i < size; i += 1) {
        rows.push(Array.from(grid[i] as Int8Array));
        cols.push(Array.from({ length: size }, (_, j) => grid[j]![i] as number));
    }
    for (const line of [...rows, ...cols]) {
        for (let start = 0; start + 11 <= size; start += 1) {
            if (matchesAt(line, start, finderLike) && line.slice(start + 7, start + 11).every((v) => v === 0)) score += 40;
            if (matchesAt(line, start, [0, 0, 0, 0, ...finderLike])) score += 40;
        }
    }

    // N4: deviation of the dark-module ratio from 50%.
    let dark = 0;
    for (const line of grid) for (const value of line) if (value === 1) dark += 1;
    const percent = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
}

function toRows(grid: Grid, size: number): string[] {
    return grid.map((line) => Array.from({ length: size }, (_, col) => (line[col] === 1 ? "1" : "0")).join(""));
}

/**
 * Encode `text` (UTF-8) as a QR symbol at ECC level M.
 *
 * @throws RangeError when the payload does not fit a version-10 symbol or an
 *   override is out of range.
 */
export function encodeQr(text: string, options: QrOptions = {}): QrMatrix {
    const bytes = Array.from(Buffer.from(text, "utf8"));
    const version = options.version ?? pickVersion(bytes.length);
    if (!Number.isInteger(version) || version < MIN_VERSION || version > MAX_VERSION) {
        throw new RangeError(`qr: version must be ${MIN_VERSION}..${MAX_VERSION}, got ${options.version}`);
    }
    if (bytes.length > capacityBytes(version)) {
        throw new RangeError(`qr: ${bytes.length} bytes do not fit version ${version} at ECC M`);
    }
    if (options.mask !== undefined && (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7)) {
        throw new RangeError(`qr: mask must be 0..7, got ${options.mask}`);
    }

    const size = version * 4 + 17;
    const codewords = buildCodewordStream(bytes, version);
    // The mask is applied while the data modules are placed, so every candidate
    // starts from a fresh copy of the function patterns.
    const candidates = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];
    let best: { mask: number; grid: Grid; score: number } | undefined;
    for (const mask of candidates) {
        const grid = makeGrid(size);
        placeFunctionPatterns(grid, size, version);
        placeData(grid, size, codewords, mask);
        writeFormatInfo(grid, size, mask);
        writeVersionInfo(grid, size, version);
        const score = penaltyScore(grid, size);
        if (best === undefined || score < best.score) best = { mask, grid, score };
    }
    const chosen = best as { mask: number; grid: Grid };
    return {
        version,
        ecc: ECC,
        mask: chosen.mask,
        size,
        rows: toRows(chosen.grid, size),
    };
}

/** Bytes a version-`version` ECC-M symbol can carry, excluding header bytes. */
export function capacityBytes(version: number = MAX_VERSION): number {
    const spec = VERSIONS[version] as VersionSpec | undefined;
    if (spec === undefined) throw new RangeError(`qr: unknown version ${version}`);
    return Math.floor((dataCodewords(spec) * 8 - 4 - charCountBits(version)) / 8);
}

/** `true` when the whole payload fits at ECC M (used by callers to fail early). */
export function fitsQr(text: string): boolean {
    return Buffer.byteLength(text, "utf8") <= capacityBytes(MAX_VERSION);
}

/** Version table exposed for tests (capacity assertions). */
export function versionSpecs(): Record<number, VersionSpec> {
    return VERSIONS;
}
