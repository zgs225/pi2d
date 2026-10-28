/**
 * Command routing for `POST /api/v1/cmd` (and the read relays used by REST).
 *
 * The daemon owns `workspace.*`, `instance.*`, `pair.*`, `device.revoke` and
 * `system.*`; everything else is forwarded to the plugin that owns the session.
 */
import { randomUUID } from "node:crypto";
import type { InstanceManager, Logger, WorkspaceStore } from "../core/interfaces.js";
import { ERROR_CODES } from "../protocol/errors.js";
import type { CommandRequest } from "../protocol/types.js";
import type { AuthStore, DeviceKind } from "./auth.js";
import { DaemonError, toErrorPayload } from "./errors.js";

const DEDUPE_TTL_MS = 5 * 60 * 1000;

export interface RouterDeps {
    auth: AuthStore;
    instances: InstanceManager;
    workspaces: WorkspaceStore;
    logger?: Logger;
    now?: () => number;
    daemonId?: string;
}

export interface CommandResult {
    status: number;
    body: Record<string, unknown>;
}

interface CacheEntry {
    status: number;
    body: Record<string, unknown>;
    expiresAt: number;
}

function asParams(request: CommandRequest): Record<string, unknown> {
    if (request.params === undefined) return {};
    if (typeof request.params !== "object" || request.params === null || Array.isArray(request.params)) {
        throw DaemonError.badRequest("params must be an object");
    }
    return request.params;
}

function requireString(params: Record<string, unknown>, key: string, label = key): string {
    const value = params[key];
    if (typeof value !== "string" || value.trim() === "") {
        throw DaemonError.badRequest(`${label} is required`);
    }
    return value;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
    const value = params[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export class CommandRouter {
    private readonly auth: AuthStore;
    private readonly instances: InstanceManager;
    private readonly workspaces: WorkspaceStore;
    private readonly logger: Logger | undefined;
    private readonly now: () => number;
    private readonly dedupe = new Map<string, CacheEntry>();
    private readonly inFlight = new Map<string, Promise<CommandResult>>();

    constructor(deps: RouterDeps) {
        this.auth = deps.auth;
        this.instances = deps.instances;
        this.workspaces = deps.workspaces;
        this.logger = deps.logger;
        this.now = deps.now ?? Date.now;
    }

    async dispatch(request: CommandRequest): Promise<CommandResult> {
        if (typeof request !== "object" || request === null || typeof request.method !== "string") {
            const mapped = toErrorPayload(DaemonError.badRequest("method is required"));
            return { status: mapped.status, body: mapped.body as unknown as Record<string, unknown> };
        }

        const clientRequestId = request.clientRequestId;
        if (typeof clientRequestId !== "string" || clientRequestId === "") {
            return this.execute(request);
        }

        const key = `${request.method}\u0000${clientRequestId}`;
        const cached = this.dedupe.get(key);
        if (cached) {
            if (cached.expiresAt > this.now()) {
                return { status: cached.status, body: cached.body };
            }
            this.dedupe.delete(key);
        }

        const running = this.inFlight.get(key);
        if (running) return running;

        const promise = this.execute(request)
            .then((result) => {
                if (result.status === 202) {
                    this.dedupe.set(key, {
                        status: result.status,
                        body: result.body,
                        expiresAt: this.now() + DEDUPE_TTL_MS,
                    });
                }
                return result;
            })
            .finally(() => {
                this.inFlight.delete(key);
            });
        this.inFlight.set(key, promise);
        return promise;
    }

    /** Relayed read used by `GET /workspaces/:id/sessions`, `/attention`, `/models`. */
    async relayWorkspaceQuery(
        workspaceId: string,
        kind: string,
        params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> {
        if (typeof workspaceId !== "string" || workspaceId === "") {
            throw DaemonError.badRequest("workspaceId is required");
        }
        return this.relay(workspaceId, undefined, "workspace.query", { ...params, kind });
    }

    /**
     * Relayed read used by `GET /sessions/:sid/entries`.
     *
     * The sid travels on the envelope even when `workspaceIdHint` routes the read
     * to an instance that does not own the session (a disk-only row): the plugin
     * resolves the file from its registry, so `params.sessionFile` is a fallback,
     * never a requirement. Dropping the sid here forced every workspace-scoped
     * read to carry a session file, which a session does not have before its
     * first entry is persisted.
     */
    async relaySessionQuery(
        sessionId: string,
        method: string,
        params: Record<string, unknown> = {},
        workspaceIdHint?: string,
    ): Promise<Record<string, unknown>> {
        const hint =
            typeof workspaceIdHint === "string" && workspaceIdHint !== ""
                ? { workspaceId: workspaceIdHint }
                : {};
        const workspaceId = this.resolveWorkspace(sessionId, { ...params, ...hint });
        return this.relay(workspaceId, sessionId, method, params);
    }

    private async relay(
        workspaceId: string,
        sessionId: string | undefined,
        method: string,
        params: Record<string, unknown>,
        clientRequestId?: string,
    ): Promise<Record<string, unknown>> {
        await this.instances.ensure(workspaceId);
        const connection = this.instances.get(workspaceId);
        if (!connection) {
            throw new DaemonError(ERROR_CODES.INSTANCE_UNAVAILABLE, `no instance for workspace ${workspaceId}`, {
                retryable: true,
            });
        }
        const ack = await connection.command({
            id: `req-${randomUUID()}`,
            ...(sessionId === undefined ? {} : { sessionId }),
            method,
            params,
            ...(clientRequestId === undefined ? {} : { clientRequestId }),
        });
        return ack as unknown as Record<string, unknown>;
    }

    private async execute(request: CommandRequest): Promise<CommandResult> {
        try {
            const params = asParams(request);
            const method = request.method;

            if (method.startsWith("workspace.")) {
                const result = await this.workspaceCommand(method, params);
                if (result) return { status: 202, body: result };
                if (method !== "workspace.query") {
                    throw new DaemonError(ERROR_CODES.UNSUPPORTED, `unsupported daemon method ${method}`);
                }
            }
            if (method === "instance.ensure") {
                const workspaceId = requireString(params, "workspaceId");
                const state = await this.instances.ensure(workspaceId);
                return { status: 202, body: { accepted: true, instance: state } };
            }
            if (method === "instance.shutdown") {
                const workspaceId = requireString(params, "workspaceId");
                const mode = params.mode === "stop" ? "stop" : "drain";
                await this.instances.shutdown(workspaceId, mode);
                return { status: 202, body: { accepted: true, workspaceId, mode } };
            }
            if (method === "system.doctor") {
                return {
                    status: 202,
                    body: { accepted: true, ok: true, instances: this.instances.list() },
                };
            }
            if (method === "system.shutdown") {
                const instances = this.instances.list();
                for (const instance of instances) {
                    await this.instances.shutdown(instance.workspaceId, "stop");
                }
                return { status: 202, body: { accepted: true, stopped: instances.length } };
            }
            if (method.startsWith("system.") || method.startsWith("instance.")) {
                throw new DaemonError(ERROR_CODES.UNSUPPORTED, `unsupported daemon method ${method}`);
            }
            if (method === "pair.create") {
                const ttlSec = typeof params.ttlSec === "number" ? params.ttlSec : undefined;
                const pair = this.auth.pairCreate(ttlSec === undefined ? {} : { ttlSec });
                return { status: 202, body: { accepted: true, ...pair } };
            }
            if (method === "pair.redeem") {
                const redeemed = this.auth.pairRedeem({
                    code: requireString(params, "code"),
                    deviceName: requireString(params, "deviceName"),
                    kind: requireString(params, "kind") as DeviceKind,
                });
                return { status: 202, body: { accepted: true, token: redeemed.token, device: redeemed.device } };
            }
            if (method === "device.revoke") {
                const deviceId = optionalString(params, "deviceId") ?? optionalString(params, "id");
                if (!deviceId) throw DaemonError.badRequest("deviceId is required");
                if (!this.auth.revokeDevice(deviceId)) {
                    throw new DaemonError(ERROR_CODES.NOT_FOUND, `unknown device ${deviceId}`);
                }
                return { status: 202, body: { accepted: true, revoked: true, deviceId } };
            }

            const workspaceId = this.resolveWorkspace(request.sessionId, params);
            const ack = await this.relay(
                workspaceId,
                request.sessionId,
                method,
                params,
                request.clientRequestId,
            );
            return { status: 202, body: { accepted: true, ...ack } };
        } catch (error) {
            this.logger?.debug("command failed", {
                method: request.method,
                error: error instanceof Error ? error.message : String(error),
            });
            const mapped = toErrorPayload(error);
            return { status: mapped.status, body: mapped.body as unknown as Record<string, unknown> };
        }
    }

    private async workspaceCommand(
        method: string,
        params: Record<string, unknown>,
    ): Promise<Record<string, unknown> | undefined> {
        switch (method) {
            case "workspace.add": {
                const input: { cwd: string; alias?: string; trust?: boolean } = {
                    cwd: requireString(params, "cwd"),
                };
                // `name` is the web dialog's field; it is an alias when `alias` is absent.
                // A whitespace-only value is dropped, exactly like an empty `alias`.
                const alias = optionalString(params, "alias") ?? optionalString(params, "name");
                if (alias !== undefined) input.alias = alias;
                if (typeof params.trust === "boolean") input.trust = params.trust;
                const workspace = await this.workspaces.add(input);
                // `workspace.workspaceId` is the documented location; the top-level
                // copy saves the web client a round trip on its fallback path.
                return { accepted: true, workspaceId: workspace.workspaceId, workspace };
            }
            case "workspace.update": {
                const workspaceId = requireString(params, "workspaceId");
                const patch =
                    typeof params.patch === "object" && params.patch !== null
                        ? (params.patch as Partial<{ alias: string | null; pinned: boolean; hidden: boolean; trusted: boolean }>)
                        : {};
                const workspace = await this.workspaces.update(workspaceId, patch);
                return { accepted: true, workspace };
            }
            case "workspace.remove": {
                const workspaceId = requireString(params, "workspaceId");
                await this.workspaces.remove(workspaceId);
                return { accepted: true, workspaceId };
            }
            case "workspace.refresh": {
                const workspaceId = optionalString(params, "workspaceId");
                await this.workspaces.refresh(workspaceId);
                return { accepted: true, ...(workspaceId === undefined ? {} : { workspaceId }) };
            }
            default:
                // `workspace.query` and unknown workspace.* methods fall through to the plugin.
                return undefined;
        }
    }

    private resolveWorkspace(sessionId: string | undefined, params: Record<string, unknown>): string {
        const explicit = optionalString(params, "workspaceId");
        if (sessionId !== undefined && sessionId !== "") {
            const owner = this.instances.findWorkspaceBySession(sessionId);
            if (owner) return owner;
            if (explicit) return explicit;
            throw DaemonError.sessionNotFound(sessionId);
        }
        if (explicit) return explicit;
        throw DaemonError.badRequest("workspaceId or sessionId is required");
    }
}

export function createRouter(deps: RouterDeps): CommandRouter {
    return new CommandRouter(deps);
}
