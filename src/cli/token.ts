/**
 * The local CLI token (`<runtime>/cli.token`).
 *
 * `pi2 daemon` mints a fresh 32-byte hex token on every start and writes it 0600.
 * `AuthStore` accepts it as the synthetic `local-cli` admin device, so every
 * local `pi2*` command can talk to the daemon without pairing. The token is
 * per-daemon-lifetime: restarting `pi2 daemon` rotates it.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ensureDir, runtimeDir } from "../core/paths.js";
import { CLI_TOKEN_FILE } from "./wiring.js";

export const CLI_TOKEN_BYTES = 32;

export function cliTokenPath(runtime: string = runtimeDir()): string {
    return join(runtime, CLI_TOKEN_FILE);
}

/** Mint a fresh token and write it atomically (mode 0600). */
export function writeCliToken(path: string = cliTokenPath()): string {
    const token = randomBytes(CLI_TOKEN_BYTES).toString("hex");
    ensureDir(dirname(path), 0o700);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(temporary, `${token}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    return token;
}

export function readCliToken(path: string = cliTokenPath()): string | undefined {
    try {
        const value = readFileSync(path, "utf8").trim();
        return value === "" ? undefined : value;
    } catch {
        return undefined;
    }
}

export interface TokenPerms {
    exists: boolean;
    mode: number | undefined;
}

export function tokenPerms(path: string = cliTokenPath()): TokenPerms {
    if (!existsSync(path)) return { exists: false, mode: undefined };
    try {
        return { exists: true, mode: statSync(path).mode & 0o777 };
    } catch {
        return { exists: false, mode: undefined };
    }
}
