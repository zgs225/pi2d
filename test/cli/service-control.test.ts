import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
    formatServiceStatus,
    parseServiceArgs,
    runServiceCommand,
    serviceArgv,
    serviceContext,
    serviceStatus,
    serviceUnit,
    type ExecResult,
    type ServiceControlOptions,
} from "../../src/cli/service-control.js";
import { LAUNCHD_LABEL, SYSTEMD_UNIT_NAME, type ServicePaths } from "../../src/cli/service.js";
import { main } from "../../src/cli/pi2.js";
import { CliError, UsageError } from "../../src/cli/util.js";

const paths: ServicePaths = {
    bundled: true,
    execPath: "/usr/local/bin/pi2",
    envFile: "-%h/.config/pi2/env",
    stateDir: "/home/u/.local/state/pi2",
    homeDir: "/home/u",
    pathEnv: "/usr/local/bin:/usr/bin:/bin",
};

const linux = serviceContext({ platform: "linux", paths, uid: 1000, user: "u" });
const darwin = serviceContext({ platform: "darwin", paths, uid: 501, user: "u" });

const OK: ExecResult = { code: 0, stdout: "", stderr: "" };

/** `exec` stub: a map from the exact argv (joined by spaces) to a result. */
function execMap(map: Record<string, ExecResult>): (argv: string[]) => ExecResult {
    return (argv: string[]) => {
        const key = argv.join(" ");
        const hit = map[key];
        if (hit !== undefined) {
            return hit;
        }
        throw new Error(`unexpected command: ${key}`);
    };
}

describe("serviceArgv", () => {
    it("maps every action on systemd", () => {
        expect(serviceArgv("start", linux)).toEqual([["systemctl", "--user", "start", SYSTEMD_UNIT_NAME]]);
        expect(serviceArgv("stop", linux)).toEqual([["systemctl", "--user", "stop", SYSTEMD_UNIT_NAME]]);
        expect(serviceArgv("enable", linux)).toEqual([
            ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME],
        ]);
        expect(serviceArgv("disable", linux)).toEqual([
            ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME],
        ]);
        expect(serviceArgv("status", linux)).toEqual([]);
    });

    it("maps every action on launchd", () => {
        const target = `gui/501/${LAUNCHD_LABEL}`;
        const plist = join(paths.homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
        expect(serviceArgv("start", darwin)).toEqual([["launchctl", "kickstart", "-k", target]]);
        expect(serviceArgv("stop", darwin)).toEqual([["launchctl", "kill", "TERM", target]]);
        expect(serviceArgv("enable", darwin)).toEqual([
            ["launchctl", "bootstrap", "gui/501", plist],
            ["launchctl", "enable", target],
        ]);
        expect(serviceArgv("disable", darwin)).toEqual([["launchctl", "bootout", "gui/501"]]);
    });

    it("puts the unit under the platform config dir", () => {
        expect(serviceUnit(linux)).toEqual({
            name: SYSTEMD_UNIT_NAME,
            path: join(paths.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT_NAME),
        });
        expect(serviceUnit(darwin).path).toBe(
            join(paths.homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
        );
    });
});

describe("serviceStatus", () => {
    const unitPath = join(paths.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
    const base: ServiceControlOptions = {
        platform: "linux",
        paths,
        uid: 1000,
        user: "u",
        exists: () => true,
    };

    it("reports an enabled, active unit with linger on", () => {
        const status = serviceStatus({
            ...base,
            exec: execMap({
                "systemctl --version": { code: 0, stdout: "systemd 255", stderr: "" },
                [`systemctl --user is-enabled ${SYSTEMD_UNIT_NAME}`]: { code: 0, stdout: "enabled", stderr: "" },
                [`systemctl --user is-active ${SYSTEMD_UNIT_NAME}`]: { code: 0, stdout: "active", stderr: "" },
                "loginctl show-user u -p Linger": { code: 0, stdout: "Linger=yes\n", stderr: "" },
            }),
        });
        expect(status).toEqual({
            platform: "linux",
            manager: "systemd",
            unit: { name: SYSTEMD_UNIT_NAME, path: unitPath, installed: true },
            enabled: true,
            active: true,
            linger: true,
            error: null,
        });
    });

    it("reports a disabled, inactive unit and keeps exit 0 semantics", async () => {
        const status = serviceStatus({
            ...base,
            exec: execMap({
                "systemctl --version": { code: 0, stdout: "systemd 255", stderr: "" },
                [`systemctl --user is-enabled ${SYSTEMD_UNIT_NAME}`]: { code: 1, stdout: "disabled", stderr: "" },
                [`systemctl --user is-active ${SYSTEMD_UNIT_NAME}`]: { code: 3, stdout: "inactive", stderr: "" },
                "loginctl show-user u -p Linger": { code: 0, stdout: "Linger=no\n", stderr: "" },
            }),
        });
        expect(status.enabled).toBe(false);
        expect(status.active).toBe(false);
        expect(status.linger).toBe(false);

        const out: string[] = [];
        const code = await runServiceCommand("status", {
            ...base,
            print: (line) => out.push(line),
            json: true,
        });
        expect(code).toBe(0);
        const decoded = JSON.parse(out.join("\n")) as Record<string, unknown>;
        expect(decoded.manager).toBe("systemd");
        expect(decoded.unit).toMatchObject({ name: SYSTEMD_UNIT_NAME, path: unitPath });
    });

    it("degrades to manager \"none\" when systemctl is unavailable", () => {
        const status = serviceStatus({
            ...base,
            exists: () => false,
            exec: () => ({ code: 127, stdout: "", stderr: "spawnSync systemctl ENOENT" }),
        });
        expect(status.manager).toBe("none");
        expect(status.enabled).toBeNull();
        expect(status.active).toBeNull();
        expect(status.linger).toBeNull();
        expect(status.error).toContain("ENOENT");
        expect(status.unit.installed).toBe(false);
    });

    it("probes launchd through `launchctl print`", () => {
        const plist = join(paths.homeDir, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
        const status = serviceStatus({
            platform: "darwin",
            paths,
            uid: 501,
            exists: (path) => path === plist,
            exec: execMap({
                [`launchctl print gui/501/${LAUNCHD_LABEL}`]: { code: 0, stdout: "state = running", stderr: "" },
            }),
        });
        expect(status.manager).toBe("launchd");
        expect(status.unit.installed).toBe(true);
        expect(status.enabled).toBe(true);
        expect(status.active).toBe(true);
        expect(status.linger).toBeNull();
    });
});

describe("formatServiceStatus", () => {
    it("suggests install then enable when the unit is missing", () => {
        const lines = formatServiceStatus({
            platform: "linux",
            manager: "systemd",
            unit: { name: SYSTEMD_UNIT_NAME, path: "/home/u/.config/systemd/user/pi2.service", installed: false },
            enabled: null,
            active: null,
            linger: null,
            error: null,
        });
        expect(lines.join("\n")).toContain("pi2 install-service --write, then pi2 service enable");
        expect(lines.join("\n")).toContain("(missing)");
    });

    it("suggests enable when the unit exists but is not running", () => {
        const lines = formatServiceStatus({
            platform: "darwin",
            manager: "launchd",
            unit: { name: `${LAUNCHD_LABEL}.plist`, path: "/x.plist", installed: true },
            enabled: true,
            active: false,
            linger: null,
            error: null,
        });
        const text = lines.join("\n");
        expect(text).toContain("# next: pi2 service enable");
        expect(text).not.toContain("linger");
    });
});

describe("runServiceCommand", () => {
    const unitPath = join(paths.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
    const out: string[] = [];

    it("refuses to start a service that was never installed", async () => {
        await expect(
            runServiceCommand("start", {
                platform: "linux",
                paths,
                print: () => {},
                exists: () => false,
            }),
        ).rejects.toBeInstanceOf(CliError);
    });

    it("runs the mapped commands for `enable`", async () => {
        const ran: string[][] = [];
        const code = await runServiceCommand("enable", {
            platform: "linux",
            paths,
            print: (line) => out.push(line),
            exists: () => true,
            exec: (argv) => {
                ran.push(argv);
                return OK;
            },
        });
        expect(code).toBe(0);
        expect(ran).toEqual([["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME]]);
        expect(out.join("\n")).toContain("service enable: systemctl --user enable --now pi2.service");
    });

    it("turns a manager refusal into a CliError with its own first line", async () => {
        const error = await runServiceCommand("start", {
            platform: "linux",
            paths,
            print: () => {},
            exists: () => true,
            exec: () => ({
                code: 1,
                stdout: "",
                stderr: "Failed to start pi2.service: Unit pi2.service not found.\nmore",
            }),
        }).catch((err: unknown) => err);
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).message).toContain("Unit pi2.service not found.");
        expect((error as CliError).message).toContain("systemctl --user start pi2.service");
    });

    it("mentions the still-enabled unit after a stop", async () => {
        const notes: string[] = [];
        await runServiceCommand("stop", {
            platform: "linux",
            paths,
            print: (line) => notes.push(line),
            exists: () => true,
            exec: () => OK,
        });
        expect(notes.join("\n")).toContain("pi2 service disable");
    });
});

describe("parseServiceArgs", () => {
    it("defaults to status and accepts --json", () => {
        expect(parseServiceArgs([])).toEqual({ action: "status", json: false, help: false });
        expect(parseServiceArgs(["--json"])).toEqual({ action: "status", json: true, help: false });
        expect(parseServiceArgs(["start"]).action).toBe("start");
    });

    it("rejects unknown actions, extra positionals and --json on a mutating action", () => {
        expect(() => parseServiceArgs(["frobnicate"])).toThrow(UsageError);
        expect(() => parseServiceArgs(["start", "extra"])).toThrow(UsageError);
        expect(() => parseServiceArgs(["start", "--json"])).toThrow(UsageError);
    });
});

describe("pi2 service (dispatch)", () => {
    function collect(): { out: string[]; err: string[] } {
        return { out: [], err: [] };
    }

    it("prints the JSON report and exits 0 with no unit installed", async () => {
        const sink = collect();
        const unit = join(paths.homeDir, ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
        const code = await main(["service", "status", "--json"], {
            out: (line) => sink.out.push(line),
            err: (line) => sink.err.push(line),
            platform: "linux",
            servicePaths: paths,
            serviceUid: 1000,
            serviceUser: "u",
            serviceExists: () => false,
            serviceExec: (argv) => {
                const key = argv.join(" ");
                if (key === "systemctl --version") {
                    return { code: 0, stdout: "systemd 255", stderr: "" };
                }
                if (key.startsWith("systemctl --user is-enabled")) {
                    return { code: 1, stdout: "disabled", stderr: "" };
                }
                if (key.startsWith("systemctl --user is-active")) {
                    return { code: 3, stdout: "inactive", stderr: "" };
                }
                if (key.startsWith("loginctl show-user")) {
                    return { code: 0, stdout: "Linger=no", stderr: "" };
                }
                throw new Error(`unexpected: ${key}`);
            },
        });
        expect(code).toBe(0);
        const decoded = JSON.parse(sink.out.join("\n")) as { unit: { path: string; installed: boolean } };
        expect(decoded.unit).toEqual({ name: SYSTEMD_UNIT_NAME, path: unit, installed: false });
    });

    it("maps a failing start to exit code 1", async () => {
        const sink = collect();
        const code = await main(["service", "start"], {
            out: (line) => sink.out.push(line),
            err: (line) => sink.err.push(line),
            platform: "linux",
            servicePaths: paths,
            serviceExists: () => true,
            serviceExec: () => ({ code: 1, stdout: "", stderr: "Job failed. See system logs." }),
        });
        expect(code).toBe(1);
        expect(sink.err.join("\n")).toContain("Job failed. See system logs.");
    });

    it("prints usage for an unknown action (exit 2)", async () => {
        const sink = collect();
        const code = await main(["service", "wat"], {
            out: (line) => sink.out.push(line),
            err: (line) => sink.err.push(line),
            platform: "linux",
            servicePaths: paths,
        });
        expect(code).toBe(2);
        expect(sink.err.join("\n")).toContain("unknown service action");
    });

    it("documents itself in `pi2 --help`", async () => {
        const sink = collect();
        await main(["--help"], { out: (line) => sink.out.push(line), err: (line) => sink.err.push(line) });
        expect(sink.out.join("\n")).toContain("pi2 service status|start|stop|enable|disable");
    });
});
