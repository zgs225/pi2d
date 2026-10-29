/**
 * `pi2 update` — the standalone (curl installer) channel's self-updater.
 *
 * Scope is deliberate (ADR 0003): only a compiled binary installed by
 * `scripts/install.sh` may update itself. npm, Homebrew and the AUR are told to
 * use their own package manager — `pi2` cannot safely rewrite a tree it does not
 * own, and the receipt says which tree that is.
 *
 * Property preserved throughout: **nothing is swapped until the download is
 * verified, extracted, and executed once**. A failed update leaves `current`
 * exactly where it was.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import {
    buildTarget,
    executablePath,
    inferBuildTarget,
    isBundledRuntime,
    version as runningVersion,
    versionedLayoutFor,
} from "../core/install.js";
import { stateDir } from "../core/paths.js";
import {
    assetName,
    assetUrl,
    channelUpgradeCommand,
    checksumsUrl,
    compareVersions,
    matchesChecksum,
    normalizeVersion,
    parseChecksums,
    resolveLatestVersion,
    RELEASE_REPO,
    type UpdateCache,
} from "../core/release.js";
import {
    applyVersionedInstall,
    readReceipt,
    removeStaleStaging,
    stagingDir,
    type InstallReceipt,
} from "../core/self-update.js";
import { extractTarGz } from "../core/tarball.js";
import { defaultServicePaths, launchAgentDir, LAUNCHD_PLIST_NAME, SYSTEMD_UNIT_NAME, systemdUserDir } from "./service.js";
import { boolFlag, CliError, parseArgs, stringFlag, UsageError } from "./util.js";

export const UPDATE_USAGE = `pi2 update — upgrade a standalone (curl installer) pi2 in place

Usage:
  pi2 update [options]
  pi2 update --check

Downloads the matching release asset into <prefix>/versions/<version>, verifies
its SHA256 digest (and, when \`gh\` is available, its SLSA build provenance),
runs the new binary once, then switches <prefix>/current and rewrites the install
receipt. The previous version is kept for one-step rollback.

Options:
  --check                report the latest version and exit (no download)
  --dry-run              print the download/verify/swap plan, change nothing
  --version <version>    update to (or back to) a specific version; a downgrade
                         also needs --force
  --force                reinstall even when the target is already installed
  --json                 machine-readable result (for editors and scripts)
  --require-attestation  fail when the SLSA provenance cannot be verified
  --skip-attestation     never call \`gh attestation verify\`
  -h, --help             print this help and exit

Environment:
  PI2_BASE_URL            release asset base URL (mirror or local fixture)
  PI2_UPDATE_CACHE_TTL    seconds a version lookup stays cached (default 86400)

Only the standalone channel can self-update. npm (\`npm i -g @yuez/pi2d\`),
Homebrew (\`brew upgrade pi2d\`) and the AUR (paru/yay) own their own trees, and
\`pi2 update\` refuses them with the command to use instead.`;

const CACHE_FILE = "update-check.json";

export interface ExecResult {
    code: number;
    stdout: string;
    stderr: string;
}

export type UpdateExec = (argv: readonly string[]) => ExecResult;

export interface UpdateDeps {
    /** Injected in tests; defaults to the global `fetch`. */
    fetchImpl?: typeof fetch;
    /** Runs `gh attestation verify` and the staged `--version` smoke test. */
    exec?: UpdateExec;
    now?: () => Date;
    execPath?: string;
    isBundled?: () => boolean;
    env?: NodeJS.ProcessEnv;
    stateDirPath?: string;
    /** Version of the running binary (defaults to the build-time/`package.json` version). */
    currentVersion?: string;
    print?: (line: string) => void;
    warn?: (line: string) => void;
}

export interface UpdateOptions extends UpdateDeps {
    argv: readonly string[];
}

export interface UpdateResult {
    action: "checked" | "up-to-date" | "planned" | "installed";
    current: string;
    latest: string;
    installer: string;
    prefix: string;
    asset: string;
    url: string;
    attestation: "verified" | "skipped" | "unavailable" | "failed";
    previous?: string;
    restart: string;
    updatable: boolean;
}

export interface ParsedUpdateArgs {
    check: boolean;
    dryRun: boolean;
    force: boolean;
    json: boolean;
    requireAttestation: boolean;
    skipAttestation: boolean;
    help: boolean;
    version?: string;
}

export function parseUpdateArgs(argv: readonly string[]): ParsedUpdateArgs {
    const parsed = parseArgs(argv, {
        values: ["--version"],
        booleans: [
            "--check",
            "--dry-run",
            "--force",
            "--json",
            "--require-attestation",
            "--skip-attestation",
            "--help",
        ],
        aliases: { "-h": "--help" },
    });
    if (parsed.positionals.length > 0) {
        throw new UsageError(`unexpected argument "${parsed.positionals[0]}"`, UPDATE_USAGE);
    }
    const parsedArgs: ParsedUpdateArgs = {
        check: boolFlag(parsed.flags, "--check"),
        dryRun: boolFlag(parsed.flags, "--dry-run"),
        force: boolFlag(parsed.flags, "--force"),
        json: boolFlag(parsed.flags, "--json"),
        requireAttestation: boolFlag(parsed.flags, "--require-attestation"),
        skipAttestation: boolFlag(parsed.flags, "--skip-attestation"),
        help: boolFlag(parsed.flags, "--help"),
    };
    const pinned = stringFlag(parsed.flags, "--version");
    if (pinned !== undefined) parsedArgs.version = normalizeVersion(pinned);
    return parsedArgs;
}

function realpathOrSelf(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** How to restart whatever is running the old binary. */
export function restartHint(platform: string = process.platform): string {
    if (platform === "linux" || platform === "darwin") {
        const paths = defaultServicePaths();
        const unit =
            platform === "darwin"
                ? join(launchAgentDir(paths), LAUNCHD_PLIST_NAME)
                : join(systemdUserDir(paths), SYSTEMD_UNIT_NAME);
        if (existsSync(unit)) return "pi2 service stop && pi2 service start";
    }
    return "pi2 stop   # :PiWeb starts a fresh daemon next time";
}

function readCache(file: string): UpdateCache | undefined {
    try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<UpdateCache>;
        if (typeof parsed.version !== "string" || typeof parsed.checkedAt !== "string") return undefined;
        const cache: UpdateCache = { version: parsed.version, checkedAt: parsed.checkedAt };
        if (typeof parsed.etag === "string") cache.etag = parsed.etag;
        return cache;
    } catch {
        return undefined;
    }
}

function writeCache(file: string, cache: UpdateCache): void {
    try {
        writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    } catch {
        // A cache write failure must never fail an update.
    }
}

/** Resolve the receipt, refusing every channel that is not ours. */
export function resolveInstall(execPath: string, bundled: boolean): { receipt: InstallReceipt } {
    if (!bundled) {
        throw new CliError(
            "pi2 update only upgrades a standalone (curl installer) pi2; this one runs under Node.\n" +
                "Upgrade it with the package manager that installed it: npm i -g @yuez/pi2d@latest",
        );
    }
    const layout = versionedLayoutFor(execPath);
    if (layout === undefined) {
        throw new CliError(
            "this pi2 is not in the standalone layout (<prefix>/versions/<version>/bin/pi2).\n" +
                "If the curl installer put it here before 0.1.7, re-run the installer once to migrate:\n" +
                "  curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh",
        );
    }
    const { receipt, error } = readReceipt(layout.prefix);
    if (receipt === undefined) {
        throw new CliError(
            `cannot update: ${error ?? "no install receipt"}.\n` +
                "Homebrew, the AUR and npm own their own trees; use the command that installed pi2:\n" +
                `  ${channelUpgradeCommand("unknown")}\n` +
                "A curl install from before 0.1.7 has no receipt; re-run the installer once to migrate:\n" +
                "  curl -fsSL https://raw.githubusercontent.com/zgs225/pi2d/main/scripts/install.sh | sh",
        );
    }
    if (receipt.installer !== "curl") {
        throw new CliError(
            `pi2 was installed by ${receipt.installer}; let it upgrade itself:\n  ${channelUpgradeCommand(receipt.installer)}`,
        );
    }
    if (realpathOrSelf(receipt.bin) !== realpathOrSelf(execPath)) {
        throw new CliError(
            `another copy of pi2 is running: ${execPath} is not the binary the receipt describes (${receipt.bin}).\n` +
                "Remove one of them, or re-run the installer to rewrite the receipt.",
        );
    }
    return { receipt };
}

async function download(url: string, fetchImpl: typeof fetch, what: string): Promise<Uint8Array> {
    let response: Response;
    try {
        response = await fetchImpl(url);
    } catch (error) {
        throw new CliError(`could not download ${what} from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
        throw new CliError(
            `could not download ${what} from ${url}: HTTP ${response.status} ${response.statusText}\n` +
                "The release may not publish this platform; check https://github.com/" +
                RELEASE_REPO +
                "/releases",
        );
    }
    return new Uint8Array(await response.arrayBuffer());
}

function verifyAttestation(
    exec: UpdateExec,
    file: string,
    mode: ParsedUpdateArgs,
): "verified" | "skipped" | "unavailable" | "failed" {
    if (mode.skipAttestation) return "skipped";
    if (exec(["gh", "--version"]).code !== 0) {
        if (mode.requireAttestation) {
            throw new CliError(
                "--require-attestation was passed but `gh` is not installed; install it from https://cli.github.com",
            );
        }
        return "unavailable";
    }
    const result = exec(["gh", "attestation", "verify", file, "--repo", RELEASE_REPO]);
    if (result.code === 0) return "verified";
    if (mode.requireAttestation) {
        throw new CliError(
            `SLSA provenance verification failed for ${file}: ${result.stderr.trim() || `gh exited ${result.code}`}`,
        );
    }
    return "failed";
}

function formatHuman(result: UpdateResult): string {
    const lines: string[] = [];
    if (result.action === "up-to-date") {
        lines.push(`pi2 ${result.current} is up to date (latest release: ${result.latest}).`);
        return lines.join("\n");
    }
    if (result.action === "checked") {
        lines.push(`pi2 ${result.current} — latest release: ${result.latest}`);
        lines.push(
            result.updatable
                ? "Run `pi2 update` to install it."
                : `Already on ${result.latest}; pass --force to reinstall.`,
        );
        return lines.join("\n");
    }
    if (result.action === "planned") {
        lines.push(`would install pi2 ${result.latest} (current ${result.current})`);
        lines.push(`  asset:   ${result.asset}`);
        lines.push(`  from:    ${result.url}`);
        lines.push(`  prefix:  ${result.prefix}`);
        lines.push(`  receipt: ${result.installer}`);
        return lines.join("\n");
    }
    lines.push(`pi2 ${result.current} → ${result.latest} installed`);
    lines.push(`  prefix:  ${result.prefix}`);
    lines.push(`  asset:   ${result.asset}`);
    lines.push(`  digest:  verified (SHA256SUMS)`);
    lines.push(
        `  proof:   ${
            result.attestation === "verified"
                ? "SLSA build provenance verified"
                : result.attestation === "skipped"
                  ? "skipped (--skip-attestation)"
                  : result.attestation === "unavailable"
                    ? "not checked (install the GitHub CLI to verify provenance)"
                    : "could not be verified; download the binary again if that is unexpected"
        }`,
    );
    if (result.previous !== undefined && result.previous !== result.latest) {
        lines.push(`  kept:    ${result.previous} for one-step rollback (--version ${result.previous})`);
    }
    lines.push("");
    lines.push(`Restart the daemon to use it: ${result.restart}`);
    return lines.join("\n");
}

async function performUpdate(parsed: ParsedUpdateArgs, deps: UpdateDeps): Promise<UpdateResult> {
    const print = deps.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
    const env = deps.env ?? process.env;
    const fetchImpl = deps.fetchImpl ?? fetch;
    const now = deps.now ?? (() => new Date());
    const execPath = deps.execPath ?? executablePath();
    const bundled = deps.isBundled === undefined ? isBundledRuntime() : deps.isBundled();
    const exec = deps.exec ?? ((argv: readonly string[]) => {
        const result = spawnSync(argv[0] as string, argv.slice(1), { encoding: "utf8" });
        return {
            code: result.status ?? 1,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? result.error?.message ?? "",
        };
    });
    const current = deps.currentVersion ?? runningVersion();
    const { receipt } = resolveInstall(execPath, bundled);
    const prefix = receipt.prefix;
    const target = buildTarget() ?? inferBuildTarget();
    const asset = assetName(parsed.version ?? "0.0.0", target);
    const restart = restartHint();

    // 1. Which version are we aiming at?
    let latest: string;
    if (parsed.version !== undefined) {
        latest = parsed.version;
    } else {
        const cacheFile = join(deps.stateDirPath ?? stateDir(), CACHE_FILE);
        const cached = readCache(cacheFile);
        const ttlRaw = env.PI2_UPDATE_CACHE_TTL;
        const ttlSeconds = ttlRaw === undefined ? undefined : Number(ttlRaw);
        const lookup = await resolveLatestVersion({
            fetchImpl,
            ...(cached === undefined ? {} : { cache: cached }),
            ...(ttlSeconds !== undefined && Number.isFinite(ttlSeconds) ? { ttlMs: ttlSeconds * 1000 } : {}),
            now: now(),
        });
        writeCache(cacheFile, lookup.cache);
        latest = lookup.version;
    }

    const updatable = compareVersions(latest, current) > 0;
    if (!parsed.force) {
        if (compareVersions(latest, current) < 0) {
            throw new CliError(
                `refusing to downgrade pi2 ${current} → ${latest}; pass --force to do it anyway`,
            );
        }
        if (compareVersions(latest, current) === 0) {
            return {
                action: "up-to-date",
                current,
                latest,
                installer: String(receipt.installer),
                prefix,
                asset: assetName(latest, target),
                url: assetUrl(latest, target, env.PI2_BASE_URL),
                attestation: "skipped",
                restart,
                updatable: false,
            };
        }
    }

    const resolvedAsset = assetName(latest, target);
    const url = assetUrl(latest, target, env.PI2_BASE_URL);
    const base: UpdateResult = {
        action: parsed.check ? "checked" : parsed.dryRun ? "planned" : "installed",
        current,
        latest,
        installer: String(receipt.installer),
        prefix,
        asset: resolvedAsset,
        url,
        attestation: "skipped",
        restart,
        updatable,
    };

    if (parsed.check) return base;
    if (parsed.dryRun) {
        if (!parsed.json) print(formatHuman(base));
        return base;
    }

    // 2. Fetch and verify.
    // stderr: `--json` callers parse stdout
    warn(`pi2 update: downloading ${resolvedAsset}…`);
    const sumsBytes = await download(checksumsUrl(latest, env.PI2_BASE_URL), fetchImpl, "SHA256SUMS");
    const checksums = parseChecksums(new TextDecoder().decode(sumsBytes));
    const expected = checksums.get(resolvedAsset);
    if (expected === undefined) {
        throw new CliError(
            `SHA256SUMS for ${latest} has no entry for ${resolvedAsset}; the release does not publish this platform`,
        );
    }
    const archive = await download(url, fetchImpl, resolvedAsset);
    if (!matchesChecksum(archive, expected)) {
        throw new CliError(`checksum mismatch for ${resolvedAsset}: the download does not match ${expected}`);
    }

    // 3. Stage, verify provenance, smoke-test.
    removeStaleStaging(prefix);
    const staging = stagingDir(prefix);
    const archiveFile = `${staging}.tar.gz`;
    let attestation: UpdateResult["attestation"] = "skipped";
    try {
        writeFileSync(archiveFile, archive);
        attestation = verifyAttestation(exec, archiveFile, parsed);
        if (attestation === "failed") {
            warn("pi2 update: SLSA provenance could not be verified; continuing (pass --require-attestation to make this fatal)");
        }
        extractTarGz(archive, staging);
        const stagedBin = join(staging, "bin", "pi2");
        if (!existsSync(stagedBin)) throw new CliError("the release asset has no bin/pi2");
        const probe = exec([stagedBin, "--version"]);
        const reported = /\b(\d+\.\d+\.\d+)\b/.exec(probe.stdout) ?? /\b(\d+\.\d+\.\d+)\b/.exec(probe.stderr);
        if (probe.code !== 0) {
            throw new CliError(`the downloaded binary does not run (exit ${probe.code}): ${probe.stderr.trim()}`);
        }
        if (reported?.[1] !== undefined && normalizeVersion(reported[1]) !== latest) {
            throw new CliError(
                `the downloaded binary reports ${reported[1]}, expected ${latest}; the release asset is inconsistent`,
            );
        }

        // 4. Swap and record.
        const applied = applyVersionedInstall({
            prefix,
            version: latest,
            stagedDir: staging,
            asset: resolvedAsset,
            sha256: expected,
            now: now(),
        });
        const result: UpdateResult = {
            ...base,
            attestation,
            ...(applied.previous === undefined ? {} : { previous: applied.previous }),
        };
        if (!parsed.json) print(formatHuman(result));
        return result;
    } finally {
        rmSync(staging, { recursive: true, force: true });
        rmSync(archiveFile, { force: true });
    }
}

/** `pi2 update …` */
export async function runUpdate(options: UpdateOptions): Promise<number> {
    const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
    let parsed: ParsedUpdateArgs;
    try {
        parsed = parseUpdateArgs(options.argv);
    } catch (error) {
        if (error instanceof UsageError) throw new UsageError(error.message, UPDATE_USAGE);
        throw error;
    }
    if (parsed.help) {
        print(UPDATE_USAGE);
        return 0;
    }
    const result = await performUpdate(parsed, options);
    if (parsed.json) print(JSON.stringify(result, null, 2));
    else if (result.action === "checked" || result.action === "up-to-date") print(formatHuman(result));
    return 0;
}
