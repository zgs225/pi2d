/** Daemon-side errors with a stable protocol code and HTTP status mapping. */
import { ERROR_CODES, errorBody } from "../protocol/errors.js";
import type { ErrorBody } from "../protocol/types.js";

const STATUS_BY_CODE: Record<string, number> = {
    [ERROR_CODES.BAD_REQUEST]: 400,
    [ERROR_CODES.UNAUTHORIZED]: 401,
    [ERROR_CODES.FORBIDDEN]: 403,
    [ERROR_CODES.NOT_FOUND]: 404,
    [ERROR_CODES.METHOD_NOT_ALLOWED]: 405,
    [ERROR_CODES.PROTOCOL_VERSION]: 426,
    [ERROR_CODES.PAYLOAD_TOO_LARGE]: 413,
    [ERROR_CODES.RATE_LIMITED]: 429,
    [ERROR_CODES.INSTANCE_STARTING]: 409,
    [ERROR_CODES.INSTANCE_UNMANAGED]: 409,
    [ERROR_CODES.INSTANCE_UNAVAILABLE]: 503,
    [ERROR_CODES.LEASE_CONFLICT]: 409,
    [ERROR_CODES.EXTERNAL_SESSION]: 409,
    [ERROR_CODES.SESSION_NOT_FOUND]: 404,
    [ERROR_CODES.ATTENTION_RESOLVED]: 409,
    [ERROR_CODES.UNSUPPORTED]: 501,
    [ERROR_CODES.INTERNAL]: 500,
};

const RETRYABLE_CODES = new Set<string>([ERROR_CODES.INSTANCE_STARTING, ERROR_CODES.INSTANCE_UNAVAILABLE]);

export function statusForCode(code: string): number {
    return STATUS_BY_CODE[code] ?? 500;
}

export function isRetryableCode(code: string): boolean {
    return RETRYABLE_CODES.has(code);
}

export interface DaemonErrorOptions {
    status?: number;
    retryable?: boolean;
    details?: Record<string, unknown>;
}

export class DaemonError extends Error {
    readonly code: string;
    readonly status: number;
    readonly retryable: boolean;
    readonly details: Record<string, unknown> | undefined;

    constructor(code: string, message: string, options: DaemonErrorOptions = {}) {
        super(message);
        this.name = "DaemonError";
        this.code = code;
        this.status = options.status ?? statusForCode(code);
        this.retryable = options.retryable ?? isRetryableCode(code);
        this.details = options.details;
    }

    toBody(): ErrorBody {
        return errorBody(this.code, this.message, this.retryable, this.details);
    }

    static from(error: unknown): DaemonError {
        if (error instanceof DaemonError) return error;
        if (error instanceof Error) return new DaemonError(ERROR_CODES.INTERNAL, error.message);
        return new DaemonError(ERROR_CODES.INTERNAL, String(error));
    }

    static badRequest(message: string): DaemonError {
        return new DaemonError(ERROR_CODES.BAD_REQUEST, message);
    }

    static unauthorized(message = "missing or invalid device token"): DaemonError {
        return new DaemonError(ERROR_CODES.UNAUTHORIZED, message);
    }

    static forbidden(message = "origin is not allowed"): DaemonError {
        return new DaemonError(ERROR_CODES.FORBIDDEN, message);
    }

    static notFound(message: string): DaemonError {
        return new DaemonError(ERROR_CODES.NOT_FOUND, message);
    }

    static sessionNotFound(sessionId: string): DaemonError {
        return new DaemonError(ERROR_CODES.SESSION_NOT_FOUND, `unknown session ${sessionId}`);
    }

    static payloadTooLarge(message: string): DaemonError {
        return new DaemonError(ERROR_CODES.PAYLOAD_TOO_LARGE, message);
    }
}

export function toErrorPayload(error: unknown): { status: number; body: ErrorBody } {
    const daemonError = DaemonError.from(error);
    return { status: daemonError.status, body: daemonError.toBody() };
}
