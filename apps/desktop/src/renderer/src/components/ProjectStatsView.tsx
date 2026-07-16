import { useEffect, useState } from 'react'

/**
 * Reusable read-only view of the opened project's stats: branch, last commit,
 * tracked-file count, and working-tree change counts. Designed to be embedded
 * anywhere a concise project summary is useful — currently the empty-chat
 * screen. Degrades gracefully: a non-git folder just shows fewer cards.
 */
export function ProjectStatsView({ cwd }: { cwd: string }): React.JSX.Element {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof window.codehamr.projectStats>> | null>(
    null,
  )
  const [initializing, setInitializing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.codehamr.projectStats(cwd).then((s) => {
      if (!cancelled) setStats(s)
    })
    return () => {
      cancelled = true
    }
  }, [cwd])

  // Still loading — hold the layout with an empty grid so we don't flash the
  // non-git card for a repo that's simply slow to report.
  if (stats === null) {
    return <div className="grid w-full grid-cols-2 gap-2.5 sm:grid-cols-3" />
  }

  // Non-git folder: offer to initialize a repository.
  if (!stats.isGitRepo) {
    return (
      <NoGitCard
        initializing={initializing}
        onInit={async () => {
          setInitializing(true)
          const ok = await window.codehamr.gitInit(cwd)
          setInitializing(false)
          if (ok) {
            // Re-fetch stats so the normal grid replaces this card in place.
            setStats(await window.codehamr.projectStats(cwd))
          }
        }}
      />
    )
  }

  const branch = stats.branch
  const tracked = stats.trackedFiles
  const modified = stats.modified
  const added = stats.added
  const untracked = stats.untracked
  const dirty = modified + added + untracked
  const diffAdded = stats.diffAdded
  const diffRemoved = stats.diffRemoved

  return (
    <div className="grid w-full grid-cols-2 gap-2.5 sm:grid-cols-3">
      {/* Branch */}
      <StatCard
        label="Branch"
        value={branch ?? '—'}
        mono
        accent={branch ? 'sky' : 'zinc'}
        icon={
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        }
      />

      {/* Last commit */}
      {stats.headSha && (
        <StatCard
          label="Last commit"
          value={stats.headSha}
          mono
          sub={
            stats.headSubject
              ? stats.headSubject.length > 40
                ? stats.headSubject.slice(0, 40) + '…'
                : stats.headSubject
              : undefined
          }
          sub2={
            [stats.headRelative, stats.headAuthorName].filter(Boolean).join(' · ') || undefined
          }
          accent="violet"
          icon={
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
            </svg>
          }
        />
      )}

      {/* Tracked files */}
      {tracked !== null && (
        <StatCard
          label="Tracked files"
          value={tracked.toLocaleString()}
          accent="zinc"
          icon={
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          }
        />
      )}

      {/* Working-tree changes */}
      <StatCard
        label="Uncommitted"
        value={dirty > 0 ? dirty.toLocaleString() : 'clean'}
        sub={
          dirty > 0
            ? [
                modified > 0 ? `${modified} mod` : null,
                added > 0 ? `${added} staged` : null,
                untracked > 0 ? `${untracked} new` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : undefined
        }
        accent={dirty > 0 ? 'amber' : 'emerald'}
        icon={
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        }
      />

      {/* Diffstat */}
      {(diffAdded > 0 || diffRemoved > 0) && (
        <StatCard
          label="Diff vs HEAD"
          value={
            <>
              <span className="text-emerald-400">+{diffAdded.toLocaleString()}</span>
              <span className="mx-1 text-zinc-600">/</span>
              <span className="text-red-400">-{diffRemoved.toLocaleString()}</span>
            </>
          }
          mono
          accent="zinc"
          icon={
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          }
        />
      )}
    </div>
  )
}

type Accent = 'zinc' | 'sky' | 'violet' | 'amber' | 'emerald'

const ACCENT_TEXT: Record<Accent, string> = {
  zinc: 'text-zinc-300',
  sky: 'text-sky-400',
  violet: 'text-violet-400',
  amber: 'text-amber-400',
  emerald: 'text-emerald-400',
}

const ACCENT_RING: Record<Accent, string> = {
  zinc: 'border-zinc-800',
  sky: 'border-sky-900/70',
  violet: 'border-violet-900/70',
  amber: 'border-amber-900/70',
  emerald: 'border-emerald-900/70',
}

/** A single stat tile — the reusable atom ProjectStatsView is built from. */
function StatCard({
  label,
  value,
  sub,
  sub2,
  mono,
  accent,
  icon,
}: {
  label: string
  value: React.ReactNode
  sub?: string
  sub2?: string
  mono?: boolean
  accent: Accent
  icon?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border ${ACCENT_RING[accent]} bg-zinc-900/60 px-3 py-2`}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {icon && <span className={ACCENT_TEXT[accent]}>{icon}</span>}
        {label}
      </div>
      <div
        className={`${mono ? 'font-mono' : ''} truncate text-sm ${ACCENT_TEXT[accent]}`}
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </div>
      {sub && (
        <div className="truncate text-[11px] text-zinc-500" title={sub}>
          {sub}
        </div>
      )}
      {sub2 && (
        <div className="truncate text-[11px] text-zinc-600" title={sub2}>
          {sub2}
        </div>
      )}
    </div>
  )
}

/** Full-width card shown when the opened folder isn't a git repository.
 *  Offers a one-click "Initialize repository" action (git init + empty commit)
 *  so the rest of the project stats — and the file tree's change indicators —
 *  light up immediately. */
function NoGitCard({
  initializing,
  onInit,
}: {
  initializing: boolean
  onInit: () => void
}): React.JSX.Element {
  return (
    <div className="flex w-full flex-col items-center gap-3 rounded-lg border border-amber-900/60 bg-zinc-900/60 px-4 py-6 text-center sm:col-span-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-900/30">
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5 text-amber-400"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium text-zinc-200">Not a git repository</p>
        <p className="mt-0.5 text-xs text-zinc-500">
          This folder isn't under version control. Initialize one to track changes, create
          checkpoints, and see diffs.
        </p>
      </div>
      <button
        onClick={onInit}
        disabled={initializing}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {initializing ? (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
        {initializing ? 'Initializing…' : 'Initialize repository'}
      </button>
    </div>
  )
}
