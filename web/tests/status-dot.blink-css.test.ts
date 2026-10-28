import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import appCss from "@/styles/app.css?raw";
import chatCss from "@/styles/pages/chat.css?raw";
import { cn } from "@/lib/utils";

/**
 * The CSS half of the blink contract.
 *
 * `session-dot.test.ts` pins *which* dots ask to blink (`DotView.blink`);
 * this file pins that the stylesheet honours exactly that request and nothing
 * else. The bug it guards: the animation used to be keyed on the colour class
 * *and* on the component wrapper —
 *
 *     html[data-pi-blink-fast="dim"] .tree-row .dot--ok { opacity: .35; }
 *     .dot--busy { animation: … }   /* global, unacknowledgeable *\/
 *
 * — so green blinked only in the session list, busy/err blazed everywhere, and
 * a dot could not opt out. The fix keeps exactly two dim rules, keyed on the
 * blink class alone.
 *
 * jsdom 30 runs a real specificity/attribute-selector cascade for
 * `getComputedStyle` against injected `<style>` sheets, so these assertions are
 * browser truth rather than a text grep. (The `@import`s are stripped because
 * jsdom cannot resolve them against `about:blank`; the imported token sheet
 * only supplies colours, never opacity.)
 */

/** `@import "tailwindcss";` / `@import "./tokens.css";` — jsdom cannot fetch them. */
function stripImports(source: string): string {
    return source.replace(/^[ \t]*@import[^;\n]*;[ \t]*$/gm, "");
}

/** Whitespace-insensitive view of a sheet, for "the rule still says X" checks. */
function compact(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function escapeRe(literal: string): string {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DIM_FAST = 'html[data-pi-blink-fast="dim"]';
const DIM_SLOW = 'html[data-pi-blink-slow="dim"]';

/** The two (and only two) dim selectors, exactly as they must read in `app.css`. */
const BLINK_SELECTORS = `${DIM_FAST} .dot--blink-fast, ${DIM_SLOW} .dot--blink-slow`;

let style: HTMLStyleElement;
let host: HTMLElement;

beforeAll(() => {
    style = document.createElement("style");
    style.textContent = `${stripImports(appCss)}\n${stripImports(chatCss)}`;
    document.head.appendChild(style);
});

afterAll(() => {
    style.remove();
});

beforeEach(() => {
    // Phase attributes are global state on the shared jsdom document; `blink.test.ts`
    // asserts on them and the suite runs with `isolate: false`, so start clean.
    clearPhases();
    host = document.createElement("div");
    host.className = "blink-css-host";
    document.body.appendChild(host);
});

afterEach(() => {
    clearPhases();
    host.remove();
});

function clearPhases(): void {
    document.documentElement.removeAttribute("data-pi-blink-fast");
    document.documentElement.removeAttribute("data-pi-blink-slow");
}

function setPhase({ fast, slow }: { fast?: "on" | "dim"; slow?: "on" | "dim" } = {}): void {
    clearPhases();
    if (fast) document.documentElement.setAttribute("data-pi-blink-fast", fast);
    if (slow) document.documentElement.setAttribute("data-pi-blink-slow", slow);
}

/**
 * Mount a dot the way `StatusDot` renders one (`cn("dot", DOT_CLASS[status],
 * BLINK_CLASS[blink])`), optionally inside `.tree-row` — the wrapper the old
 * rule scoped on.
 */
function mountDot(classes: string[], { inTreeRow = false }: { inTreeRow?: boolean } = {}): HTMLElement {
    const dot = document.createElement("span");
    dot.className = cn("dot", ...classes);
    if (inTreeRow) {
        const row = document.createElement("div");
        row.className = "tree-row";
        row.appendChild(dot);
        host.appendChild(row);
    } else {
        host.appendChild(dot);
    }
    return dot;
}

/** Computed opacity, or `NaN` when the sheet never applies one. */
function opacityOf(el: HTMLElement): number {
    return Number.parseFloat(getComputedStyle(el).opacity);
}

const DIM = 0.35;
const SOLID = 1;

describe("blink CSS: the stylesheet defines exactly one dim contract", () => {
    /** The single `data-pi-blink-*` rule, split into selector list and body. */
    function blinkRule() {
        const css = compact(appCss);
        const start = css.indexOf(DIM_FAST);
        expect(start, "missing the dim rule").toBeGreaterThanOrEqual(0);
        const open = css.indexOf("{", start);
        const close = css.indexOf("}", open);
        return {
            css,
            selectors: css.slice(start, open).trim(),
            body: css.slice(open + 1, close).trim(),
        };
    }

    it("keeps the two blink rules verbatim in app.css (no silent rename)", () => {
        const { selectors, body } = blinkRule();
        expect(selectors).toBe(BLINK_SELECTORS);
        expect(body.replace(/\s+/g, "")).toBe("opacity:.35;");
    });

    it("keys both dim rules on the blink class alone (no colour class, no wrapper)", () => {
        const { css, selectors } = blinkRule();
        // Exactly one rule mentions either clock attribute…
        expect(css.match(/data-pi-blink-fast="dim"/g)).toHaveLength(1);
        expect(css.match(/data-pi-blink-slow="dim"/g)).toHaveLength(1);
        // …and the blink classes exist nowhere else (a second, scoped rule would
        // show up as a third occurrence).
        expect(css.match(/\.dot--blink-(?:fast|slow)/g)).toHaveLength(2);
        expect(selectors).not.toMatch(/tree-row|session-list|\.dot--(?:ok|busy|err|attention|idle|compacting|dead|exited)/);
    });

    it("leaves chat.css free of any dim rule (page CSS must not re-scope the blink)", () => {
        const css = compact(chatCss);
        expect(css).not.toContain("data-pi-blink");
        expect(css).not.toMatch(/\.dot--blink-(?:fast|slow)/);
    });

    it("paints the current marker wherever the dot is mounted", () => {
        // The head dot and its list row must agree on the blue marker too, so
        // `.dot--current` may not be scoped to a wrapper either (jsdom cannot
        // resolve `var(--info)`, so this half has to read the sheet).
        expect(compact(appCss)).toMatch(/(?:^|[},\s])\.dot--current\s*\{[^}]*background:\s*var\(--info\)/);
        expect(compact(chatCss)).not.toMatch(/\.tree-row\s+\.dot--current/);
    });

    it("no colour class owns an animation or an opacity any more", () => {
        const css = compact(appCss);
        // `@keyframes pulse` may stay for unrelated chrome, but a `.dot--*`
        // colour class may not animate or fade itself again.
        for (const selector of [".dot--busy", ".dot--ok", ".dot--err", ".dot--attention", ".dot--compacting"]) {
            const rule = new RegExp(`${escapeRe(selector)}\\s*\\{([^}]*)\\}`).exec(css);
            if (!rule) continue;
            expect(rule[1], selector).not.toMatch(/animation:|opacity:/);
        }
        expect(css).not.toMatch(/\.tree-row[^{,]*\.dot--(?:ok|busy|err)[^{]*\{[^}]*(?:opacity|animation)/);
    });
});

describe("blink CSS: nothing blinks without a phase attribute", () => {
    it.each([
        ["dot--blink-fast"],
        ["dot--blink-slow"],
        ["dot--ok", "dot--blink-fast"],
        ["dot--compacting", "dot--blink-slow"],
        ["dot--busy"],
        ["dot--ok"],
    ])("%s is solid", (...classes) => {
        setPhase();
        expect(opacityOf(mountDot(classes))).toBe(SOLID);
        expect(opacityOf(mountDot(classes, { inTreeRow: true }))).toBe(SOLID);
    });
});

describe("blink CSS: data-pi-blink-fast='dim'", () => {
    it("dims .dot--blink-fast identically inside and outside .tree-row", () => {
        setPhase({ fast: "dim" });
        // The original bug in one line: the wrapper used to change the answer.
        const outside = opacityOf(mountDot(["dot--ok", "dot--blink-fast"]));
        const inside = opacityOf(mountDot(["dot--ok", "dot--blink-fast"], { inTreeRow: true }));
        expect(outside).toBe(DIM);
        expect(inside).toBe(DIM);
    });

    it("dims every real fast-blink combination (ok / busy / err)", () => {
        setPhase({ fast: "dim" });
        for (const colour of ["dot--ok", "dot--busy", "dot--err"]) {
            expect(opacityOf(mountDot([colour, "dot--blink-fast"])), colour).toBe(DIM);
            expect(opacityOf(mountDot([colour, "dot--blink-fast"], { inTreeRow: true })), colour).toBe(DIM);
        }
    });

    it("leaves .dot--blink-slow, and colour-only .dot--idle/.dot--ok/.dot--attention solid", () => {
        setPhase({ fast: "dim" });
        expect(opacityOf(mountDot(["dot--ok", "dot--blink-slow"]))).toBe(SOLID);
        expect(opacityOf(mountDot(["dot--compacting", "dot--blink-slow"]))).toBe(SOLID);
        for (const colour of ["dot--idle", "dot--ok", "dot--attention", "dot--compacting", "dot--exited", "dot--dead"]) {
            expect(opacityOf(mountDot([colour])), colour).toBe(SOLID);
            expect(opacityOf(mountDot([colour], { inTreeRow: true })), `${colour} in tree-row`).toBe(SOLID);
        }
    });

    it("does not dim a dot that also carries dot--blink-slow at the fast-phase step", () => {
        // A dot only ever carries one rate (`DotView.blink` is a single value);
        // if both were present the fast clock would still win, which is why the
        // matrix must not emit both.
        setPhase({ fast: "dim", slow: "on" });
        expect(opacityOf(mountDot(["dot--busy", "dot--blink-fast", "dot--blink-slow"]))).toBe(DIM);
    });
});

describe("blink CSS: data-pi-blink-slow='dim'", () => {
    it("dims .dot--blink-slow identically inside and outside .tree-row", () => {
        setPhase({ slow: "dim" });
        expect(opacityOf(mountDot(["dot--compacting", "dot--blink-slow"]))).toBe(DIM);
        expect(opacityOf(mountDot(["dot--compacting", "dot--blink-slow"], { inTreeRow: true }))).toBe(DIM);
    });

    it("leaves every fast-blink and colour-only dot solid", () => {
        setPhase({ slow: "dim" });
        for (const classes of [
            ["dot--ok", "dot--blink-fast"],
            ["dot--busy", "dot--blink-fast"],
            ["dot--err", "dot--blink-fast"],
            ["dot--idle"],
            ["dot--ok"],
            ["dot--attention"],
        ]) {
            expect(opacityOf(mountDot(classes)), classes.join(" ")).toBe(SOLID);
            expect(opacityOf(mountDot(classes, { inTreeRow: true })), `${classes.join(" ")} in tree-row`).toBe(SOLID);
        }
    });
});

describe("blink CSS: regression pin — the colour class alone can never blink", () => {
    // The old sheet animated `.dot--busy`/`.dot--err` globally and `.dot--ok`
    // inside `.tree-row`. A dot that asks for no blink must stay solid in every
    // phase, in every wrapper: no re-introduced tree-scoped green, no
    // forever-blinking red/green task dot.
    const colourOnly = ["dot--busy", "dot--err", "dot--ok", "dot--attention", "dot--idle"];

    it.each(colourOnly)("%s stays solid across every phase and wrapper", (colour) => {
        for (const phase of [{}, { fast: "dim" as const }, { slow: "dim" as const }, { fast: "on" as const, slow: "on" as const }]) {
            setPhase(phase);
            expect(opacityOf(mountDot([colour])), `${colour} ${JSON.stringify(phase)}`).toBe(SOLID);
            expect(opacityOf(mountDot([colour], { inTreeRow: true })), `${colour} in tree-row`).toBe(SOLID);
        }
    });

    it("the same colour blinks only when the view asked for it", () => {
        setPhase({ fast: "dim" });
        // `ok` (a done row) blinks *because* of dot--blink-fast, not because of
        // where it is mounted.
        expect(opacityOf(mountDot(["dot--ok"]))).toBe(SOLID);
        expect(opacityOf(mountDot(["dot--ok"], { inTreeRow: true }))).toBe(SOLID);
        expect(opacityOf(mountDot(["dot--ok", "dot--blink-fast"]))).toBe(DIM);
        expect(opacityOf(mountDot(["dot--ok", "dot--blink-fast"], { inTreeRow: true }))).toBe(DIM);
    });
});
