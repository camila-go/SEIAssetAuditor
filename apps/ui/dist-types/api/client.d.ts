import type { ApiErrorBody, PaginationMeta } from '@capella/types';
export declare class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details?: unknown;
    constructor(status: number, body: ApiErrorBody);
    /** A gated Phase 2/3 feature rather than a failure — the UI shows a notice, not an error. */
    get isNotConfigured(): boolean;
}
export declare function setInternalCredentials(token: string, email: string): void;
export declare function getApproverEmail(): string | null;
export declare function hasInternalCredentials(): boolean;
export declare const api: {
    get: <T>(path: string) => Promise<{
        data: T;
        meta?: PaginationMeta;
    }>;
    post: <T>(path: string, body?: unknown) => Promise<{
        data: T;
        meta?: PaginationMeta;
    }>;
};
/** Build a query string, omitting empty values so the URL stays readable. */
export declare function qs(params: Record<string, string | number | boolean | undefined | null>): string;
//# sourceMappingURL=client.d.ts.map