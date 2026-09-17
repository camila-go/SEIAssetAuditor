/**
 * Cross-page audit session state.
 *
 * Only the identity of recently started jobs lives here — server data
 * (progress, results) belongs to React Query. Persisted to localStorage so
 * closing the tab and coming back still surfaces the running job, which is the
 * whole point of the background-job design.
 */
export interface TrackedJob {
    jobId: string;
    name: string;
    totalUrls: number;
    startedAt: string;
}
interface AuditState {
    recentJobs: TrackedJob[];
    trackJob: (job: TrackedJob) => void;
    forgetJob: (jobId: string) => void;
}
export declare const useAuditStore: import("zustand").UseBoundStore<Omit<import("zustand").StoreApi<AuditState>, "persist"> & {
    persist: {
        setOptions: (options: Partial<import("zustand/middleware").PersistOptions<AuditState, AuditState>>) => void;
        clearStorage: () => void;
        rehydrate: () => Promise<void> | void;
        hasHydrated: () => boolean;
        onHydrate: (fn: (state: AuditState) => void) => () => void;
        onFinishHydration: (fn: (state: AuditState) => void) => () => void;
        getOptions: () => Partial<import("zustand/middleware").PersistOptions<AuditState, AuditState>>;
    };
}>;
export {};
//# sourceMappingURL=auditStore.d.ts.map