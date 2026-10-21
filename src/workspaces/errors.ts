import type { ErrorCode } from "../protocol/errors.js";

/** Error raised by the workspace registry / discovery / store layer. */
export class WorkspaceError extends Error {
    readonly code: ErrorCode | string;
    readonly retryable: boolean;

    constructor(code: ErrorCode | string, message: string, retryable = false, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "WorkspaceError";
        this.code = code;
        this.retryable = retryable;
    }
}
