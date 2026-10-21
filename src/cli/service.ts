/**
 * Service file rendering for `pi2 install-service` / `uninstall-service`.
 *
 * Pure string generation: nothing here executes a command. `--dry-run` prints
 * the rendered file, `--write` writes it (0644) and prints the enable/load
 * commands for the user to run — the CLI never talks to systemd or launchd.
 */
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stateDir } from "../core/paths.js";

export type ServicePlatform = "linux" | "darwin";

export interface ServicePaths {
    /** Absolute node binary (`process.execPath`). */
    nodePath: string;
    /** Absolute path to `dist/cli/pi2d.js`. */
    scriptPath: string;
    /** Where logs go (plist StandardOut/ErrPath). */
    stateDir: string;
    /** Home dir; the unit file lives under it. */
    homeDir: string;
    /** `XDG_CONFIG_HOME` override for the systemd user dir. */
    configHome?: string;
    /** PATH the service should see (defaults to `process.env.PATH`). */
    pathEnv?: string;
    /** Extra `Environment=` entries (e.g. `{PI2_PORT: "7676"}`). */
    env?: Record<string, string>;
}

export interface RenderedService {
    /** `pi2d.service` on Linux, `com.pi2.pi2d.plist` on macOS. */
    name: string;
    /** Absolute install path. */
    path: string;
    content: string;
    /** Commands the user must run (printed, never executed). */
    commands: string[];
    /** Commands that undo the install (printed on uninstall). */
    removeCommands: string[];
}

export const SYSTEMD_UNIT_NAME = "pi2d.service";
export const LAUNCHD_LABEL = "com.pi2.pi2d";
export const LAUNCHD_PLIST_NAME = `${LAUNCHD_LABEL}.plist`;

/** `<repo>/dist/cli/pi2d.js`, resolved from either `src/cli/` or `dist/cli/`. */
export function defaultScriptPath(): string {
    return fileURLToPath(new URL("../../dist/cli/pi2d.js", import.meta.url));
}

export function defaultServicePaths(overrides: Partial<ServicePaths> = {}): ServicePaths {
    return {
        nodePath: process.execPath,
        scriptPath: defaultScriptPath(),
        stateDir: stateDir(),
        homeDir: homedir(),
        ...(process.env.XDG_CONFIG_HOME === undefined ? {} : { configHome: process.env.XDG_CONFIG_HOME }),
        pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ...overrides,
    };
}

export function systemdUserDir(paths: ServicePaths): string {
    const configHome = paths.configHome ?? join(paths.homeDir, ".config");
    return join(configHome, "systemd", "user");
}

export function launchAgentDir(paths: ServicePaths): string {
    return join(paths.homeDir, "Library", "LaunchAgents");
}

function systemdQuote(value: string): string {
    if (/[\s"'\\]/.test(value)) return `"${value.replace(/(["\\])/g, "\\$1")}"`;
    return value;
}

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function environmentEntries(paths: ServicePaths): [string, string][] {
    const entries: [string, string][] = [];
    if (paths.pathEnv !== undefined && paths.pathEnv !== "") entries.push(["PATH", paths.pathEnv]);
    for (const [key, value] of Object.entries(paths.env ?? {})) entries.push([key, value]);
    return entries;
}

export function renderSystemdUnit(paths: ServicePaths): string {
    const env = environmentEntries(paths).map(([key, value]) => `Environment=${key}=${systemdQuote(value)}`);
    return [
        "[Unit]",
        "Description=pi2 daemon (pi2d)",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${systemdQuote(paths.nodePath)} ${systemdQuote(paths.scriptPath)} --foreground`,
        ...env,
        "Restart=on-failure",
        "RestartSec=2",
        "KillSignal=SIGTERM",
        "TimeoutStopSec=15",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
}

export function renderLaunchAgent(paths: ServicePaths): string {
    const env = environmentEntries(paths);
    const envBlock =
        env.length === 0
            ? []
            : [
                  "    <key>EnvironmentVariables</key>",
                  "    <dict>",
                  ...env.flatMap(([key, value]) => [
                      `        <key>${xmlEscape(key)}</key>`,
                      `        <string>${xmlEscape(value)}</string>`,
                  ]),
                  "    </dict>",
              ];
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        `    <key>Label</key>`,
        `    <string>${LAUNCHD_LABEL}</string>`,
        "    <key>ProgramArguments</key>",
        "    <array>",
        `        <string>${xmlEscape(paths.nodePath)}</string>`,
        `        <string>${xmlEscape(paths.scriptPath)}</string>`,
        "        <string>--foreground</string>",
        "    </array>",
        ...envBlock,
        "    <key>RunAtLoad</key>",
        "    <true/>",
        "    <key>KeepAlive</key>",
        "    <true/>",
        "    <key>StandardOutPath</key>",
        `    <string>${xmlEscape(join(paths.stateDir, "pi2d.log"))}</string>`,
        "    <key>StandardErrorPath</key>",
        `    <string>${xmlEscape(join(paths.stateDir, "pi2d.err.log"))}</string>`,
        "</dict>",
        "</plist>",
        "",
    ].join("\n");
}

export function renderService(platform: ServicePlatform, paths: ServicePaths): RenderedService {
    if (platform === "darwin") {
        const target = join(launchAgentDir(paths), LAUNCHD_PLIST_NAME);
        return {
            name: LAUNCHD_PLIST_NAME,
            path: target,
            content: renderLaunchAgent(paths),
            commands: [
                `launchctl bootstrap gui/$(id -u) ${target}`,
                `launchctl enable gui/$(id -u)/${LAUNCHD_LABEL}`,
                `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`,
            ],
            removeCommands: [`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`, `rm -f ${target}`],
        };
    }
    const target = join(systemdUserDir(paths), SYSTEMD_UNIT_NAME);
    return {
        name: SYSTEMD_UNIT_NAME,
        path: target,
        content: renderSystemdUnit(paths),
        commands: ["systemctl --user daemon-reload", `systemctl --user enable --now ${SYSTEMD_UNIT_NAME}`],
        removeCommands: [`systemctl --user disable --now ${SYSTEMD_UNIT_NAME}`, `rm -f ${target}`],
    };
}

/** Directory that must exist before writing the file. */
export function serviceDir(service: RenderedService): string {
    return dirname(service.path);
}
