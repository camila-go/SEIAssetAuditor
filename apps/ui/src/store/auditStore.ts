import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Cross-page audit session state.
 *
 * Only the identity of recently started jobs lives here — server data
 * (progress, results) belongs to React Query. Persisted to localStorage so
 * closing the tab and coming back still surfaces the running job, which is the
 * whole point of the background-job design.
 */

export interface TrackedJob {
  jobId: string
  name: string
  totalUrls: number
  startedAt: string
}

interface AuditState {
  recentJobs: TrackedJob[]
  trackJob: (job: TrackedJob) => void
  forgetJob: (jobId: string) => void
}

const MAX_TRACKED = 10

export const useAuditStore = create<AuditState>()(
  persist(
    (set) => ({
      recentJobs: [],

      trackJob: (job) =>
        set((state) => ({
          recentJobs: [job, ...state.recentJobs.filter((entry) => entry.jobId !== job.jobId)].slice(
            0,
            MAX_TRACKED,
          ),
        })),

      forgetJob: (jobId) =>
        set((state) => ({
          recentJobs: state.recentJobs.filter((entry) => entry.jobId !== jobId),
        })),
    }),
    { name: 'capella.auditSession' },
  ),
)
