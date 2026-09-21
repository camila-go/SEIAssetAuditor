import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useIntakeConfig, useResubmissionTemplate } from '../api/queries'
import { ErrorState, Skeleton } from '../components/States'
import { formatBytes } from '../lib/format'
import { apiUrl } from '../api/client'

/**
 * `/intake` and `/intake/resubmit/:id` — the public submission form.
 *
 * No login. Nothing here reveals an AEM path or an internal identifier.
 *
 * The legal checkbox genuinely blocks submission: the button carries a real
 * `disabled` attribute, not just muted styling, and the server re-checks the
 * flag before reading a single byte of the upload.
 */

const PROGRAMS = [
  'Nursing',
  'Psychology',
  'Business',
  'Information Technology',
  'Education',
  'Social Work',
  'Public Health',
  'Counseling',
  'Other',
]

interface FormState {
  title: string
  description: string
  program: string
  campaign: string
  usageRights: string
  rightsExpiryDate: string
  submitterName: string
  submitterEmail: string
  submitterOrg: string
  notes: string
}

const EMPTY_FORM: FormState = {
  title: '',
  description: '',
  program: '',
  campaign: '',
  usageRights: '',
  rightsExpiryDate: '',
  submitterName: '',
  submitterEmail: '',
  submitterOrg: '',
  notes: '',
}

export default function IntakeForm(): JSX.Element {
  const { id: parentId } = useParams<{ id?: string }>()
  const navigate = useNavigate()

  const config = useIntakeConfig()
  const template = useResubmissionTemplate(parentId ?? '')

  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [video, setVideo] = useState<File | null>(null)
  const [legalDoc, setLegalDoc] = useState<File | null>(null)
  const [legalAgreed, setLegalAgreed] = useState(false)
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const legalAgreedAt = useRef<string | null>(null)

  // Pre-fill from the rejected submission when resubmitting.
  useEffect(() => {
    if (!parentId || !template.data) return
    setForm((current) => ({ ...current, ...(template.data.metadata as Partial<FormState>) }))
  }, [parentId, template.data])

  function update<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const isComplete =
    Object.entries(form).every(([key, value]) => key === 'notes' || value.trim().length > 0) &&
    video !== null

  // Both conditions must hold. The checkbox is not advisory.
  const canSubmit = isComplete && legalAgreed && uploadPercent === null

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!canSubmit || !video) return

    setError(null)
    setUploadPercent(0)

    try {
      const result = await uploadWithProgress({
        url: apiUrl(parentId ? `/intake/${parentId}/resubmit` : '/intake'),
        form,
        video,
        legalDoc,
        legalAgreedAt: legalAgreedAt.current ?? new Date().toISOString(),
        onProgress: setUploadPercent,
      })

      navigate(`/intake/confirm?id=${encodeURIComponent(result.id)}`)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed')
      setUploadPercent(null)
    }
  }

  if (config.isLoading) return <Skeleton rows={8} />
  if (config.isError) return <ErrorState error={config.error} />

  const settings = config.data

  if (settings && !settings.intakeEnabled) {
    return (
      <div className="rounded-lg border border-caution-200 bg-caution-50 p-6">
        <h1 className="text-lg font-semibold text-caution-900">Submissions are not open yet</h1>
        <p className="mt-2 text-sm text-caution-800">
          Video intake is still being set up. Please contact your Capella marketing contact to
          arrange a submission in the meantime.
        </p>
      </div>
    )
  }

  if (parentId && template.isLoading) return <Skeleton rows={8} />
  if (parentId && template.isError) return <ErrorState error={template.error} />

  return (
    <div>
      <h1 className="text-xl font-semibold text-ink-900">
        {parentId ? 'Resubmit your video' : 'Submit a video'}
      </h1>

      <p className="mt-2 rounded-md border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-900">
        Your video will be reviewed by Capella&apos;s legal and marketing teams before it appears
        anywhere on the site. You&apos;ll be emailed once a decision is made.
      </p>

      {parentId && template.data?.rejectionReason ? (
        <div className="mt-4 rounded-md border border-critical-200 bg-critical-50 px-4 py-3 text-sm">
          <p className="font-medium text-critical-900">Why your previous submission was not approved</p>
          <p className="mt-1 text-critical-800">{template.data.rejectionReason}</p>
        </div>
      ) : null}

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 space-y-5">
        <Text label="Title" value={form.title} onChange={(v) => update('title', v)} required />
        <Textarea
          label="Description"
          value={form.description}
          onChange={(v) => update('description', v)}
          required
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label htmlFor="program" required>
              Program
            </Label>
            <select
              id="program"
              required
              value={form.program}
              onChange={(event) => update('program', event.target.value)}
              className="mt-1 select-field"
            >
              <option value="">Choose a program…</option>
              {PROGRAMS.map((program) => (
                <option key={program} value={program}>
                  {program}
                </option>
              ))}
            </select>
          </div>

          <Text
            label="Campaign or project"
            value={form.campaign}
            onChange={(v) => update('campaign', v)}
            required
          />
        </div>

        <Textarea
          label="Usage rights"
          hint="Describe what this video may be used for, and any restrictions agreed with the people in it."
          value={form.usageRights}
          onChange={(v) => update('usageRights', v)}
          required
        />

        <div>
          <Label htmlFor="expiry" required>
            Usage rights expiry date
          </Label>
          <input
            id="expiry"
            type="date"
            required
            value={form.rightsExpiryDate}
            onChange={(event) => update('rightsExpiryDate', event.target.value)}
            className="mt-1 w-full max-w-xs rounded-md border border-ink-300 px-3 py-2 text-sm"
          />
        </div>

        <fieldset className="grid gap-5 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold text-ink-900">Your details</legend>
          <Text
            label="Your name"
            value={form.submitterName}
            onChange={(v) => update('submitterName', v)}
            required
          />
          <Text
            label="Email"
            type="email"
            hint="All notifications go to this address."
            value={form.submitterEmail}
            onChange={(v) => update('submitterEmail', v)}
            required
          />
          <Text
            label="Organization"
            hint="Your Capella department, or your agency name."
            value={form.submitterOrg}
            onChange={(v) => update('submitterOrg', v)}
            required
          />
        </fieldset>

        <Textarea
          label="Notes for reviewers"
          hint="Optional."
          value={form.notes}
          onChange={(v) => update('notes', v)}
        />

        {/* ── Video ──────────────────────────────────────────────────────── */}
        <div>
          <Label htmlFor="video" required>
            Video file
          </Label>
          <input
            id="video"
            type="file"
            required
            accept={settings?.acceptedVideoTypes.join(',') ?? 'video/mp4,video/quicktime,video/webm'}
            data-testid="intake-video"
            onChange={(event) => setVideo(event.target.files?.[0] ?? null)}
            className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-ink-100 file:px-3 file:py-2 file:text-sm"
          />
          <p className="mt-1 text-xs text-ink-500">
            MP4, MOV or WebM, up to {formatBytes(settings?.maxVideoBytes ?? 2 * 1024 ** 3)}.
            {video ? ` Selected: ${video.name} (${formatBytes(video.size)}).` : ''}
          </p>
        </div>

        {/* ── Legal agreement — directly above the submit button ──────────── */}
        <section className="rounded-lg border border-ink-300 bg-white p-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={legalAgreed}
              data-testid="intake-legal-checkbox"
              onChange={(event) => {
                setLegalAgreed(event.target.checked)
                // Recorded as a hint; the server stamps the authoritative time.
                legalAgreedAt.current = event.target.checked ? new Date().toISOString() : null
              }}
              className="mt-1 h-4 w-4 shrink-0 rounded border-ink-500"
            />
            <span className="text-sm text-ink-800">
              I agree to the{' '}
              <a
                href={settings?.legalTermsUrl ?? '#'}
                target="_blank"
                rel="noreferrer"
                className="text-brand-700 underline"
              >
                Terms of Video Submission
              </a>{' '}
              and confirm I have all necessary rights to submit this video.
            </span>
          </label>

          <div className="mt-4 border-t border-ink-200 pt-4">
            <Label htmlFor="legal-doc">Upload a signed agreement (optional)</Label>
            <p className="mb-1 text-xs text-ink-500">
              Supplementary only — a vendor contract or talent release. This does not replace the
              agreement above.
            </p>
            <input
              id="legal-doc"
              type="file"
              accept="application/pdf"
              onChange={(event) => setLegalDoc(event.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-ink-100 file:px-3 file:py-2 file:text-sm"
            />
            <p className="mt-1 text-xs text-ink-500">
              PDF only, up to {formatBytes(settings?.maxLegalDocBytes ?? 10 * 1024 ** 2)}.
            </p>
          </div>
        </section>

        {error ? (
          <p className="rounded-md bg-critical-50 px-4 py-3 text-sm text-critical-800" role="alert">
            {error}
          </p>
        ) : null}

        {uploadPercent !== null ? (
          <div>
            <div className="h-2 overflow-hidden rounded-full bg-ink-200">
              <div
                className="h-full bg-brand-600 transition-[width]"
                style={{ width: `${uploadPercent}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-ink-600">
              Uploading… {uploadPercent}%. Please keep this tab open until it finishes.
            </p>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          data-testid="intake-submit"
          className="w-full rounded-md bg-brand-600 px-4 py-3 text-sm font-medium text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-300 sm:w-auto"
        >
          {uploadPercent !== null ? 'Uploading…' : 'Submit for review'}
        </button>

        {!legalAgreed && isComplete ? (
          <p className="text-xs text-ink-600">
            Tick the agreement above to enable submission.
          </p>
        ) : null}
      </form>
    </div>
  )
}

/**
 * XHR rather than fetch: only XHR exposes upload progress events, and a 2GB
 * video over a slow connection needs a progress bar to be usable.
 */
function uploadWithProgress(options: {
  url: string
  form: FormState
  video: File
  legalDoc: File | null
  legalAgreedAt: string
  onProgress: (percent: number) => void
}): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const data = new FormData()

    // Order matters: the server starts streaming to AEM the moment the video
    // part opens, so every metadata field and the PDF must be appended first.
    for (const [key, value] of Object.entries(options.form)) {
      if (value) data.append(key, value)
    }
    data.append('legalAgreed', 'true')
    data.append('legalAgreedAt', options.legalAgreedAt)
    if (options.legalDoc) data.append('legalDoc', options.legalDoc)
    data.append('video', options.video)

    const request = new XMLHttpRequest()
    request.open('POST', options.url)
    request.setRequestHeader('Accept', 'application/json')

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        options.onProgress(Math.round((event.loaded / event.total) * 100))
      }
    })

    request.addEventListener('load', () => {
      let body: { data?: { id?: string }; error?: { message?: string } } = {}
      try {
        body = JSON.parse(request.responseText) as typeof body
      } catch {
        reject(new Error(`Server returned an unexpected response (HTTP ${request.status})`))
        return
      }

      if (request.status >= 200 && request.status < 300 && body.data?.id) {
        resolve({ id: body.data.id })
      } else {
        reject(new Error(body.error?.message ?? `Submission failed (HTTP ${request.status})`))
      }
    })

    request.addEventListener('error', () =>
      reject(new Error('Network error during upload. Check your connection and try again.')),
    )
    request.addEventListener('abort', () => reject(new Error('Upload cancelled')))

    request.send(data)
  })
}

// ─── Form primitives ─────────────────────────────────────────────────────────

function Label({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string
  required?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-700">
      {children}
      {required ? <span className="ml-1 text-critical-600">*</span> : null}
    </label>
  )
}

function Text({
  label,
  value,
  onChange,
  required,
  hint,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  hint?: string
  type?: string
}): JSX.Element {
  const id = label.toLowerCase().replace(/\s+/g, '-')
  return (
    <div>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <input
        id={id}
        type={type}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
      />
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </div>
  )
}

function Textarea({
  label,
  value,
  onChange,
  required,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  hint?: string
}): JSX.Element {
  const id = label.toLowerCase().replace(/\s+/g, '-')
  return (
    <div>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>
      <textarea
        id={id}
        rows={3}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-ink-300 px-3 py-2 text-sm"
      />
      {hint ? <p className="mt-1 text-xs text-ink-500">{hint}</p> : null}
    </div>
  )
}
