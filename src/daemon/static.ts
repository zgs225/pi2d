/**
 * Static UI serving.
 *
 * Hashed assets are immutable; `index.html` is never cached. Unknown
 * extension-less paths are SPA routes and fall back to `index.html`, while
 * `/api*`, `/ws*`, asset paths and file-looking paths return 404.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import type { Context } from "hono";
import { errorBody, ERROR_CODES } from "../protocol/errors.js";

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm",
};

export type StaticKind = "file" | "not_found" | "method_not_allowed";

export interface StaticResolution {
    kind: StaticKind;
    status: number;
    filePath?: string;
    headers: Record<string, string>;
}

const NO_STORE = "no-store";
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

function isReservedPath(pathname: string): boolean {
    return (
        pathname === "/api" ||
        pathname.startsWith("/api/") ||
        pathname === "/ws" ||
        pathname.startsWith("/ws/")
    );
}

function notFound(): StaticResolution {
    return { kind: "not_found", status: 404, headers: {} };
}

function fileResolution(filePath: string, relativePath: string): StaticResolution {
    const cacheControl =
        relativePath === "index.html"
            ? NO_STORE
            : relativePath.startsWith("assets/")
              ? IMMUTABLE
              : REVALIDATE;
    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
    let size = 0;
    try {
        size = statSync(filePath).size;
    } catch {
        return notFound();
    }
    return {
        kind: "file",
        status: 200,
        filePath,
        headers: {
            "content-type": type,
            "content-length": String(size),
            "cache-control": cacheControl,
            "x-content-type-options": "nosniff",
        },
    };
}

function safeRealRoot(staticDir: string): string | undefined {
    try {
        return realpathSync(staticDir);
    } catch {
        return undefined;
    }
}

function indexFile(root: string, staticDir: string): StaticResolution {
    const indexPath = join(staticDir, "index.html");
    let realIndex: string;
    try {
        realIndex = realpathSync(indexPath);
    } catch {
        return notFound();
    }
    if (realIndex !== root && !realIndex.startsWith(`${root}${sep}`)) return notFound();
    return fileResolution(realIndex, "index.html");
}

/**
 * Resolve a request path without touching the network. Exported so the logic
 * can be unit-tested independently of the Hono adapter.
 */
export function resolveStaticRequest(staticDir: string, rawPath: string, rawMethod: string): StaticResolution {
    const method = rawMethod.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
        return { kind: "method_not_allowed", status: 405, headers: { allow: "GET, HEAD" } };
    }

    const withoutQuery = rawPath.split("?")[0] ?? "/";
    let pathname: string;
    try {
        pathname = decodeURIComponent(withoutQuery);
    } catch {
        return notFound();
    }
    if (pathname.includes("\0")) return notFound();
    if (!pathname.startsWith("/")) pathname = `/${pathname}`;
    if (isReservedPath(pathname)) return notFound();

    const segments = pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === "..")) return notFound();

    const root = safeRealRoot(staticDir);
    if (!root) return notFound();

    const relativePath = segments.join("/");
    if (relativePath === "") return indexFile(root, staticDir);

    const directPath = join(staticDir, relativePath);
    let realDirect: string;
    try {
        realDirect = realpathSync(directPath);
    } catch {
        // Missing path: SPA fallback unless it looks like an asset or a file.
        if (relativePath.startsWith("assets/")) return notFound();
        if (extname(relativePath) !== "") return notFound();
        return indexFile(root, staticDir);
    }

    if (realDirect !== root && !realDirect.startsWith(`${root}${sep}`)) return notFound();
    try {
        if (statSync(realDirect).isDirectory()) {
            return indexFile(root, staticDir);
        }
    } catch {
        return notFound();
    }
    return fileResolution(realDirect, relativePath);
}

export async function serveStatic(c: Context, staticDir: string): Promise<Response> {
    const method = c.req.method.toUpperCase();
    const resolution = resolveStaticRequest(staticDir, new URL(c.req.url).pathname, method);

    if (resolution.kind === "method_not_allowed") {
        return json(405, errorBody(ERROR_CODES.METHOD_NOT_ALLOWED, "static files support GET and HEAD only"));
    }
    if (resolution.kind === "not_found" || !resolution.filePath) {
        return json(404, errorBody(ERROR_CODES.NOT_FOUND, "not found"));
    }

    let body: Buffer | null = null;
    try {
        body = readFileSync(resolution.filePath);
    } catch {
        return json(404, errorBody(ERROR_CODES.NOT_FOUND, "not found"));
    }

    return new Response(method === "HEAD" ? null : new Uint8Array(body), {
        status: 200,
        headers: resolution.headers,
    });
}
