import type { SessionState } from "@/lib/protocol";

/**
 * Durable acknowledgements for the session-list notification dot.
 *
 * `flags.done` / `flags.error` are **unread markers**: the plugin raises them for
 * a session the user is not looking at and clears them on nvim's TabEnter. The
 * browser's TabEnter is `useSessionsStore.markSeen`, which used to clear the
 * flags in the in-memory store only — so the next snapshot (a page reload, or a
 * reconnect's resync) replayed `done: true` and the green blink came back for a
 * notification the user had already seen. A fresh page load has no memory, but
 * the plugin's flag still stands, so the dot looked stuck on "unread".
 *
 * The acknowledgement is therefore persisted (localStorage, per browser) under
 * the *occurrence* it was given for: the id of the transcript's newest entry.
 * The notification is the same one while the transcript still ends on that
 * entry; the next completed turn appends entries, so the token changes and the
 * new notification blinks again. This stays a client-side view concern — the
 * wire, the reducer and `fixtures/` are untouched.
 */
export const SEEN_STORAGE_KEY = "pi2-seen-sessions";

/** Bound the ledger; a browser sees a few dozen sessions, not thousands. */
const SEEN_LIMIT = 200;

type Ledger = Record<string, string>;

/**
 * Identity of the notification occurrence: the newest transcript entry.
 *
 * `undefined` when the state carries no entries (a REST list row before any
 * snapshot). Such a session cannot be acknowledged durably — recording an empty
 * token would swallow every future notification — so the caller keeps the
 * in-memory-only behaviour.
 */
export function occurrenceToken(session: Pick<SessionState, "entries">): string | undefined {
    const last = session.entries[session.entries.length - 1];
    return last === undefined || last.id === "" ? undefined : last.id;
}

function storage(): Storage | undefined {
    try {
        return typeof localStorage === "undefined" ? undefined : localStorage;
    } catch {
        // Accessing `localStorage` can throw (Safari private mode, blocked cookies).
        return undefined;
    }
}

function read(): Ledger {
    const store = storage();
    if (store === undefined) return {};
    try {
        const raw = store.getItem(SEEN_STORAGE_KEY);
        const parsed: unknown = raw === null ? null : JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const ledger: Ledger = {};
        for (const [sessionId, token] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof token === "string" && token !== "") ledger[sessionId] = token;
        }
        return ledger;
    } catch {
        return {};
    }
}

function write(ledger: Ledger): void {
    const store = storage();
    if (store === undefined) return;
    try {
        // Insertion order is the LRU: drop the oldest keys past the cap.
        const ids = Object.keys(ledger);
        if (ids.length > SEEN_LIMIT) {
            const trimmed: Ledger = {};
            for (const id of ids.slice(ids.length - SEEN_LIMIT)) {
                const token = ledger[id];
                if (token !== undefined) trimmed[id] = token;
            }
            store.setItem(SEEN_STORAGE_KEY, JSON.stringify(trimmed));
            return;
        }
        store.setItem(SEEN_STORAGE_KEY, JSON.stringify(ledger));
    } catch {
        // Quota or private mode: the in-memory store still clears the flag.
    }
}

/** Record that the user has seen this session's notification. */
export function acknowledge(session: Pick<SessionState, "sessionId" | "entries">): void {
    const token = occurrenceToken(session);
    if (token === undefined) return;
    const ledger = read();
    // Re-insert so the entry moves to the LRU tail.
    delete ledger[session.sessionId];
    ledger[session.sessionId] = token;
    write(ledger);
}

/** The session is gone: its ledger row is dead weight. */
export function forget(sessionId: string): void {
    const ledger = read();
    if (!(sessionId in ledger)) return;
    delete ledger[sessionId];
    write(ledger);
}

/** `tmp-N` → real id migration: the acknowledgement follows the session. */
export function move(from: string, to: string): void {
    if (from === to) return;
    const ledger = read();
    const token = ledger[from];
    if (token === undefined) return;
    delete ledger[from];
    ledger[to] = token;
    write(ledger);
}

/**
 * Clear a notification the user has already acknowledged for this occurrence.
 * A replay of the same `done`/`error` (snapshot, reconnect, reload) therefore
 * cannot resurrect the blink; a new completion appends an entry first, so its
 * token differs and it is left alone.
 */
export function suppressAcknowledged(session: SessionState): SessionState {
    if (!session.flags.done && !session.flags.error) return session;
    const token = occurrenceToken(session);
    if (token === undefined) return session;
    if (read()[session.sessionId] !== token) return session;
    return { ...session, flags: { ...session.flags, done: false, error: false } };
}
