import { describe, expect, it } from "vitest";

import appCss from "@/styles/app.css?raw";
import tokensCss from "@/styles/tokens.css?raw";

function block(source: string, selector: string): string {
    const start = source.indexOf(selector);
    expect(start, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
    const open = source.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === "{") depth += 1;
        if (source[i] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, i);
        }
    }
    throw new Error(`unclosed block ${selector}`);
}

function customProps(source: string): Record<string, string> {
    const props: Record<string, string> = {};
    for (const match of source.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
        const name = match[1];
        const value = match[2];
        if (name && value) props[name] = value.trim();
    }
    return props;
}

describe("design tokens", () => {
    const light = customProps(block(tokensCss, ":root"));
    const dark = customProps(block(tokensCss, 'html[data-theme="dark"]'));

    it("defines the contract's semantic token names in :root", () => {
        for (const name of [
            "background",
            "foreground",
            "card",
            "card-foreground",
            "popover",
            "muted",
            "muted-foreground",
            "accent",
            "primary",
            "primary-foreground",
            "secondary",
            "destructive",
            "border",
            "input",
            "ring",
            "sidebar",
            "sidebar-foreground",
            "sidebar-accent",
            "role-user",
            "role-agent",
            "role-thinking",
            "role-error",
            "ok",
            "warn",
            "err",
            "info",
            "radius-sm",
            "radius",
            "radius-lg",
            "space-1",
            "space-8",
            "font-sans",
            "font-mono",
            "topbar-h",
            "sidebar-w",
            "rail-w",
            "tabbar-h",
        ]) {
            expect(light[name], `--${name}`).toBeTruthy();
        }
    });

    it("overrides the same surfaces in the dark data-theme block", () => {
        expect(light.background).toBe("oklch(0.985 0.004 90)");
        expect(dark.background).toBe("oklch(0.145 0.008 60)");
        expect(light.foreground).not.toBe(dark.foreground);
        for (const name of ["background", "foreground", "card", "muted", "muted-foreground", "primary", "border", "input", "ok", "warn", "role-user", "role-agent", "role-thinking"]) {
            expect(dark[name], `--${name} dark override`).toBeTruthy();
        }
        // Dark borders are translucent white per the contract.
        expect(dark.border).toContain("oklch(1 0 0");
    });

    it("maps every semantic token to a Tailwind color utility", () => {
        const theme = block(appCss, "@theme inline");
        const mapped = customProps(theme);
        const expected: Record<string, string> = {
            "color-background": "--background",
            "color-foreground": "--foreground",
            "color-card": "--card",
            "color-card-foreground": "--card-foreground",
            "color-popover": "--popover",
            "color-muted": "--muted",
            "color-muted-foreground": "--muted-foreground",
            "color-accent": "--accent",
            "color-primary": "--primary",
            "color-primary-foreground": "--primary-foreground",
            "color-secondary": "--secondary",
            "color-destructive": "--destructive",
            "color-border": "--border",
            "color-input": "--input",
            "color-ring": "--ring",
            "color-sidebar": "--sidebar",
            "color-sidebar-foreground": "--sidebar-foreground",
            "color-sidebar-accent": "--sidebar-accent",
            "color-role-user": "--role-user",
            "color-role-agent": "--role-agent",
            "color-role-thinking": "--role-thinking",
            "color-role-error": "--role-error",
            "color-ok": "--ok",
            "color-warn": "--warn",
            "color-err": "--err",
            "color-info": "--info",
        };
        for (const [utility, token] of Object.entries(expected)) {
            expect(mapped[utility], `--${utility}`).toBe(`var(${token})`);
        }
        expect(appCss).toContain("@custom-variant dark");
    });

    it("switches computed values with data-theme", () => {
        const style = document.createElement("style");
        style.textContent = tokensCss;
        document.head.appendChild(style);

        document.documentElement.dataset.theme = "light";
        expect(getComputedStyle(document.documentElement).getPropertyValue("--background").trim()).toBe(
            "oklch(0.985 0.004 90)",
        );

        document.documentElement.dataset.theme = "dark";
        expect(getComputedStyle(document.documentElement).getPropertyValue("--background").trim()).toBe(
            "oklch(0.145 0.008 60)",
        );

        style.remove();
    });
});
