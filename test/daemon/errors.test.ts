import { describe, expect, it } from "vitest";
import { DaemonError, isRetryableCode, statusForCode, toErrorPayload } from "../../src/daemon/errors.js";
import { ERROR_CODES } from "../../src/protocol/errors.js";

describe("protocol error mapping", () => {
    const expected: [string, number][] = [
        [ERROR_CODES.BAD_REQUEST, 400],
        [ERROR_CODES.UNAUTHORIZED, 401],
        [ERROR_CODES.FORBIDDEN, 403],
        [ERROR_CODES.NOT_FOUND, 404],
        [ERROR_CODES.METHOD_NOT_ALLOWED, 405],
        [ERROR_CODES.PROTOCOL_VERSION, 426],
        [ERROR_CODES.PAYLOAD_TOO_LARGE, 413],
        [ERROR_CODES.RATE_LIMITED, 429],
        [ERROR_CODES.INSTANCE_STARTING, 409],
        [ERROR_CODES.INSTANCE_UNMANAGED, 409],
        [ERROR_CODES.INSTANCE_UNAVAILABLE, 503],
        [ERROR_CODES.LEASE_CONFLICT, 409],
        [ERROR_CODES.EXTERNAL_SESSION, 409],
        [ERROR_CODES.SESSION_NOT_FOUND, 404],
        [ERROR_CODES.ATTENTION_RESOLVED, 409],
        [ERROR_CODES.UNSUPPORTED, 501],
        [ERROR_CODES.INTERNAL, 500],
    ];

    it("maps every stable code to the documented HTTP status", () => {
        for (const [code, status] of expected) expect(statusForCode(code)).toBe(status);
        expect(statusForCode("E_WHATEVER")).toBe(500);
    });

    it("marks only instance-starting/unavailable as retryable", () => {
        expect(isRetryableCode(ERROR_CODES.INSTANCE_STARTING)).toBe(true);
        expect(isRetryableCode(ERROR_CODES.INSTANCE_UNAVAILABLE)).toBe(true);
        expect(isRetryableCode(ERROR_CODES.LEASE_CONFLICT)).toBe(false);
        expect(isRetryableCode(ERROR_CODES.BAD_REQUEST)).toBe(false);
    });

    it("wraps unknown thrown values as internal errors", () => {
        const mapped = toErrorPayload(new Error("boom"));
        expect(mapped.status).toBe(500);
        expect(mapped.body).toMatchObject({ code: ERROR_CODES.INTERNAL, retryable: false, message: "boom" });

        const forbidden = new DaemonError(ERROR_CODES.FORBIDDEN, "nope", { details: { origin: "x" } });
        expect(toErrorPayload(forbidden).body).toMatchObject({ code: ERROR_CODES.FORBIDDEN, details: { origin: "x" } });
    });
});
