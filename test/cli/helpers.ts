/** Shared helpers for the CLI specs (temp dirs, silent logger, bare config). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config, Limits } from "../../src/config.js";
import type { Logger } from "../../src/core/interfaces.js";

export const TEST_LIMITS: Limits = {
    maxBodyBytes: 8 * 1024 * 1024,
    maxFrameBytes: 8 * 1024 * 1024,
    maxConnections: 64,
};

export function tempDir(prefix = "pi2-daemon-cli-"): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
}

export function testConfig(overrides: Partial<Config> = {}): Config {
    const base: Config = {
        host: "127.0.0.1",
        port: 0,
        staticDir: "/nonexistent-web-dist",
        corsOrigins: [],
        limits: TEST_LIMITS,
        tokenPath: "/tmp/pi2-daemon-cli-test.sock.token",
        deviceStorePath: "/tmp/pi2-daemon-cli-test-devices.json",
    };
    return { ...base, ...overrides, limits: { ...base.limits, ...(overrides.limits ?? {}) } };
}

export const silentLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
};

export function setRuntimeEnv(dir: string): void {
    process.env.PI2_RUNTIME_DIR = join(dir, "run");
    process.env.PI2_DATA_DIR = join(dir, "data");
    process.env.PI2_STATE_DIR = join(dir, "state");
    process.env.PI2_PORT = "0";
    process.env.PI2_STATIC_DIR = join(dir, "web");
}

export function clearRuntimeEnv(): void {
    for (const key of ["PI2_RUNTIME_DIR", "PI2_DATA_DIR", "PI2_STATE_DIR", "PI2_PORT", "PI2_STATIC_DIR"]) {
        delete process.env[key];
    }
}
