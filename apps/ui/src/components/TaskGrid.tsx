import { Link } from 'react-router-dom'

/**
 * The dashboard's task grid.
 *
 * The page used to carry a row of four totals under its own heading. Those
 * numbers were accurate and inert: "65 assets" answers nothing on its own, and
 * it sat three sections away from the search box that would act on it.
 *
 * Here each number is attached to the job that uses it, so a tile states a task
 * and its current scale in one read — "Find where an asset is used · across 65
 * indexed assets". That removes a whole section rather than adding one.
 *
 * Bento sizing is by importance, not by decoration. Auditing is the widest tile
 * because nothing else in the tool works until it has run, and reverse lookup is
 * next because it is the question people actually arrive with. The remaining
 * tiles are peers and share a row.
 */

export interface Task {
  title: string
  /** What the person gets, in their words, not the system's. */
  body: string
  to: string
  /** Live figure for scale. Omitted when there is nothing meaningful to say. */
  metric?: { value: string; label: string } | undefined
  /** Grid span at `sm` and up. Tiles are full width on a phone regardless. */
  span: 'full' | 'half'
  tone?: 'primary' | 'default'
  /** Shown instead of the metric when the feature needs credentials. */
  gated?: string | undefined
}

export function TaskGrid({ tasks }: { tasks: readonly Task[] }): JSX.Element {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {tasks.map((task) => (
        <li key={task.title} className={task.span === 'full' ? 'sm:col-span-2' : undefined}>
          <TaskTile task={task} />
        </li>
      ))}
    </ul>
  )
}

function TaskTile({ task }: { task: Task }): JSX.Element {
  const primary = task.tone === 'primary'

  return (
    <Link
      to={task.to}
      className={[
        'group flex h-full flex-col justify-between gap-4 rounded-lg border p-4 transition-colors',
        primary
          ? 'border-brand-200 bg-brand-50 hover:border-brand-600'
          : 'border-ink-200 bg-white shadow-card hover:border-brand-300',
      ].join(' ')}
    >
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <h3
            className={[
              'text-sm font-semibold',
              primary ? 'text-brand-800' : 'text-ink-900',
            ].join(' ')}
          >
            {task.title}
          </h3>
          <span
            aria-hidden="true"
            className={[
              'shrink-0 text-sm transition-transform group-hover:translate-x-0.5',
              primary ? 'text-brand-600' : 'text-ink-400',
            ].join(' ')}
          >
            →
          </span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-ink-600">{task.body}</p>
      </div>

      {task.gated ? (
        <p className="text-label font-medium uppercase tracking-wide text-caution-700">
          {task.gated}
        </p>
      ) : task.metric ? (
        <p className="text-xs text-ink-500">
          <span className="font-semibold tabular-nums text-ink-800">{task.metric.value}</span>{' '}
          {task.metric.label}
        </p>
      ) : null}
    </Link>
  )
}
