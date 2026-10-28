/**
 * Where this process runs from, and what it is allowed to assume about that.
 *
 * `pi2` ships in two shapes (ADR 0002):
 *
 * 1. an npm package executed by Node (`node …/dist/cli/pi2.js`), where every
 *    asset sits next to the source tree, and
 * 2. a compiled single binary (`bun build --compile`) installed as
 *    `<prefix>/bin/pi2` with its assets at `<prefix>/share/pi2d/web/dist`.
 *
 * The compiled shape has no source tree and no `package.json` on disk, so the
 * version is injected at build time (`bun build --define`). Everything that
 * needs to answer "what am I, where are my files" lives here, so that no other
 * module has to guess from `import.meta.url` alone.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Replaced textually by `scripts/build-binary.sh` (`bun build --define`).
 * `typeof` on an undeclared identifier is safe, so an unbundled Node run falls
 * through to the on-disk `package.json`.
 */
declare const PI2_BUILD_VERSION: string | undefined;

/** Fallback when neither the build-time define nor `package.json` is readable. */
export const UNKNOWN_VERSION = "0.0.0";

/** Bun's node-compat version string, when running as a compiled binary. */
function bunVersion(): string | undefined {
    const versions = process.versions as { bun?: string } | undefined;
    return typeof versions?.bun === "string" ? versions.bun : undefined;
}

/**
 * True when this process is a `bun build --compile` artifact.
 *
 * The check is deliberately runtime-based rather than build-based: the same
 * source runs under both shapes, and only the packaging differs.
 */
export function isBundledRuntime(): boolean {
    return bunVersion() !== undefined;
}

/** `bundled bun 1.3.14` or `node 22.11.0` — for `pi2 doctor` and logs. */
export function runtimeDescription(): string {
    const bun = bunVersion();
    if (bun !== undefined) return `bundled bun ${bun}`;
    return `node ${process.version.replace(/^v/, "")}`;
}

/** Runtime version string only (`22.11.0`, or Bun's compat version). */
export function runtimeVersion(): string {
    return process.version.replace(/^v/, "");
}

/** Absolute path of the running executable (`node`, or the compiled `pi2`). */
export function executablePath(): string {
    return process.execPath;
}

/** `<repo>/package.json` next to `dist/cli/`. Absent inside a compiled binary. */
function packageJsonVersion(): string | undefined {
    try {
        const file = fileURLToPath(new URL("../../package.json", import.meta.url));
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Version of the running `pi2`.
 *
 * Order: build-time define (compiled binary) → on-disk `package.json` (npm
 * install, dev checkout) → `UNKNOWN_VERSION`. Never throws: a version probe
 * must not be able to take the daemon down.
 */
export function version(): string {
    if (typeof PI2_BUILD_VERSION === "string" && PI2_BUILD_VERSION !== "") return PI2_BUILD_VERSION;
    return packageJsonVersion() ?? UNKNOWN_VERSION;
}

/**
 * Static UI locations, most specific first.
 *
 * 1. `<exe>/../share/pi2d/web/dist` — the release layout: `<prefix>/bin/pi2`
 *    plus `<prefix>/share/pi2d/web/dist`, which is what the curl installer,
 *    the Homebrew formula and the AUR `-bin` package all install.
 * 2. `<exe>/web/dist` — a portable unpacked directory (`pi2` next to its UI).
 * 3. `<repo>/web/dist` — an npm install or a dev checkout, resolved from this
 *    module's own location.
 */
export function staticDirCandidates(): string[] {
    const exeDir = dirname(executablePath());
    return [
        resolve(exeDir, "..", "share", "pi2d", "web", "dist"),
        resolve(exeDir, "web", "dist"),
        resolve(fileURLToPath(new URL("../../web/dist", import.meta.url))),
    ];
}

function hasIndex(dir: string): boolean {
    return existsSync(join(dir, "index.html"));
}

/**
 * The built web UI for the current install shape, or the dev-checkout path when
 * none of the candidates exists (so diagnostics name a path the user can
 * create, instead of an arbitrary miss).
 */
export function defaultStaticDir(): string {
    for (const candidate of staticDirCandidates()) {
        if (hasIndex(candidate)) return candidate;
    }
    const devPath = staticDirCandidates().at(-1);
    return devPath ?? resolve("web", "dist");
}

/**
 * True when the static dir that `defaultStaticDir()` would pick actually holds
 * a built UI. `PI2_STATIC_DIR` overrides this entirely at the config layer.
 */
export function hasBundledStaticDir(dir: string): boolean {
    return hasIndex(dir);
}
