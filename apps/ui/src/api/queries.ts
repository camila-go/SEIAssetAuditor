import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type {
  AuditJobStatusResponse,
  AuditResultRow,
  AssetWithReferences,
  DuplicateGroup,
  PageAppearance,
  PaginationMeta,
  ProgramCoverage,
  PublicVideoSubmission,
  TestimonialWithReferences,
  VideoSubmissionDetail,
} from '@capella/types'
import { api, hasInternalCredentials, qs } from './client'
import type { MatchReason } from '../components/MatchReason'

/** All server state goes through React Query — never into Zustand. */

export const queryKeys = {
  auditJobs: ['audit', 'list'] as const,
  auditStatus: (jobId: string) => ['audit', jobId, 'status'] as const,
  auditResults: (jobId: string, filters: unknown) => ['audit', jobId, 'results', filters] as const,
  auditFailures: (jobId: string) => ['audit', jobId, 'failures'] as const,
  assets: (filters: unknown) => ['assets', filters] as const,
  asset: (id: string) => ['assets', id] as const,
  lookup: (path: string) => ['lookup', path] as const,
  imageCoverage: ['lookup', 'image', 'coverage'] as const,
  duplicates: (threshold: number) => ['duplicates', threshold] as const,
  testimonials: (filters: unknown) => ['testimonials', filters] as const,
  testimonial: (id: string) => ['testimonials', id] as const,
  coverage: ['programs', 'coverage'] as const,
  searchIndex: ['search-index'] as const,
  stats: ['stats'] as const,
  intakeQueue: (filters: unknown) => ['intake', filters] as const,
  intakeDetail: (id: string) => ['intake', id] as const,
  intakeConfig: ['intake', 'config'] as const,
  publicSubmission: (id: string) => ['intake', id, 'public'] as const,
  resubmissionTemplate: (id: string) => ['intake', id, 'template'] as const,
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export interface AuditJobSummary {
  id: string
  name: string
  status: AuditJobStatusResponse['status']
  inputType: 'paste' | 'csv_upload' | 'sitemap'
  totalUrls: number
  completedUrls: number
  failedUrls: number
  createdAt: string
  completedAt: string | null
}

export function useAuditJobs(limit = 10): UseQueryResult<AuditJobSummary[]> {
  return useQuery({
    queryKey: queryKeys.auditJobs,
    queryFn: async () => (await api.get<AuditJobSummary[]>(`/audit${qs({ limit })}`)).data,
  })
}

/**
 * Poll job status every 3 seconds while the job is live, then stop.
 * Polling a finished job forever would be a slow leak across open tabs.
 */
export function useAuditStatus(jobId: string): UseQueryResult<AuditJobStatusResponse> {
  return useQuery({
    queryKey: queryKeys.auditStatus(jobId),
    queryFn: async () => (await api.get<AuditJobStatusResponse>(`/audit/${jobId}/status`)).data,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'queued' || status === 'running' ? 3_000 : false
    },
    // Keep polling while the tab is backgrounded — the user is told they can
    // close the tab, so coming back should show current progress immediately.
    refetchIntervalInBackground: true,
  })
}

export interface AuditResultFilters {
  page: number
  limit: number
  urlStatus?: string
  liveStatus?: string
}

export function useAuditResults(
  jobId: string,
  filters: AuditResultFilters,
  isLive: boolean,
): UseQueryResult<{ rows: AuditResultRow[]; meta?: PaginationMeta }> {
  return useQuery({
    queryKey: queryKeys.auditResults(jobId, filters),
    queryFn: async () => {
      const response = await api.get<AuditResultRow[]>(`/audit/${jobId}/results${qs({ ...filters })}`)
      return { rows: response.data, meta: response.meta }
    },
    // Results stream in as batches land, so refresh alongside the status poll.
    refetchInterval: isLive ? 5_000 : false,
    placeholderData: (previous) => previous,
  })
}

export function useAuditFailures(
  jobId: string,
  enabled: boolean,
): UseQueryResult<Array<{ url: string; error: string | null; processedAt: string | null }>> {
  return useQuery({
    queryKey: queryKeys.auditFailures(jobId),
    queryFn: async () =>
      (await api.get<Array<{ url: string; error: string | null; processedAt: string | null }>>(
        `/audit/${jobId}/failures`,
      )).data,
    enabled,
  })
}

export interface CreateAuditResult {
  jobId: string
  status: 'queued'
  totalUrls: number
}

export function useCreateAudit() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: { urls?: string; sitemapUrl?: string; file?: File; name?: string }) => {
      if (input.file) {
        const form = new FormData()
        if (input.name) form.append('name', input.name)
        form.append('file', input.file)
        return (await api.post<CreateAuditResult>('/audit', form)).data
      }

      return (
        await api.post<CreateAuditResult>('/audit', {
          ...(input.urls ? { urls: input.urls } : {}),
          ...(input.sitemapUrl ? { sitemapUrl: input.sitemapUrl } : {}),
          ...(input.name ? { name: input.name } : {}),
        })
      ).data
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.auditJobs }),
  })
}

export function useCancelAudit(jobId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => (await api.post<{ cancelled: boolean }>(`/audit/${jobId}/cancel`)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditStatus(jobId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditJobs })
    },
  })
}

// ─── Assets ──────────────────────────────────────────────────────────────────

export interface AssetSummary {
  id: string
  aemPath: string
  filename: string
  assetType: string
  publicUrl: string
  width: number | null
  height: number | null
  fileSize: number | null
  tags: string[]
  lastSeenAt: string | null
  referenceCount: number
  matchReasons: MatchReason[]
  similarity?: number
}

export function useAssets(filters: {
  query?: string
  assetType?: string
  page: number
  limit: number
}): UseQueryResult<{ assets: AssetSummary[]; meta?: PaginationMeta }> {
  return useQuery({
    queryKey: queryKeys.assets(filters),
    queryFn: async () => {
      const response = await api.get<AssetSummary[]>(`/assets${qs({ ...filters })}`)
      return { assets: response.data, meta: response.meta }
    },
    placeholderData: (previous) => previous,
  })
}

export function useAsset(id: string): UseQueryResult<AssetWithReferences> {
  return useQuery({
    queryKey: queryKeys.asset(id),
    queryFn: async () => (await api.get<AssetWithReferences>(`/assets/${id}`)).data,
  })
}

export function useReverseLookup(path: string, enabled: boolean): UseQueryResult<AssetWithReferences> {
  return useQuery({
    queryKey: queryKeys.lookup(path),
    queryFn: async () => (await api.get<AssetWithReferences>(`/lookup${qs({ path })}`)).data,
    enabled,
    // A path either resolves or it doesn't; retrying a 404 just delays the message.
    retry: false,
  })
}

export interface ImageSearchCoverage {
  totalImages: number
  hashedImages: number
}

export function useDuplicates(
  threshold: number,
): UseQueryResult<{ groups: DuplicateGroup[]; coverage: ImageSearchCoverage }> {
  return useQuery({
    queryKey: queryKeys.duplicates(threshold),
    queryFn: async () =>
      (
        await api.get<{ groups: DuplicateGroup[]; coverage: ImageSearchCoverage }>(
          `/duplicates${qs({ threshold })}`,
        )
      ).data,
    retry: false,
  })
}

// ─── Reverse image search ────────────────────────────────────────────────────

export type MatchConfidence = 'exact' | 'near_identical' | 'very_similar' | 'similar'

export interface ImageMatch {
  assetId: string
  aemPath: string
  filename: string
  publicUrl: string
  width: number | null
  height: number | null
  fileSize: number | null
  distance: number
  similarity: number
  confidence: MatchConfidence
  referenceCount: number
  pages: PageAppearance[]
}

export interface ImageSearchResult {
  queryPhash: string
  threshold: number
  matches: ImageMatch[]
  coverage: ImageSearchCoverage
}

export function useImageCoverage(): UseQueryResult<ImageSearchCoverage> {
  return useQuery({
    queryKey: queryKeys.imageCoverage,
    queryFn: async () => (await api.get<ImageSearchCoverage>('/lookup/image/coverage')).data,
  })
}

/**
 * Reverse image search. Takes either a File (uploaded) or an image URL.
 * A mutation rather than a query — it is an explicit user action with a body.
 */
export function useImageSearch() {
  return useMutation({
    mutationFn: async (input: {
      file?: File
      imageUrl?: string
      threshold?: number
    }): Promise<ImageSearchResult> => {
      if (input.file) {
        const form = new FormData()
        form.append('image', input.file)
        if (input.threshold !== undefined) form.append('threshold', String(input.threshold))
        return (await api.post<ImageSearchResult>('/lookup/image', form)).data
      }

      return (
        await api.post<ImageSearchResult>('/lookup/image', {
          imageUrl: input.imageUrl,
          ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
        })
      ).data
    },
  })
}

/** Kick off the pHash sweep so more of the DAM becomes searchable by image. */
export function useIndexImages() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      (await api.post<{ queued: boolean; coverage: ImageSearchCoverage }>('/assets/index-images'))
        .data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.imageCoverage })
      void queryClient.invalidateQueries({ queryKey: ['duplicates'] })
    },
  })
}

// ─── Testimonials ────────────────────────────────────────────────────────────

export interface TestimonialSummary {
  id: string
  quoteText: string
  studentName: string | null
  program: string | null
  degreeLevel: string | null
  sourceType: 'structured_component' | 'hardcoded_text'
  needsReview: boolean
  isActive: boolean
  firstSeenAt: string
  lastSeenAt: string
  daysSinceLastSeen: number
  referenceCount: number
  matchReasons: MatchReason[]
  similarity?: number
}

export function useTestimonials(filters: {
  query?: string
  program?: string
  sourceType?: string
  needsReview?: boolean
  page: number
  limit: number
}): UseQueryResult<{ testimonials: TestimonialSummary[]; meta?: PaginationMeta }> {
  return useQuery({
    queryKey: queryKeys.testimonials(filters),
    queryFn: async () => {
      const response = await api.get<TestimonialSummary[]>(`/testimonials${qs({ ...filters })}`)
      return { testimonials: response.data, meta: response.meta }
    },
    placeholderData: (previous) => previous,
  })
}

export function useTestimonial(id: string): UseQueryResult<TestimonialWithReferences> {
  return useQuery({
    queryKey: queryKeys.testimonial(id),
    queryFn: async () => (await api.get<TestimonialWithReferences>(`/testimonials/${id}`)).data,
  })
}

export function useProgramCoverage(): UseQueryResult<ProgramCoverage[]> {
  return useQuery({
    queryKey: queryKeys.coverage,
    queryFn: async () => (await api.get<ProgramCoverage[]>('/programs/coverage')).data,
    retry: false,
  })
}

export interface SearchIndexStatus {
  enabled: boolean
  model: string
  testimonials: { total: number; embedded: number }
  assets: { total: number; embedded: number }
}

/** How much of the corpus can be matched by meaning. */
export function useSearchIndex(): UseQueryResult<SearchIndexStatus> {
  return useQuery({
    queryKey: queryKeys.searchIndex,
    queryFn: async () =>
      (await api.get<SearchIndexStatus>('/testimonials/search-index')).data,
    staleTime: 60_000,
  })
}

/** Queue an embedding sweep so semantic search has something to match. */
export function useBuildSearchIndex() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () =>
      (await api.post<{ queued: boolean }>('/testimonials/search-index')).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.searchIndex })
    },
  })
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardStats {
  assets: { totalAssets: number; totalPages: number; publishedPages: number }
  testimonials: { totalTestimonials: number; needingReview: number; stale: number }
  intake: { pending: number; approved: number; rejected: number } | null
}

export function useDashboardStats(): UseQueryResult<DashboardStats> {
  return useQuery({
    queryKey: queryKeys.stats,
    queryFn: async (): Promise<DashboardStats> => {
      const [assets, testimonials] = await Promise.all([
        api.get<DashboardStats['assets']>('/assets/stats'),
        api.get<DashboardStats['testimonials']>('/testimonials/stats'),
      ])

      // The intake tile needs approver credentials. A designer who only runs
      // audits has none, which is the normal case — so this degrades to null
      // rather than failing the whole dashboard.
      //
      // Checked before calling rather than after failing: firing a request we
      // know will 401 filled the console with red errors on every dashboard
      // load, which reads as a broken tool to anyone who opens devtools. The
      // try/catch stays for a token that has expired or been revoked.
      let intake: DashboardStats['intake'] = null
      if (hasInternalCredentials()) {
        try {
          intake = (await api.get<NonNullable<DashboardStats['intake']>>('/intake/stats')).data
        } catch {
          intake = null
        }
      }

      return { assets: assets.data, testimonials: testimonials.data, intake }
    },
  })
}

// ─── Intake ──────────────────────────────────────────────────────────────────

export interface IntakeConfig {
  legalTermsUrl: string
  maxVideoBytes: number
  maxLegalDocBytes: number
  acceptedVideoTypes: readonly string[]
  intakeEnabled: boolean
}

export function useIntakeConfig(): UseQueryResult<IntakeConfig> {
  return useQuery({
    queryKey: queryKeys.intakeConfig,
    queryFn: async () => (await api.get<IntakeConfig>('/intake/config')).data,
    staleTime: 5 * 60_000,
  })
}

export function useIntakeQueue(filters: {
  status?: string
  page: number
  limit: number
}): UseQueryResult<{ submissions: VideoSubmissionDetail[]; meta?: PaginationMeta }> {
  return useQuery({
    queryKey: queryKeys.intakeQueue(filters),
    queryFn: async () => {
      const response = await api.get<VideoSubmissionDetail[]>(`/intake${qs({ ...filters })}`)
      return { submissions: response.data, meta: response.meta }
    },
    retry: false,
    placeholderData: (previous) => previous,
  })
}

export function useSubmission(id: string): UseQueryResult<VideoSubmissionDetail> {
  return useQuery({
    queryKey: queryKeys.intakeDetail(id),
    queryFn: async () => (await api.get<VideoSubmissionDetail>(`/intake/${id}`)).data,
    // While a transcript is generating, refresh so the section fills in on its own.
    refetchInterval: (query) => {
      const status = query.state.data?.transcriptStatus
      return status === 'pending' || status === 'processing' ? 10_000 : false
    },
    retry: false,
  })
}

export function usePublicSubmission(id: string): UseQueryResult<PublicVideoSubmission> {
  return useQuery({
    queryKey: queryKeys.publicSubmission(id),
    queryFn: async () => (await api.get<PublicVideoSubmission>(`/intake/${id}/public`)).data,
    retry: false,
  })
}

export interface ResubmissionTemplate {
  parentSubmissionId: string
  rejectionReason: string | null
  metadata: Record<string, string>
}

export function useResubmissionTemplate(id: string): UseQueryResult<ResubmissionTemplate> {
  return useQuery({
    queryKey: queryKeys.resubmissionTemplate(id),
    queryFn: async () =>
      (await api.get<ResubmissionTemplate>(`/intake/${id}/resubmission-template`)).data,
    retry: false,
  })
}

export function useApprovalDecision(submissionId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: {
      decision: 'approved' | 'rejected'
      approverType: 'legal' | 'marketing'
      reason?: string
    }) => {
      const path = input.decision === 'approved' ? 'approve' : 'reject'
      return (
        await api.post<VideoSubmissionDetail>(`/intake/${submissionId}/${path}`, {
          approverType: input.approverType,
          ...(input.reason ? { reason: input.reason } : {}),
        })
      ).data
    },
    onSuccess: (detail) => {
      queryClient.setQueryData(queryKeys.intakeDetail(submissionId), detail)
      void queryClient.invalidateQueries({ queryKey: ['intake'] })
    },
  })
}
