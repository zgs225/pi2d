import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
    defaultScriptPath,
    launchAgentDir,
    renderLaunchAgent,
    renderService,
    renderSystemdUnit,
    serviceDir,
    systemdUserDir,
    type ServicePaths,
} from "../../src/cli/service.js";
import { runInstallService, runUninstallService } from "../../src/cli/pi2.js";

const paths: ServicePaths = {
    nodePath: "/opt/node/bin/node",
    scriptPath: "/repo/dist/cli/pi2.js",
    stateDir: "/home/u/.local/state/pi2",
    homeDir: "/home/u",
    pathEnv: "/opt/node/bin:/usr/bin:/bin",
};

const LINUX_UNIT = `[Unit]
Description=pi2 daemon
After=network.target

[Service]
Type=simple
ExecStart=/opt/node/bin/node /repo/dist/cli/pi2.js daemon --foreground
Environment=PATH=/opt/node/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=default.target
`;

const MAC_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.pi2.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/node/bin/node</string>
        <string>/repo/dist/cli/pi2.js</string>
        <string>daemon</string>
        <string>--foreground</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/node/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/home/u/.local/state/pi2/pi2-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/home/u/.local/state/pi2/pi2-daemon.err.log</string>
</dict>
</plist>
`;

describe("systemd user unit", () => {
    it("renders the unit (snapshot)", () => {
        expect(renderSystemdUnit(paths)).toBe(LINUX_UNIT);
    });

    it("adds extra Environment= entries", () => {
        const unit = renderSystemdUnit({ ...paths, env: { PI2_PORT: "7676", PI2_LOG_LEVEL: "debug" } });
        expect(unit).toContain("Environment=PATH=/opt/node/bin:/usr/bin:/bin");
        expect(unit).toContain("Environment=PI2_PORT=7676");
        expect(unit).toContain("Environment=PI2_LOG_LEVEL=debug");
        expect(unit.indexOf("Environment=PI2_PORT")).toBeGreaterThan(unit.indexOf("ExecStart="));
    });

    it("quotes values with spaces", () => {
        const unit = renderSystemdUnit({ ...paths, scriptPath: "/repo dir/cli/pi2.js" });
        expect(unit).toContain('ExecStart=/opt/node/bin/node "/repo dir/cli/pi2.js" daemon --foreground');
    });

    it("targets ~/.config/systemd/user and honours XDG_CONFIG_HOME", () => {
        expect(systemdUserDir(paths)).toBe("/home/u/.config/systemd/user");
        expect(systemdUserDir({ ...paths, configHome: "/xdg" })).toBe("/xdg/systemd/user");
        const service = renderService("linux", paths);
        expect(service.path).toBe("/home/u/.config/systemd/user/pi2.service");
        expect(service.name).toBe("pi2.service");
        expect(serviceDir(service)).toBe("/home/u/.config/systemd/user");
        expect(service.commands).toEqual([
            "systemctl --user daemon-reload",
            "systemctl --user enable --now pi2.service",
        ]);
        expect(service.removeCommands).toContain("systemctl --user disable --now pi2.service");
    });
});

describe("LaunchAgent plist", () => {
    it("renders the plist (snapshot)", () => {
        expect(renderLaunchAgent(paths)).toBe(MAC_PLIST);
    });

    it("escapes XML in paths", () => {
        const plist = renderLaunchAgent({ ...paths, nodePath: "/opt/a&b/node" });
        expect(plist).toContain("<string>/opt/a&amp;b/node</string>");
    });

    it("targets ~/Library/LaunchAgents", () => {
        expect(launchAgentDir(paths)).toBe("/home/u/Library/LaunchAgents");
        const service = renderService("darwin", paths);
        expect(service.path).toBe("/home/u/Library/LaunchAgents/com.pi2.daemon.plist");
        expect(service.name).toBe("com.pi2.daemon.plist");
        expect(service.commands[0]).toContain("launchctl bootstrap gui/$(id -u)");
        expect(service.removeCommands[0]).toContain("launchctl bootout");
    });

    it("resolves dist/cli/pi2.js next to the built CLI", () => {
        expect(defaultScriptPath()).toMatch(/dist\/cli\/pi2\.js$/);
    });
});

describe("install-service / uninstall-service commands", () => {
    it("prints the unit on --dry-run and writes nothing", () => {
        const lines: string[] = [];
        const writes: string[] = [];
        const code = runInstallService({
            platform: "linux",
            paths,
            write: false,
            print: (line) => lines.push(line),
            writeFile: (path) => writes.push(path),
        });
        expect(code).toBe(0);
        expect(writes).toEqual([]);
        expect(lines.join("\n")).toContain("[Service]");
        expect(lines.join("\n")).toContain("would write /home/u/.config/systemd/user/pi2.service");
        expect(lines.join("\n")).toContain("systemctl --user enable --now pi2.service");
    });

    it("writes the unit on --write and prints the enable commands", () => {
        const lines: string[] = [];
        const writes: { path: string; content: string }[] = [];
        const code = runInstallService({
            platform: "linux",
            paths,
            write: true,
            print: (line) => lines.push(line),
            writeFile: (path, content) => writes.push({ path, content }),
        });
        expect(code).toBe(0);
        expect(writes).toEqual([{ path: join("/home/u/.config/systemd/user", "pi2.service"), content: LINUX_UNIT }]);
        expect(lines[0]).toBe("wrote /home/u/.config/systemd/user/pi2.service (mode 0644)");
        expect(lines.join("\n")).toContain("systemctl --user daemon-reload");
    });

    it("uninstall removes the unit only with --write", () => {
        const removed: string[] = [];
        const dry: string[] = [];
        expect(
            runUninstallService({
                platform: "darwin",
                paths,
                write: false,
                print: (line) => dry.push(line),
                removeFile: (path) => removed.push(path),
            }),
        ).toBe(0);
        expect(removed).toEqual([]);
        expect(dry.join("\n")).toContain("would remove /home/u/Library/LaunchAgents/com.pi2.daemon.plist");

        const lines: string[] = [];
        expect(
            runUninstallService({
                platform: "darwin",
                paths,
                write: true,
                print: (line) => lines.push(line),
                removeFile: (path) => removed.push(path),
            }),
        ).toBe(0);
        expect(removed).toEqual(["/home/u/Library/LaunchAgents/com.pi2.daemon.plist"]);
        expect(lines.join("\n")).toContain("launchctl bootout");
    });
});
