import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli/pi2.js";
import {
    detectUninstallChannel,
    formatUninstallStep,
    installerBinSymlink,
    planUninstall,
    runUninstall,
    uninstallNextSteps,
    configEnvPath,
    type UninstallChannel,
    type UninstallOptions,
    type UninstallStep,
} from "../../src/cli/uninstall.js";
import { CliError } from "../../src/cli/util.js";
import { removeDir, tempDir } from "./helpers.js";

const RUNTIME = "/home/u/run/pi2";
const DATA = "/home/u/.local/share/pi2";
const STATE = "/home/u/.local/state/pi2";
const CONFIG = "/home/u/.config/pi2/env";
const UNIT = "/home/u/.config/systemd/user/pi2.service";
const PREFIX = "/home/u/.local/lib/pi2d";

interface Harness {
    options: UninstallOptions;
    removed: string[];
    removedFiles: string[];
    lines: string[];
    warnings: string[];
    calls: string[];
}

/**
 * A fake filesystem + fake systemd: `exists` answers from a set, removals are
 * recorded, and every hook appends to `calls` so ordering is assertable.
 */
function harness(present: readonly string[], overrides: UninstallOptions = {}): Harness {
    const files = new Set(present);
    const removed: string[] = [];
    const removedFiles: string[] = [];
    const lines: string[] = [];
    const warnings: string[] = [];
    const calls: string[] = [];

    const options: UninstallOptions = {
        runtime: RUNTIME,
        data: DATA,
        state: STATE,
        configEnv: CONFIG,
        servicePaths: { homeDir: "/home/u", stateDir: STATE },
        homeDir: "/home/u",
        yes: true,
        channel: { installer: "npm" },
        print: (line) => lines.push(line),
        warn: (line) => warnings.push(line),
        exists: (path) => files.has(path),
        removeDir: (path) => {
            removed.push(path);
            calls.push(`rmdir ${path}`);
        },
        removeFile: (path) => {
            removedFiles.push(path);
            calls.push(`rm ${path}`);
        },
        daemonPid: () => undefined,
        serviceInstalled: (unitPath) => files.has(unitPath),
        stopDaemon: async () => {
            calls.push("stop daemon");
        },
        disableService: async () => {
            calls.push("disable service");
        },
        removeService: (path) => {
            removedFiles.push(path);
            calls.push(`rm ${path}`);
        },
        ...overrides,
    };
    return { options, removed, removedFiles, lines, warnings, calls };
}

describe("planUninstall", () => {
    const base = {
        runtime: RUNTIME,
        data: DATA,
        state: STATE,
        configEnv: CONFIG,
        serviceUnit: UNIT,
        serviceInstalled: true,
        daemonPid: 4242,
        channel: { installer: "npm" } as UninstallChannel,
        exists: () => true,
    };

    it("removes the service, the daemon and the runtime dir, and keeps the rest", () => {
        const steps = planUninstall({ ...base, purge: false, purgeConfig: false });

        expect(steps.map((step) => [step.target, step.remove])).toEqual([
            ["service", true],
            ["daemon", true],
            ["runtime", true],
            ["data", false],
            ["state", false],
            ["config", false],
        ]);
        expect(steps[1]?.detail).toBe("pid 4242");
    });

    it("--purge adds data and state, --purge-config adds the env file", () => {
        const steps = planUninstall({ ...base, purge: true, purgeConfig: true });
        const removed = steps.filter((step) => step.remove).map((step) => step.target);

        expect(removed).toEqual(["service", "daemon", "runtime", "data", "state", "config"]);
    });

    it("--keep-service keeps the unit but still cleans the state", () => {
        const steps = planUninstall({ ...base, purge: false, purgeConfig: false, keepService: true });
        expect(steps.find((step) => step.target === "service")?.remove).toBe(false);
        expect(steps.find((step) => step.target === "runtime")?.remove).toBe(true);
    });

    it("only offers the install tree on the curl channel, and only with --purge", () => {
        const curl: UninstallChannel = { installer: "curl", prefix: PREFIX };

        expect(
            planUninstall({ ...base, channel: curl, purge: false, purgeConfig: false }).some(
                (step) => step.target === "install",
            ),
        ).toBe(false);

        const purged = planUninstall({ ...base, channel: curl, purge: true, purgeConfig: false });
        expect(purged.filter((step) => step.target === "install").map((step) => [step.paths, step.remove])).toEqual([
            [[PREFIX], true],
        ]);

        const kept = planUninstall({
            ...base,
            channel: curl,
            purge: true,
            purgeConfig: false,
            keepInstall: true,
        });
        expect(kept.find((step) => step.target === "install")?.remove).toBe(false);
    });

    it("skips paths that do not exist and steps with nothing to stop", () => {
        const steps = planUninstall({
            ...base,
            purge: true,
            purgeConfig: true,
            serviceInstalled: false,
            daemonPid: undefined,
            exists: (path) => path === DATA,
        });

        expect(steps.map((step) => [step.target, step.remove])).toEqual([["data", true]]);
    });
});

describe("formatUninstallStep", () => {
    const step: UninstallStep = { target: "data", paths: [DATA], remove: false };

    it("names the flag that keeps a path", () => {
        expect(formatUninstallStep(step)).toContain(`(${"--purge"})`);
    });

    it("does not suggest a flag on a step that is already removed", () => {
        expect(formatUninstallStep({ ...step, remove: true })).not.toContain("--purge");
    });

    it("speaks in the future tense for a dry run", () => {
        expect(formatUninstallStep({ ...step, remove: true }, true)).toContain("would remove");
    });
});

describe("detectUninstallChannel", () => {
    it("recognises the versioned curl layout", () => {
        expect(detectUninstallChannel(`${PREFIX}/versions/0.1.9/bin/pi2`, true)).toEqual({
            installer: "curl",
            prefix: PREFIX,
        });
    });

    it("falls back to the shape of the path for the package managers", () => {
        expect(detectUninstallChannel("/usr/local/lib/node_modules/@yuez/pi2d/dist/cli/pi2.js", false).installer).toBe(
            "npm",
        );
        expect(detectUninstallChannel("/opt/homebrew/Cellar/pi2d/0.1.9/bin/pi2", true).installer).toBe("brew");
        expect(detectUninstallChannel("/usr/bin/pi2", true).installer).toBe("aur");
        expect(detectUninstallChannel("/tmp/pi2", true).installer).toBe("unknown");
    });
});

describe("configEnvPath", () => {
    it("honours XDG_CONFIG_HOME", () => {
        expect(configEnvPath({ XDG_CONFIG_HOME: "/x" }, "/home/u")).toBe("/x/pi2/env");
        expect(configEnvPath({}, "/home/u")).toBe("/home/u/.config/pi2/env");
    });
});

describe("runUninstall", () => {
    it("dry-run prints the plan and touches nothing", async () => {
        const h = harness([RUNTIME, DATA, STATE, CONFIG, UNIT], { dryRun: true });

        expect(await runUninstall(h.options)).toBe(0);
        expect(h.calls).toEqual([]);
        expect(h.lines[0]).toContain("dry run");
        expect(h.lines.join("\n")).toContain("--purge");
        expect(h.lines.join("\n")).toContain("npm rm -g @yuez/pi2d");
    });

    it("stops the daemon, disables and removes the unit, then deletes the runtime dir", async () => {
        const h = harness([RUNTIME, DATA, STATE, CONFIG, UNIT], { daemonPid: () => 4242 });

        expect(await runUninstall(h.options)).toBe(0);
        expect(h.calls).toEqual([
            "disable service",
            `rm ${UNIT}`,
            "stop daemon",
            `rmdir ${RUNTIME}`,
        ]);
        expect(h.removed).not.toContain(DATA);
        expect(h.lines.at(-1)).toContain("rm -rf");
    });

    it("--purge also deletes data and state; --purge-config the env file", async () => {
        const h = harness([RUNTIME, DATA, STATE, CONFIG], { purge: true, purgeConfig: true, serviceInstalled: () => false });

        expect(await runUninstall(h.options)).toBe(0);
        expect(h.removed).toEqual([RUNTIME, DATA, STATE]);
        expect(h.removedFiles).toEqual([CONFIG]);
        expect(h.lines.join("\n")).not.toContain(`rm -rf ${DATA}`);
    });

    it("removes the curl install tree last, together with the bin symlink", async () => {
        const dir = tempDir("pi2-uninstall-");
        try {
            const prefix = join(dir, "lib", "pi2d");
            const binDir = join(prefix, "versions", "1.0.0", "bin");
            mkdirSync(binDir, { recursive: true });
            writeFileSync(join(binDir, "pi2"), "");
            const home = join(dir, "home");
            mkdirSync(join(home, ".local", "bin"), { recursive: true });
            symlinkSync(join(binDir, "pi2"), join(home, ".local", "bin", "pi2"));

            const h = harness([RUNTIME, prefix], {
                homeDir: home,
                purge: true,
                channel: { installer: "curl", prefix },
            });
            expect(installerBinSymlink(prefix, home)).toBe(join(home, ".local", "bin", "pi2"));

            expect(await runUninstall(h.options)).toBe(0);
            expect(h.removed).toEqual([RUNTIME, prefix, join(home, ".local", "bin", "pi2")]);
            expect(h.lines.join("\n")).not.toContain("install.sh");
        } finally {
            removeDir(dir);
        }
    });

    it("keeps going when the service manager refuses, and reports the failure", async () => {
        const h = harness([UNIT, RUNTIME], {
            disableService: async () => {
                throw new CliError("systemctl --user disable --now pi2.service failed: nope");
            },
        });

        expect(await runUninstall(h.options)).toBe(0);
        expect(h.warnings[0]).toContain("could not disable pi2.service");
        expect(h.removed).toEqual([RUNTIME]);
    });

    it("counts a failed removal as a failure and exits 1", async () => {
        const h = harness([RUNTIME, DATA], {
            purge: true,
            removeDir: (path) => {
                if (path === DATA) throw new Error("EPERM");
            },
        });

        expect(await runUninstall(h.options)).toBe(1);
        expect(h.warnings[0]).toContain("could not remove");
        expect(h.lines.join("\n")).toContain("1 failure(s)");
    });

    it("asks before removing and honours a no", async () => {
        const h = harness([RUNTIME], { yes: false, isTTY: true, confirm: async () => false });

        expect(await runUninstall(h.options)).toBe(1);
        expect(h.calls).toEqual([]);
        expect(h.lines.at(-1)).toContain("aborted");
    });

    it("refuses to run non-interactively without --yes", async () => {
        const h = harness([RUNTIME], { yes: false, isTTY: false });

        await expect(runUninstall(h.options)).rejects.toThrow("refusing to remove anything without confirmation");
        expect(h.calls).toEqual([]);
    });

    it("succeeds when there is nothing left to remove", async () => {
        const h = harness([]);

        expect(await runUninstall(h.options)).toBe(0);
        expect(h.lines.join("\n")).toContain("nothing to remove");
        expect(h.calls).toEqual([]);
    });
});

describe("uninstallNextSteps", () => {
    it("prints the channel that owns the binaries", () => {
        const steps: UninstallStep[] = [{ target: "runtime", paths: [RUNTIME], remove: true }];

        expect(uninstallNextSteps(steps, { installer: "npm" }).join("\n")).toContain("npm rm -g @yuez/pi2d");
        expect(uninstallNextSteps(steps, { installer: "brew" }).join("\n")).toContain("brew uninstall pi2d");
        expect(uninstallNextSteps(steps, { installer: "curl" }).join("\n")).toContain("--uninstall");
    });

    it("skips the channel command once the install tree is gone", () => {
        const steps: UninstallStep[] = [{ target: "install", paths: [PREFIX], remove: true }];
        expect(uninstallNextSteps(steps, { installer: "curl" }).join("\n")).not.toContain("install.sh");
    });
});

describe("pi2 uninstall (dispatch)", () => {
    it("maps the flags onto the runner", async () => {
        const seen: UninstallOptions[] = [];
        const code = await main(["uninstall", "--dry-run", "--purge", "--purge-config", "--keep-service", "-y"], {
            out: () => undefined,
            runtime: "/tmp/pi2-run",
            uninstall: async (options) => {
                seen.push(options);
                return 0;
            },
        });

        expect(code).toBe(0);
        expect(seen[0]).toMatchObject({
            dryRun: true,
            yes: true,
            purge: true,
            purgeConfig: true,
            keepService: true,
            runtime: "/tmp/pi2-run",
        });
    });

    it("prints the command help", async () => {
        const out: string[] = [];
        const code = await main(["uninstall", "--help"], { out: (line) => out.push(line) });

        expect(code).toBe(0);
        expect(out.join("\n")).toContain("--purge-config");
    });

    it("rejects a positional argument with the command usage", async () => {
        const err: string[] = [];
        const code = await main(["uninstall", "everything"], { err: (line) => err.push(line) });

        expect(code).toBe(2);
        expect(err.join("\n")).toContain("unexpected argument");
        expect(err.join("\n")).toContain("pi2 uninstall");
    });
});
