/**
 * Route guard helpers. `next` is restricted to the three navigation pages
 * (plus the /workspace and /chat detail routes) — everything else falls back
 * to /workspaces, matching `App.safeNext` in the prototype.
 */

export const NEXT_FALLBACK = "/workspaces";
export const CONNECT_PATH = "/connect";

const EXACT = new Set(["/workspaces", "/status", "/chat"]);
const PREFIXES = ["/chat/", "/workspace/"];

/** Validate and normalize a post-connect return path. */
export function safeNext(path: string | null | undefined, fallback = NEXT_FALLBACK): string {
    const fb = isAllowed(fallback) ? fallback : NEXT_FALLBACK;
    if (!path) return fb;

    let url: URL;
    try {
        url = new URL(String(path), "http://pi2.local");
    } catch {
        return fb;
    }
    if (!isAllowed(url.pathname)) return fb;
    return `${url.pathname}${url.search}`;
}

export function isAllowed(pathname: string): boolean {
    const normalized = pathname.replace(/\/+$/, "") || "/";
    if (EXACT.has(normalized)) return true;
    return PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function connectHref(next: string): string {
    return `${CONNECT_PATH}?next=${encodeURIComponent(safeNext(next))}`;
}
