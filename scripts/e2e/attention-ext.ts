/**
 * Test-only pi extension for the pi2d API/WS end-to-end suite (docs/e2e.md A11).
 *
 * The suite must prove the pre-execution attention/diff contract without a real
 * terminal UI:
 *
 *   pi2:attention_request (method "diff", payload.files)
 *     → attention.respond {value: '{"result":"Accepted"}'}
 *     → file written, pi2:attention_resolved, second respond E_ATTENTION_RESOLVED
 *
 * `e2e_request` is a model-callable tool whose `execute()` blocks in
 * `ctx.ui.select(title, ["Accept", "Reject"])`. In RPC mode that becomes an
 * `extension_ui_request` frame with `method: "select"`, which pi.nvim's
 * `pi.attention` decodes: a `title` that is JSON with `toolName: "write"|"edit"`
 * is treated as a diff review (`pi.attention.decode_diff_payload`), so the
 * request surfaces as `method: "diff"` with the decoded `payload` (see
 * `pi2.nvim-web/lua/pi/web/instance.lua:project_attention_entry`).
 *
 * The title payload uses the web console's documented diff shape
 * `{toolName, files:[{path, before, after}]}` (see
 * `pi2d/web/src/features/chat/diff.ts:diffFilesFromPayload`), so the same JSON
 * drives both the plugin's attention classification and the web diff view.
 *
 * Determinism: the select is issued from the tool call (no timing tricks). A
 * `before_agent_start` fallback keyed on the marker `[[e2e-attention]]` /
 * `[[e2e-attention-reject]]` makes the trigger independent of whether the model
 * actually calls the tool: the marker fires the request once per turn, and a
 * model-initiated `e2e_request` call in the same turn reuses that decision
 * instead of opening a second dialog.
 *
 * Loaded only by `scripts/e2e/host-init.lua` via `cli.args = {"--extension", …}`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

const ACCEPT_MARKER = "[[e2e-attention]]";
const REJECT_MARKER = "[[e2e-attention-reject]]";
const ACCEPT_FILE = "e2e-attention.txt";
const REJECT_FILE = "e2e-attention-reject.txt";
const CONTENT = "hello-e2e";

interface Decision {
    accepted: boolean;
    path: string;
    raw: unknown;
}

/** The diff payload the plugin classifies as attention kind `diff`. */
function diffTitle(path: string, after: string): string {
    return JSON.stringify({ toolName: "write", files: [{ path, before: "", after }] });
}

/**
 * Interpret an `extension_ui_response.value` as an accept/reject verdict.
 * Accepts the pi.nvim diff-review encoding (`'{"result":"Accepted"}'`), a bare
 * option label, or an already-decoded object. `undefined`/`null` (cancelled or
 * timeout) counts as a reject.
 */
function verdictOf(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") {
        const text = value.trim();
        if (text === "") return false;
        if (/^accept/i.test(text)) return true;
        if (/^(reject|cancel|deny)/i.test(text)) return false;
        try {
            return verdictOf(JSON.parse(text));
        } catch {
            return /accept/i.test(text);
        }
    }
    if (typeof value === "object") {
        const record = value as { result?: unknown; cancelled?: unknown; confirmed?: unknown };
        if (record.cancelled === true) return false;
        if (typeof record.result === "string") return /^accept/i.test(record.result);
        if (typeof record.confirmed === "boolean") return record.confirmed;
    }
    return false;
}

export default function attentionExtension(pi: ExtensionAPI) {
    /** Decision taken for the current turn, so one turn never opens two dialogs. */
    let turn: Decision | null = null;
    let requests = 0;

    async function request(ctx: ExtensionContext, file: string): Promise<Decision> {
        requests += 1;
        const raw = await ctx.ui.select(diffTitle(file, CONTENT), ["Accept", "Reject"]);
        const accepted = verdictOf(raw);
        if (accepted) {
            writeFileSync(join(ctx.cwd, file), CONTENT);
        }
        return { accepted, path: file, raw };
    }

    pi.registerTool({
        name: "e2e_request",
        label: "E2E Attention Request",
        description:
            "Request user approval for a pending write through the pre-execution attention/diff review path. " +
            "Call it exactly once when the user asks for it, then report whether it was accepted or rejected.",
        promptGuidelines: [
            "When a user message asks you to call e2e_request, call it once before you reply.",
        ],
        parameters: Type.Object({}),
        executionMode: "sequential",
        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            const decision = turn ?? (await request(ctx, ACCEPT_FILE));
            turn = decision;
            return {
                content: [
                    {
                        type: "text",
                        text: `${decision.accepted ? "Accepted" : "Rejected"} ${decision.path} (attention request ${requests})`,
                    },
                ],
                details: { accepted: decision.accepted, path: decision.path },
            };
        },
    });

    pi.on("before_agent_start", async (event, ctx) => {
        turn = null;
        const prompt = typeof event.prompt === "string" ? event.prompt : "";
        if (prompt.includes(REJECT_MARKER)) {
            turn = await request(ctx, REJECT_FILE);
        } else if (prompt.includes(ACCEPT_MARKER)) {
            turn = await request(ctx, ACCEPT_FILE);
        }
        return undefined;
    });
}
