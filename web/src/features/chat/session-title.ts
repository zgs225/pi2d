/**
 * Session / sub-session display titles — the web port of pi2.nvim's
 * `:PiSessions` name resolution (`lua/pi/ui/sessions.lua`, `resolve_name`).
 *
 * Rules (in this order, each guarded by a trim + non-empty check):
 *
 * 1. the session's own name (`session.name`, set by the user or the backend's
 *    auto-title extension);
 * 2. while the backend is *generating* a title, the provisional placeholder —
 *    never the first message: pi2.nvim keeps the label on `(unnamed)` so the
 *    row makes one visible change (placeholder → title), not two;
 * 3. the first user message (`session.firstMessage`, the list row's disk
 *    projection) as the provisional label;
 * 4. the `(unnamed)` placeholder.
 *
 * Sub-sessions resolve `name` → the task prompt (first 40 characters, the same
 * cut as `pi/subsessions/manifest.lua FALLBACK_NAME_CHARS`) → `sub-session`.
 *
 * **Never returns an id.** A session id is an identity (`data-session-id`,
 * hrefs, RPC targets), not a label — pi2.nvim shows `(unnamed)` instead.
 *
 * Pure and React-free so the state machine is unit-testable without a DOM.
 */

export interface SessionTitleInput {
    name?: string | null;
    firstMessage?: string | null;
    /**
     * Reserved: the plugin's `pi-title` extension status (the auto-title
     * extension's `setStatus` while it generates a name) is not relayed to the
     * browser yet — `docs/protocol.md` has no field for it. When it lands, the
     * row's spinner switches on with no change here.
     */
    titleGenerating?: boolean;
}

export interface SessionTitlePhrases {
    /** `t("chat.sessionUnnamed")` — the pi2.nvim `(unnamed)` literal. */
    unnamed: string;
    /** `t("chat.subagentUnnamed")` — the pi2.nvim `sub-session` fallback. */
    subagentUnnamed: string;
}

export type SessionTitleKind = "name" | "first-message" | "task" | "generating" | "unnamed";

export interface SessionTitle {
    /** What the row renders. Never an id. */
    text: string;
    kind: SessionTitleKind;
    /** Placeholder text (`(unnamed)` / `sub-session`) rather than data. */
    provisional: boolean;
    /** Render the braille spinner prefix (pi2.nvim: prefix, never a replacement). */
    spinner: boolean;
}

/** Task characters kept when deriving a sub-session name (`Manifest.fallback_name`). */
export const FALLBACK_NAME_CHARS = 40;

export function sessionTitle(input: SessionTitleInput, phrases: SessionTitlePhrases): SessionTitle {
    const name = trim(input?.name);
    if (name) return { text: name, kind: "name", provisional: false, spinner: false };

    if (input?.titleGenerating === true) {
        // pi2.nvim suppresses the first-message fallback while titling.
        return { text: phrases.unnamed, kind: "generating", provisional: true, spinner: true };
    }

    const firstMessage = trim(input?.firstMessage);
    if (firstMessage) return { text: firstMessage, kind: "first-message", provisional: false, spinner: false };

    return { text: phrases.unnamed, kind: "unnamed", provisional: true, spinner: false };
}

export function subagentTitle(
    input: Pick<SessionTitleInput, "name"> & { task?: string | null },
    phrases: SessionTitlePhrases,
): SessionTitle {
    const name = trim(input?.name);
    if (name) return { text: name, kind: "name", provisional: false, spinner: false };

    const task = trim(input?.task);
    if (task) {
        return { text: task.slice(0, FALLBACK_NAME_CHARS), kind: "task", provisional: true, spinner: false };
    }

    return { text: phrases.subagentUnnamed, kind: "unnamed", provisional: true, spinner: false };
}

function trim(value: string | null | undefined): string {
    return typeof value === "string" ? value.trim() : "";
}
