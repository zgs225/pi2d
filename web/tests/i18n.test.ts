import { describe, expect, it } from "vitest";

import en from "@/locales/en.json";
import zh from "@/locales/zh.json";

type Catalog = Record<string, string>;

function flatten(value: unknown, prefix = ""): Record<string, string> {
    if (!value || typeof value !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof child === "string") out[path] = child;
        else if (child && typeof child === "object") Object.assign(out, flatten(child, path));
    }
    return out;
}

const zhFlat = flatten(zh as Catalog);
const enFlat = flatten(en as Catalog);

describe("i18n catalogs", () => {
    it("have identical key sets", () => {
        const zhKeys = new Set(Object.keys(zhFlat));
        const enKeys = new Set(Object.keys(enFlat));
        expect([...zhKeys].filter((key) => !enKeys.has(key))).toEqual([]);
        expect([...enKeys].filter((key) => !zhKeys.has(key))).toEqual([]);
        expect(zhKeys.size).toBeGreaterThan(300);
        console.log(`i18n key parity: ${zhKeys.size} zh / ${enKeys.size} en`);
    });

    it("have a non-empty string for every key", () => {
        for (const [key, value] of Object.entries(zhFlat)) {
            expect(typeof value, key).toBe("string");
            expect(value.length, key).toBeGreaterThan(0);
        }
        for (const [key, value] of Object.entries(enFlat)) {
            expect(typeof value, key).toBe("string");
            expect(value.length, key).toBeGreaterThan(0);
        }
    });

    it("covers every prototype namespace", () => {
        for (const prefix of [
            "common.",
            "shell.",
            "language.",
            "nav.",
            "time.",
            "state.",
            "connect.",
            "workspaces.",
            "status.",
            "chat.",
        ]) {
            expect(Object.keys(zhFlat).some((key) => key.startsWith(prefix)), prefix).toBe(true);
            expect(Object.keys(enFlat).some((key) => key.startsWith(prefix)), prefix).toBe(true);
        }
        // The prototype's English plural variants are mirrored in zh for parity.
        for (const key of [
            "workspaces.count.one",
            "workspaces.count.other",
            "workspaces.sessionCount.one",
            "workspaces.sessionCount.other",
        ]) {
            expect(zhFlat[key], key).toBeTruthy();
            expect(enFlat[key], key).toBeTruthy();
        }
    });

    it("keeps the copy contract for key shell strings", () => {
        expect(zhFlat["nav.workspaces"]).toBe("工作空间");
        expect(enFlat["nav.workspaces"]).toBe("Workspaces");
        expect(zhFlat["connect.title"]).toBe("连接 pi2 服务器");
        expect(enFlat["status.title"]).toBe("Server status");
        expect(zhFlat["chat.tabSubagents"]).toBe("子代理");
        expect(enFlat["chat.tabTodo"]).toBe("Todo");
    });
});

describe("i18n runtime", () => {
    it("interpolates single-brace params and switches languages", async () => {
        const { default: i18n, plural, setLanguage } = await import("@/lib/i18n");

        await setLanguage("zh");
        expect(i18n.t("time.minutesAgo", { n: 3 })).toBe("3 分钟前");
        expect(i18n.t("shell.serverChip", { name: "ThinkPad" })).toBe("服务器：ThinkPad，查看状态");

        await setLanguage("en");
        expect(i18n.t("time.minutesAgo", { n: 3 })).toBe("3m ago");
        expect(i18n.t("shell.serverChip", { name: "ThinkPad" })).toBe("Server: ThinkPad, view status");

        await setLanguage("zh");
        expect(plural("workspaces.count", 2)).toBe("2 个工作空间");
        expect(plural("workspaces.sessionCount", 1)).toBe("1 个会话");

        await setLanguage("en");
        expect(plural("workspaces.count", 2)).toBe("2 workspaces");
        expect(plural("workspaces.count", 1)).toBe("1 workspace");
    });
});
