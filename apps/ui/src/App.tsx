import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Layout, PublicLayout } from './components/Layout'
import { Skeleton } from './components/States'

/**
 * Routes are code-split so a vendor loading the public intake form never
 * downloads the internal audit tool's bundle.
 */
const Dashboard = lazy(() => import('./pages/Dashboard'))
const StartAudit = lazy(() => import('./pages/StartAudit'))
const AuditJob = lazy(() => import('./pages/AuditJob'))
const Lookup = lazy(() => import('./pages/Lookup'))
const Assets = lazy(() => import('./pages/Assets'))
const AssetDetail = lazy(() => import('./pages/Assets').then((m) => ({ default: m.AssetDetail })))
const Duplicates = lazy(() => import('./pages/Duplicates'))
const Testimonials = lazy(() => import('./pages/Testimonials'))
const TestimonialDetail = lazy(() =>
  import('./pages/Testimonials').then((m) => ({ default: m.TestimonialDetail })),
)
const ProgramCoverage = lazy(() => import('./pages/ProgramCoverage'))
const AdminIntake = lazy(() => import('./pages/AdminIntake'))
const AdminIntakeDetail = lazy(() => import('./pages/AdminIntakeDetail'))
const IntakeForm = lazy(() => import('./pages/IntakeForm'))
const IntakeConfirm = lazy(() => import('./pages/IntakeConfirm'))

export function App(): JSX.Element {
  return (
    <Suspense fallback={<div className="mx-auto max-w-7xl p-6"><Skeleton rows={6} /></div>}>
      <Routes>
        {/* Public — no internal navigation, no login */}
        <Route element={<PublicLayout />}>
          <Route path="/intake" element={<IntakeForm />} />
          <Route path="/intake/confirm" element={<IntakeConfirm />} />
          <Route path="/intake/resubmit/:id" element={<IntakeForm />} />
        </Route>

        {/* Internal */}
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="/audit" element={<StartAudit />} />
          <Route path="/audit/:jobId" element={<AuditJob />} />
          <Route path="/lookup" element={<Lookup />} />
          <Route path="/assets" element={<Assets />} />
          <Route path="/assets/:id" element={<AssetDetail />} />
          <Route path="/duplicates" element={<Duplicates />} />
          <Route path="/testimonials" element={<Testimonials />} />
          <Route path="/testimonials/:id" element={<TestimonialDetail />} />
          <Route path="/programs/coverage" element={<ProgramCoverage />} />
          <Route path="/admin/intake" element={<AdminIntake />} />
          <Route path="/admin/intake/:id" element={<AdminIntakeDetail />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
