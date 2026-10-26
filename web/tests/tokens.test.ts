import { describe, expect, it } from "vitest";

import appCss from "@/styles/app.css?raw";
import tokensCss from "@/styles/tokens.css?raw";

function block(source: string, selector: string): string {
    // Strip comments first: the file header mentions `html[data-theme="dark"]`,
    // which would otherwise make `indexOf` land inside the header and return `:root`.
    const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
    const start = text.indexOf(selector);
    expect(start, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
    const open = text.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
        if (text[i] === "{") depth += 1;
        if (text[i] === "}") {
            depth -= 1;
            if (depth === 0) return text.slice(open + 1, i);
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
            // v0.1.1 additions (pi2-web-ui-design CHG-2026-10-23-01 / -04 / -20)
            "faint",
            "border-subtle",
            "surface-1",
            "surface-2",
            "overlay",
            "focus-ring",
            "fs-2xs",
            "fs-body",
            "fs-xl",
            "fw-strong",
            "radius-pill",
            "reading-max",
            "dur-fast",
            "ease-out",
        ]) {
            expect(light[name], `--${name}`).toBeTruthy();
        }
        // CHG-2026-10-26-20 removed the mobile tabbar; the token must be gone.
        expect(light["tabbar-h"]).toBeUndefined();
        expect(dark["tabbar-h"]).toBeUndefined();
    });

    it("overrides the same surfaces in the dark data-theme block", () => {
        expect(light.background).toBe("oklch(0.987 0.003 85)");
        expect(dark.background).toBe("oklch(0.148 0.006 65)");
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
            "oklch(0.987 0.003 85)",
        );

        document.documentElement.dataset.theme = "dark";
        expect(getComputedStyle(document.documentElement).getPropertyValue("--background").trim()).toBe(
            "oklch(0.148 0.006 65)",
        );

        style.remove();
    });
});
