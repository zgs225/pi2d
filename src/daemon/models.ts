/**
 * Pure routing module for resolving the model catalogue without spawning Neovim.
 *
 * `resolveModels` picks the best ready workspace instance, queries it, and
 * falls through to the next candidate on failure or a pending answer.
 * No Node I/O, no unref'd timers, no imports from http.ts.
 */

export interface ModelsCandidate {
    workspaceId: string;
    status: string;
    sessions: number;
    startedAt: number;
}

export type ModelsPendingReason = "fetching" | "no-instance" | "no-live-session";

export interface ModelsResolution {
    providers: unknown[];
    pending: boolean;
    workspaceId: string | null;
    pendingReason?: ModelsPendingReason;
    attempted: string[];
}

export interface ResolveModelsInput {
    candidates: ModelsCandidate[];
    preferredWorkspaceId?: string | null;
    query: (workspaceId: string) => Promise<Record<string, unknown>>;
    /** default 2500 */
    timeoutMs?: number;
    log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * Race `query(workspaceId)` against a timeout.
 * Always resolves — rejects are caught and re-thrown as Error.
 * Every timer is cleared in a finally block.
 */
function queryWithTimeout(
    query: (ws: string) => Promise<Record<string, unknown>>,
    workspaceId: string,
    timeoutMs: number,
): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
        };

        timer = setTimeout(() => {
            timer = undefined;
            reject(new Error(`models query timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        Promise.resolve()
            .then(() => query(workspaceId))
            .then(
                (result) => {
                    cleanup();
                    resolve(result);
                },
                (err: unknown) => {
                    cleanup();
                    reject(err instanceof Error ? err : new Error(String(err)));
                },
            );
    });
}

export async function resolveModels(input: ResolveModelsInput): Promise<ModelsResolution> {
    const { candidates, preferredWorkspaceId, query, timeoutMs = 2500, log } = input;

    // --- 1. Only ready candidates are eligible (no-spawn guarantee) ---
    const ready = candidates.filter((c) => c.status === "ready");

    if (ready.length === 0) {
        return {
            providers: [],
            pending: true,
            workspaceId: preferredWorkspaceId ?? null,
            pendingReason: "no-instance",
            attempted: [],
        };
    }

    // --- 2. Order: preferred first (if ready), then sessions desc, startedAt desc ---
    const preferred = preferredWorkspaceId != null
        ? ready.find((c) => c.workspaceId === preferredWorkspaceId)
        : undefined;

    const rest = ready
        .filter((c) => c.workspaceId !== preferred?.workspaceId)
        .sort((a, b) => b.sessions - a.sessions || b.startedAt - a.startedAt);

    const ordered: ModelsCandidate[] = preferred ? [preferred, ...rest] : rest;

    // Deduplicate (rule 7: never query the same workspace twice)
    const seen = new Set<string>();
    const queue: ModelsCandidate[] = [];
    for (const c of ordered) {
        if (!seen.has(c.workspaceId)) {
            seen.add(c.workspaceId);
            queue.push(c);
        }
    }

    // --- 3. Query in order ---
    const attempted: string[] = [];

    for (const candidate of queue) {
        const { workspaceId } = candidate;
        let ack: Record<string, unknown>;
        try {
            ack = await queryWithTimeout(query, workspaceId, timeoutMs);
        } catch (err) {
            attempted.push(workspaceId);
            log?.("models.candidate_failed", {
                workspaceId,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }

        // --- 4. Success condition ---
        if (Array.isArray(ack["providers"]) && (ack["providers"] as unknown[]).length > 0 && ack["pending"] !== true) {
            return {
                providers: ack["providers"] as unknown[],
                pending: false,
                workspaceId,
                attempted,
            };
        }

        // Not a success — counts as attempted
        attempted.push(workspaceId);
        log?.("models.candidate_failed", {
            workspaceId,
            reason: "pending-or-empty",
            pending: ack["pending"],
            providerCount: Array.isArray(ack["providers"]) ? (ack["providers"] as unknown[]).length : 0,
        });
    }

    // --- 5. Nothing succeeded ---
    // pendingReason: fetching when any candidate had sessions > 0, else no-live-session
    const hasSessions = queue.some((c) => c.sessions > 0);

    // Best workspaceId to surface: first attempted, else preferred, else best ready candidate
    const bestWorkspaceId =
        attempted[0] ??
        preferredWorkspaceId ??
        queue[0]?.workspaceId ??
        null;

    return {
        providers: [],
        pending: true,
        workspaceId: bestWorkspaceId,
        pendingReason: hasSessions ? "fetching" : "no-live-session",
        attempted,
    };
}
