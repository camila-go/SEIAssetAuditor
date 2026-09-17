import { type UseQueryResult } from '@tanstack/react-query';
import type { AuditJobStatusResponse, AuditResultRow, AssetWithReferences, DuplicateGroup, PageAppearance, PaginationMeta, ProgramCoverage, PublicVideoSubmission, TestimonialWithReferences, VideoSubmissionDetail } from '@capella/types';
import type { MatchReason } from '../components/MatchReason';
/** All server state goes through React Query — never into Zustand. */
export declare const queryKeys: {
    auditJobs: readonly ["audit", "list"];
    auditStatus: (jobId: string) => readonly ["audit", string, "status"];
    auditResults: (jobId: string, filters: unknown) => readonly ["audit", string, "results", unknown];
    auditFailures: (jobId: string) => readonly ["audit", string, "failures"];
    assets: (filters: unknown) => readonly ["assets", unknown];
    asset: (id: string) => readonly ["assets", string];
    lookup: (path: string) => readonly ["lookup", string];
    imageCoverage: readonly ["lookup", "image", "coverage"];
    duplicates: (threshold: number) => readonly ["duplicates", number];
    testimonials: (filters: unknown) => readonly ["testimonials", unknown];
    testimonial: (id: string) => readonly ["testimonials", string];
    coverage: readonly ["programs", "coverage"];
    searchIndex: readonly ["search-index"];
    stats: readonly ["stats"];
    intakeQueue: (filters: unknown) => readonly ["intake", unknown];
    intakeDetail: (id: string) => readonly ["intake", string];
    intakeConfig: readonly ["intake", "config"];
    publicSubmission: (id: string) => readonly ["intake", string, "public"];
    resubmissionTemplate: (id: string) => readonly ["intake", string, "template"];
};
export interface AuditJobSummary {
    id: string;
    name: string;
    status: AuditJobStatusResponse['status'];
    inputType: 'paste' | 'csv_upload' | 'sitemap';
    totalUrls: number;
    completedUrls: number;
    failedUrls: number;
    createdAt: string;
    completedAt: string | null;
}
export declare function useAuditJobs(limit?: number): UseQueryResult<AuditJobSummary[]>;
/**
 * Poll job status every 3 seconds while the job is live, then stop.
 * Polling a finished job forever would be a slow leak across open tabs.
 */
export declare function useAuditStatus(jobId: string): UseQueryResult<AuditJobStatusResponse>;
export interface AuditResultFilters {
    page: number;
    limit: number;
    urlStatus?: string;
    liveStatus?: string;
}
export declare function useAuditResults(jobId: string, filters: AuditResultFilters, isLive: boolean): UseQueryResult<{
    rows: AuditResultRow[];
    meta?: PaginationMeta;
}>;
export declare function useAuditFailures(jobId: string, enabled: boolean): UseQueryResult<Array<{
    url: string;
    error: string | null;
    processedAt: string | null;
}>>;
export interface CreateAuditResult {
    jobId: string;
    status: 'queued';
    totalUrls: number;
}
export declare function useCreateAudit(): import("@tanstack/react-query").UseMutationResult<CreateAuditResult, Error, {
    urls?: string;
    sitemapUrl?: string;
    file?: File;
    name?: string;
}, unknown>;
export declare function useCancelAudit(jobId: string): import("@tanstack/react-query").UseMutationResult<{
    cancelled: boolean;
}, Error, void, unknown>;
export interface AssetSummary {
    id: string;
    aemPath: string;
    filename: string;
    assetType: string;
    publicUrl: string;
    width: number | null;
    height: number | null;
    fileSize: number | null;
    tags: string[];
    lastSeenAt: string | null;
    referenceCount: number;
    matchReasons: MatchReason[];
    similarity?: number;
}
export declare function useAssets(filters: {
    query?: string;
    assetType?: string;
    page: number;
    limit: number;
}): UseQueryResult<{
    assets: AssetSummary[];
    meta?: PaginationMeta;
}>;
export declare function useAsset(id: string): UseQueryResult<AssetWithReferences>;
export declare function useReverseLookup(path: string, enabled: boolean): UseQueryResult<AssetWithReferences>;
export interface ImageSearchCoverage {
    totalImages: number;
    hashedImages: number;
}
export declare function useDuplicates(threshold: number): UseQueryResult<{
    groups: DuplicateGroup[];
    coverage: ImageSearchCoverage;
}>;
export type MatchConfidence = 'exact' | 'near_identical' | 'very_similar' | 'similar';
export interface ImageMatch {
    assetId: string;
    aemPath: string;
    filename: string;
    publicUrl: string;
    width: number | null;
    height: number | null;
    fileSize: number | null;
    distance: number;
    similarity: number;
    confidence: MatchConfidence;
    referenceCount: number;
    pages: PageAppearance[];
}
export interface ImageSearchResult {
    queryPhash: string;
    threshold: number;
    matches: ImageMatch[];
    coverage: ImageSearchCoverage;
}
export declare function useImageCoverage(): UseQueryResult<ImageSearchCoverage>;
/**
 * Reverse image search. Takes either a File (uploaded) or an image URL.
 * A mutation rather than a query — it is an explicit user action with a body.
 */
export declare function useImageSearch(): import("@tanstack/react-query").UseMutationResult<ImageSearchResult, Error, {
    file?: File;
    imageUrl?: string;
    threshold?: number;
}, unknown>;
/** Kick off the pHash sweep so more of the DAM becomes searchable by image. */
export declare function useIndexImages(): import("@tanstack/react-query").UseMutationResult<{
    queued: boolean;
    coverage: ImageSearchCoverage;
}, Error, void, unknown>;
export interface TestimonialSummary {
    id: string;
    quoteText: string;
    studentName: string | null;
    program: string | null;
    degreeLevel: string | null;
    sourceType: 'structured_component' | 'hardcoded_text';
    needsReview: boolean;
    isActive: boolean;
    firstSeenAt: string;
    lastSeenAt: string;
    daysSinceLastSeen: number;
    referenceCount: number;
    matchReasons: MatchReason[];
    similarity?: number;
}
export declare function useTestimonials(filters: {
    query?: string;
    program?: string;
    sourceType?: string;
    needsReview?: boolean;
    page: number;
    limit: number;
}): UseQueryResult<{
    testimonials: TestimonialSummary[];
    meta?: PaginationMeta;
}>;
export declare function useTestimonial(id: string): UseQueryResult<TestimonialWithReferences>;
export declare function useProgramCoverage(): UseQueryResult<ProgramCoverage[]>;
export interface SearchIndexStatus {
    enabled: boolean;
    model: string;
    testimonials: {
        total: number;
        embedded: number;
    };
    assets: {
        total: number;
        embedded: number;
    };
}
/** How much of the corpus can be matched by meaning. */
export declare function useSearchIndex(): UseQueryResult<SearchIndexStatus>;
/** Queue an embedding sweep so semantic search has something to match. */
export declare function useBuildSearchIndex(): import("@tanstack/react-query").UseMutationResult<{
    queued: boolean;
}, Error, void, unknown>;
export interface DashboardStats {
    assets: {
        totalAssets: number;
        totalPages: number;
        publishedPages: number;
    };
    testimonials: {
        totalTestimonials: number;
        needingReview: number;
        stale: number;
    };
    intake: {
        pending: number;
        approved: number;
        rejected: number;
    } | null;
}
export declare function useDashboardStats(): UseQueryResult<DashboardStats>;
export interface IntakeConfig {
    legalTermsUrl: string;
    maxVideoBytes: number;
    maxLegalDocBytes: number;
    acceptedVideoTypes: readonly string[];
    intakeEnabled: boolean;
}
export declare function useIntakeConfig(): UseQueryResult<IntakeConfig>;
export declare function useIntakeQueue(filters: {
    status?: string;
    page: number;
    limit: number;
}): UseQueryResult<{
    submissions: VideoSubmissionDetail[];
    meta?: PaginationMeta;
}>;
export declare function useSubmission(id: string): UseQueryResult<VideoSubmissionDetail>;
export declare function usePublicSubmission(id: string): UseQueryResult<PublicVideoSubmission>;
export interface ResubmissionTemplate {
    parentSubmissionId: string;
    rejectionReason: string | null;
    metadata: Record<string, string>;
}
export declare function useResubmissionTemplate(id: string): UseQueryResult<ResubmissionTemplate>;
export declare function useApprovalDecision(submissionId: string): import("@tanstack/react-query").UseMutationResult<VideoSubmissionDetail, Error, {
    decision: "approved" | "rejected";
    approverType: "legal" | "marketing";
    reason?: string;
}, unknown>;
//# sourceMappingURL=queries.d.ts.map