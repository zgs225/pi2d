/** Stable error codes. The browser translates codes; `message` is English/debug only. */

export const ERROR_CODES = {
    BAD_REQUEST: "E_BAD_REQUEST",
    UNAUTHORIZED: "E_UNAUTHORIZED",
    FORBIDDEN: "E_FORBIDDEN",
    NOT_FOUND: "E_NOT_FOUND",
    METHOD_NOT_ALLOWED: "E_METHOD_NOT_ALLOWED",
    PROTOCOL_VERSION: "E_PROTOCOL_VERSION",
    PAYLOAD_TOO_LARGE: "E_PAYLOAD_TOO_LARGE",
    RATE_LIMITED: "E_RATE_LIMITED",
    INSTANCE_STARTING: "E_INSTANCE_STARTING",
    INSTANCE_UNMANAGED: "E_INSTANCE_UNMANAGED",
    INSTANCE_UNAVAILABLE: "E_INSTANCE_UNAVAILABLE",
    LEASE_CONFLICT: "E_LEASE",
    EXTERNAL_SESSION: "E_EXTERNAL_SESSION",
    SESSION_NOT_FOUND: "E_SESSION_NOT_FOUND",
    ATTENTION_RESOLVED: "E_ATTENTION_RESOLVED",
    UNSUPPORTED: "E_UNSUPPORTED",
    INTERNAL: "E_INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function errorBody(code: ErrorCode | string, message: string, retryable = false, details?: Record<string, unknown>) {
    return { code, message, retryable, ...(details ? { details } : {}) };
}
