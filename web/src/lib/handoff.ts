/**
 * One-time login handoff for `:PiWeb`.
 *
 * The daemon opens `http://<host>:<port>/#t=<token>` (or `#token=<token>`).
 * The token is read once, stored through the existing device-token helper and
 * removed from the address bar/history before the router resolves its first
 * route. Anything that is not a valid handoff is left untouched, so a bad
 * link stays visibly broken instead of silently landing on `/connect`.
 */

/** Fragment forms the daemon may hand off: `#t=<token>` and `#token=<token>`. */
export const HANDOFF_HASH_PATTERN = /^(?:t|token)=(.+)$/;

/** Device tokens are base64url-ish and at least 20 characters long. */
export const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

export interface HandoffLocation {
    readonly hash: string;
    readonly pathname: string;
    readonly search: string;
}

export interface HandoffHistory {
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export type HandoffTokenSink = (token: string | null) => void;

/**
 * Extract a valid handoff token from a location hash. Returns `null` for any
 * other fragment, including malformed percent-encoding.
 */
export function readHandoff(hash: string): string | null {
    if (!hash) return null;
    const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
    const match = HANDOFF_HASH_PATTERN.exec(fragment);
    const encoded = match?.[1];
    if (!encoded) return null;

    let token: string;
    try {
        token = decodeURIComponent(encoded);
    } catch {
        return null;
    }
    return HANDOFF_TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * Store a handoff token and strip the fragment while keeping the path and
 * query string. No-ops (and never writes history) when the hash is not a
 * valid handoff.
 */
export function consumeHandoff(
    location: HandoffLocation,
    history: HandoffHistory,
    setToken: HandoffTokenSink,
): string | null {
    const token = readHandoff(location.hash);
    if (!token) return null;

    setToken(token);
    history.replaceState(null, "", location.pathname + location.search);
    return token;
}
