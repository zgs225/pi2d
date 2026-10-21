/**
 * Errors raised by the instance layer (`src/instances/**`).
 *
 * The daemon surfaces map `code` onto the protocol error table
 * (`docs/protocol.md` §7); `message` is English/debug only.
 */

import { ERROR_CODES, errorBody } from "../protocol/errors.js";
import type { ErrorBody } from "../protocol/types.js";

/** Not part of the public protocol table: a plugin command exceeded its timeout. */
export const TIMEOUT_CODE = "E_TIMEOUT";

export class InstanceError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly details: Record<string, unknown> | undefined;

    constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
        super(message);
        this.name = "InstanceError";
        this.code = code;
        this.retryable = retryable;
        this.details = details;
    }

    toBody(): ErrorBody {
        return errorBody(this.code, this.message, this.retryable, this.details);
    }

    static unavailable(message: string, details?: Record<string, unknown>): InstanceError {
        return new InstanceError(ERROR_CODES.INSTANCE_UNAVAILABLE, message, true, details);
    }

    static starting(message: string, details?: Record<string, unknown>): InstanceError {
        return new InstanceError(ERROR_CODES.INSTANCE_STARTING, message, true, details);
    }

    static notFound(message: string): InstanceError {
        return new InstanceError(ERROR_CODES.NOT_FOUND, message, false);
    }

    static timeout(message: string): InstanceError {
        return new InstanceError(TIMEOUT_CODE, message, true);
    }
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Normalizes anything thrown in the instance layer. */
export function asInstanceError(error: unknown): InstanceError {
    if (error instanceof InstanceError) return error;
    return new InstanceError(ERROR_CODES.INTERNAL, errorMessage(error), false);
}
