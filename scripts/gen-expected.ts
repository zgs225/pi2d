/**
 * Regenerates `fixtures/<case>/expected.json` from the canonical reducer.
 *
 *   pnpm tsx scripts/gen-expected.ts
 *
 * The generated files are reviewed and committed; both the TypeScript and the
 * Lua reducers must reproduce them exactly (see `test/reducer.conformance.test.ts`
 * and `pi2.nvim/tests/web_state_conformance_spec.lua`).
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { reduceAll } from "../src/protocol/reducer.js";
import type { SessionEvent } from "../src/protocol/types.js";

const root = join(import.meta.dirname, "..", "fixtures");
for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const eventsPath = join(dir, "events.jsonl");
    if (!existsSync(eventsPath)) continue;
    const events = readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SessionEvent);
    const first = events[0]?.session as Record<string, unknown> | undefined;
    const state = reduceAll(
        {
            sessionId: name,
            workspaceId: "ws-fixture",
            cwd: typeof first?.cwd === "string" ? first.cwd : "/repo",
        },
        events,
    );
    const out = join(dir, "expected.json");
    writeFileSync(out, JSON.stringify(state, null, 2) + "\n");
    console.log(`wrote ${out}`);
}
