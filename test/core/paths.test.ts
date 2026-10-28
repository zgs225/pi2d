import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { piAgentDir, sessionsRoot } from "../../src/core/paths.js";

describe("piAgentDir and sessionsRoot", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("prefers PI2_CODING_AGENT_DIR when both PI2_ and PI_ are set", () => {
        const env = {
            PI2_CODING_AGENT_DIR: "/custom/pi2/agent",
            PI_CODING_AGENT_DIR: "/custom/pi/agent",
        };
        expect(piAgentDir(env)).toBe("/custom/pi2/agent");
        expect(sessionsRoot(env)).toBe(join("/custom/pi2/agent", "sessions"));
    });

    it("uses PI_CODING_AGENT_DIR when PI2_CODING_AGENT_DIR is unset", () => {
        const env = {
            PI_CODING_AGENT_DIR: "/custom/pi/agent",
        };
        expect(piAgentDir(env)).toBe("/custom/pi/agent");
        expect(sessionsRoot(env)).toBe(join("/custom/pi/agent", "sessions"));
    });

    it("falls back to ~/.pi/agent when neither variable is set", () => {
        const env = {};
        const expected = join(homedir(), ".pi", "agent");
        expect(piAgentDir(env)).toBe(expected);
        expect(piAgentDir(env).endsWith(join(".pi", "agent"))).toBe(true);
        expect(sessionsRoot(env)).toBe(join(expected, "sessions"));
    });

    it("falls through empty strings to the next candidate", () => {
        // PI2 is empty string -> falls through to PI
        expect(
            piAgentDir({
                PI2_CODING_AGENT_DIR: "",
                PI_CODING_AGENT_DIR: "/custom/pi/agent",
            }),
        ).toBe("/custom/pi/agent");

        // Both are empty strings -> falls through to ~/.pi/agent
        const expected = join(homedir(), ".pi", "agent");
        expect(
            piAgentDir({
                PI2_CODING_AGENT_DIR: "",
                PI_CODING_AGENT_DIR: "",
            }),
        ).toBe(expected);

        // PI2 unset, PI is empty string -> falls through to ~/.pi/agent
        expect(
            piAgentDir({
                PI_CODING_AGENT_DIR: "",
            }),
        ).toBe(expected);
    });

    it("handles relative paths without crashing", () => {
        const relative = "some/relative/agent";
        expect(piAgentDir({ PI2_CODING_AGENT_DIR: relative })).toBe(relative);
        expect(sessionsRoot({ PI2_CODING_AGENT_DIR: relative })).toBe(join(relative, "sessions"));

        expect(piAgentDir({ PI_CODING_AGENT_DIR: relative })).toBe(relative);
        expect(sessionsRoot({ PI_CODING_AGENT_DIR: relative })).toBe(join(relative, "sessions"));
    });

    it("respects daemon ambient environment injection via process.env", () => {
        delete process.env.PI2_CODING_AGENT_DIR;
        delete process.env.PI_CODING_AGENT_DIR;

        process.env.PI2_CODING_AGENT_DIR = "/daemon/injected/pi2";
        expect(piAgentDir()).toBe("/daemon/injected/pi2");
        expect(sessionsRoot()).toBe(join("/daemon/injected/pi2", "sessions"));

        process.env.PI_CODING_AGENT_DIR = "/daemon/injected/pi";
        // PI2 still wins
        expect(piAgentDir()).toBe("/daemon/injected/pi2");

        // When PI2 is empty string in process.env, falls through to PI
        process.env.PI2_CODING_AGENT_DIR = "";
        expect(piAgentDir()).toBe("/daemon/injected/pi");

        // When both are empty string in process.env, falls through to default
        process.env.PI_CODING_AGENT_DIR = "";
        expect(piAgentDir()).toBe(join(homedir(), ".pi", "agent"));
    });
});
