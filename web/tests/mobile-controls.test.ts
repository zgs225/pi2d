import { describe, expect, it } from "vitest";

import appCss from "@/styles/app.css?raw";

/**
 * The mobile half of the "the console never scales itself" contract.
 *
 * Two browser behaviours make a phone render the console at the wrong scale,
 * both without any help from our CSS:
 *
 *  1. Mobile Safari zooms the visual viewport in when a focused text control
 *     renders below 16px, and it never zooms back out — the page stays scaled
 *     for the whole session. Every control we ship is smaller than that by
 *     design (`input/select/textarea` inherit `--fs-body` 14px, `.composer__ta`
 *     is 15px), so `app.css` has to raise a floor.
 *  2. Text autosizing inflates type when the device rotates to landscape.
 *
 * jsdom does not evaluate media queries for `getComputedStyle`, so the sheet is
 * read as text (the `?raw` idiom `tokens.test.ts` established).
 */

function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every `@media (…) { … }` block in a sheet, as `{ condition, body }`. */
function mediaBlocks(source: string): { condition: string; body: string }[] {
    const text = stripComments(source);
    const blocks: { condition: string; body: string }[] = [];
    const head = /@media([^{]+)\{/g;
    let match: RegExpExecArray | null;
    while ((match = head.exec(text))) {
        const condition = match[1] ?? "";
        const open = match.index + match[0].length - 1;
        let depth = 0;
        for (let i = open; i < text.length; i += 1) {
            if (text[i] === "{") depth += 1;
            if (text[i] === "}") {
                depth -= 1;
                if (depth === 0) {
                    blocks.push({ condition, body: text.slice(open + 1, i) });
                    head.lastIndex = i;
                    break;
                }
            }
        }
    }
    return blocks;
}

const compact = (source: string) => source.replace(/\s+/g, " ").trim();

describe("mobile form controls", () => {
    const blocks = mediaBlocks(appCss);

    it("keeps text controls at 16px on touch devices, not only on narrow ones", () => {
        const guarded = blocks.filter((block) => /font-size:\s*16px\s*!important/.test(compact(block.body)));
        expect(guarded.length, "no 16px control floor in app.css").toBeGreaterThan(0);
        for (const block of guarded) {
            for (const control of ["input", "select", "textarea", '[contenteditable="true"]']) {
                expect(compact(block.body), `${block.condition} misses ${control}`).toContain(control);
            }
            // Phones in landscape are wider than 600px and still zoom.
            expect(block.condition, "the floor must key on `hover: none`").toContain("hover: none");
        }
    });

    it("leaves the desktop cascade alone", () => {
        for (const block of blocks) {
            if (!/font-size:\s*16px\s*!important/.test(compact(block.body))) continue;
            expect(block.condition).toMatch(/hover: none|max-width/);
        }
    });

    it("opts out of mobile text autosizing", () => {
        expect(compact(appCss)).toMatch(/-webkit-text-size-adjust:\s*100%/);
        expect(compact(appCss)).toMatch(/[^-]text-size-adjust:\s*100%/);
    });
});
