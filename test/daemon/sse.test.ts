import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeWorkspaceInfo } from "./fakes.js";
import { createHarness, type Harness } from "./harness.js";

describe("SSE fallback", () => {
    let h: Harness;
    let token: string;

    beforeEach(async () => {
        h = await createHarness({
            workspaces: [makeWorkspaceInfo("ws-1")],
            seedInstances: ["ws-1"],
            config: { corsOrigins: ["http://allowed.test"] },
        });
        token = h.createToken();
    });

    afterEach(async () => {
        await h.cleanup();
    });

    async function readUntil(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        needle: string,
        timeoutMs = 2000,
    ): Promise<string> {
        const decoder = new TextDecoder();
        let text = "";
        const deadline = Date.now() + timeoutMs;
        while (!text.includes(needle)) {
            if (Date.now() > deadline) throw new Error(`timeout waiting for ${needle}; got ${text}`);
            const result = await Promise.race([
                reader.read(),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read timeout")), timeoutMs)),
            ]);
            if (result.done) break;
            text += decoder.decode(result.value, { stream: true });
        }
        return text;
    }

    it("requires a valid token and origin", async () => {
        const missing = await fetch(`${h.url}/events`);
        expect(missing.status).toBe(401);

        const bad = await fetch(`${h.url}/events?token=nope`);
        expect(bad.status).toBe(401);

        const badOrigin = await fetch(`${h.url}/events?token=${token}`, {
            headers: { Origin: "http://evil.test" },
        });
        expect(badOrigin.status).toBe(403);
    });

    it("streams only the requested session's events", async () => {
        const controller = new AbortController();
        const res = await fetch(`${h.url}/events?token=${encodeURIComponent(token)}&sessionId=s1`, {
            signal: controller.signal,
            headers: { Origin: "http://allowed.test" },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");
        expect(res.headers.get("access-control-allow-origin")).toBe("http://allowed.test");

        const reader = res.body!.getReader();
        await new Promise((resolve) => setTimeout(resolve, 50));

        h.bus.publish({ v: 1, type: "event", workspaceId: "ws-1", sessionId: "s2", epoch: "i-ws-1", seq: 1, payload: {} });
        h.bus.publish({
            v: 1,
            type: "event",
            workspaceId: "ws-1",
            sessionId: "s1",
            epoch: "i-ws-1",
            seq: 2,
            payload: { event: { type: "agent_start", ts: 1 } },
        });

        const text = await readUntil(reader, '"sessionId":"s1"');
        expect(text).toContain('"sessionId":"s1"');
        expect(text).not.toContain('"sessionId":"s2"');
        controller.abort();
        await reader.cancel().catch(() => undefined);
    });
});
