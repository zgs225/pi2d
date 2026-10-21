import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, type Harness } from "./harness.js";

describe("static file surface", () => {
    let h: Harness;
    let token: string;

    beforeEach(async () => {
        h = await createHarness();
        token = h.createToken();
    });

    afterEach(async () => {
        await h.cleanup();
    });

    it("serves index.html with no-store", async () => {
        const res = await fetch(`${h.url}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).toContain("<div id=app>");
    });

    it("serves hashed assets with immutable caching", async () => {
        const res = await fetch(`${h.url}/assets/app-abc123.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/javascript");
        expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
        expect(await res.text()).toBe("console.log('pi2');");
    });

    it("falls back to index.html for SPA routes", async () => {
        const res = await fetch(`${h.url}/sessions/s1/deep/route`);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(await res.text()).toContain("<div id=app>");
    });

    it("returns 404 for a missing asset with an extension", async () => {
        const res = await fetch(`${h.url}/assets/missing-deadbeef.js`);
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain("<div id=app>");
    });

    it("does not serve files outside staticDir", async () => {
        writeFileSync(join(h.dir, "secret.txt"), "TOP-SECRET");
        const attempts = [
            `${h.url}/%2e%2e/secret.txt`,
            `${h.url}/assets/%2e%2e/%2e%2e/secret.txt`,
            `${h.url}/..%2F..%2Fsecret.txt`,
        ];
        for (const url of attempts) {
            const res = await fetch(url);
            expect(res.status).toBe(404);
            expect(await res.text()).not.toContain("TOP-SECRET");
        }
    });

    it("never falls back to index for /api or /ws", async () => {
        const api = await fetch(`${h.url}/api/v1/does-not-exist`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        expect(api.status).toBe(404);
        expect(await api.text()).not.toContain("<div id=app>");

        const ws = await fetch(`${h.url}/ws`);
        expect(ws.status).toBe(404);
        expect(await ws.text()).not.toContain("<div id=app>");
    });

    it("rejects missing files that look like files", async () => {
        const res = await fetch(`${h.url}/missing.json`);
        expect(res.status).toBe(404);
    });

    it("supports HEAD but rejects other methods", async () => {
        const head = await fetch(`${h.url}/`, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-type")).toContain("text/html");
        expect(await head.text()).toBe("");

        const post = await fetch(`${h.url}/`, { method: "POST" });
        expect(post.status).toBe(405);
        const body = (await post.json()) as { code: string };
        expect(body.code).toBe("E_METHOD_NOT_ALLOWED");
    });
});
