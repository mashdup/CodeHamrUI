import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangedPaths, GitChangeKind } from './workspace/useGitStatus'

/**
 * FileTree: a drill-in file browser for the open workspace. Instead of an
 * ever-expanding tree, clicking a folder navigates INTO it (showing just that
 * folder's contents); a breadcrumb bar walks back up. Files with uncommitted
 * git changes get a colored dot (amber = modified, green = added/untracked),
 * and so does any folder containing a changed file nested anywhere inside it,
 * so change indicators aren't buried below collapsed folders. Files the agent
 * edited this session but that git doesn't flag (e.g. reverted, or outside a
 * repo) fall back to an emerald "touched" dot. `reload` re-fetches the current
 * folder when it changes on disk.
 *
 * A single directory level is small enough to render directly (capped at CAP
 * rows), so there's no windowing/virtualization — the hand-rolled version left
 * ghost rows on navigation. Entries are cleared the instant the directory
 * changes so the previous folder's rows can never linger under the new path.
 */

interface Entry {
  name: string
  path: string
  isDir: boolean
}

// Cap on rows rendered for one directory. Real single-level folders rarely
// exceed this; beyond it we show a "first N of M" note rather than freezing the
// UI (a flat node_modules can hold thousands of entries).
const CAP = 2000

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

// The OS file-manager name, so menu labels read naturally per platform.
const revealLabel =
  window.codehamr.platform === 'darwin'
    ? 'Reveal in Finder'
    : window.codehamr.platform === 'win32'
      ? 'Reveal in Explorer'
      : 'Reveal in file manager'

interface Menu {
  x: number
  y: number
  entry: Entry
}

export function FileTree({
  root,
  touched,
  changed,
  reload,
  onOpen,
  onToast,
}: {
  root: string
  touched: Set<string>
  changed: ChangedPaths
  reload: { dirs: string[]; nonce: number } | null
  onOpen: (path: string) => void
  onToast?: (msg: string) => void
}): React.JSX.Element {
  const [dir, setDir] = useState(root)
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Guards against out-of-order navigation: a slow listing of a folder we've
  // already left must not overwrite the current one's contents.
  const reqRef = useRef(0)
  const load = useCallback(
    async (d: string): Promise<void> => {
      const token = ++reqRef.current
      setLoading(true)
      let result: Entry[]
      try {
        result = await window.codehamr.listDir(root, d)
      } catch {
        result = []
      }
      if (token === reqRef.current) {
        setEntries(result)
        setLoading(false)
      }
    },
    [root],
  )

  // Navigate to a directory. Clearing entries in the SAME state batch as the
  // dir change means the previous folder's rows are gone before React paints
  // the new path — no stale rows, not even for a frame.
  const navigate = useCallback((d: string): void => {
    setEntries([])
    setDir(d)
  }, [])

  // Open the right-click context menu for an entry, clamped to the viewport so
  // it never spills off-screen near the window's right/bottom edges.
  const openMenu = useCallback((e: React.MouseEvent, entry: Entry): void => {
    e.preventDefault()
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 200),
      y: Math.min(e.clientY, window.innerHeight - 200),
      entry,
    })
  }, [])

  // Dismiss the menu on any outside click, scroll, or Escape.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Focus and select the basename (not the extension... simplicity: whole
  // name) the moment the inline rename input mounts.
  useEffect(() => {
    if (!renaming) return
    const el = renameInputRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [renaming])

  const startRename = useCallback((entry: Entry): void => {
    setRenaming({ path: entry.path, value: entry.name })
  }, [])

  const commitRename = useCallback((): void => {
    if (!renaming) return
    const { path, value } = renaming
    const name = value.trim()
    setRenaming(null)
    const original = basename(path)
    if (!name || name === original) return
    void window.codehamr
      .renamePath(root, path, name)
      .then(() => load(dir))
      .catch((e: Error) => onToast?.(e.message))
  }, [renaming, root, dir, load, onToast])

  // Reset to the workspace root when the workspace changes.
  useEffect(() => {
    navigate(root)
  }, [root, navigate])

  // Load whenever the current directory changes; reset scroll to the top.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    void load(dir)
  }, [dir, load])

  // Re-fetch the current folder if it (or a file in it) changed on disk.
  useEffect(() => {
    if (reload && reload.dirs.includes(dir)) void load(dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload?.nonce])

  // Breadcrumb: root + each ancestor segment down to the current directory.
  const sep = dir.includes('\\') ? '\\' : '/'
  const rel = dir === root ? '' : dir.slice(root.length).replace(/^[\\/]+/, '')
  const parts = rel ? rel.split(/[\\/]/) : []
  const crumbs = [{ name: basename(root) || root, path: root }]
  let acc = root
  for (const p of parts) {
    acc = `${acc}${sep}${p}`
    crumbs.push({ name: p, path: acc })
  }

  const shown = entries.slice(0, CAP)

  // Color for a git change kind: amber = modified, green = added/untracked.
  // Inline hex (not a Tailwind class) so a dynamically-selected color can never
  // be missed by the JIT scanner.
  const kindColor = (k: GitChangeKind): string =>
    k === 'modified' ? '#fbbf24' /* amber-400 */ : '#34d399' /* emerald-400 */

  // A folder's rolled-up git status: the "strongest" change of any file nested
  // anywhere inside it. `changed` is keyed by lowercased, forward-slashed
  // absolute paths; match by directory prefix so nesting depth doesn't matter.
  // Modified outranks added/untracked so an edited file isn't masked by a new
  // sibling. Memoized per render over the (small) changed set.
  const dirKind = useCallback(
    (folderPath: string): GitChangeKind | null => {
      if (changed.size === 0) return null
      const prefix = folderPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') + '/'
      let found: GitChangeKind | null = null
      for (const [p, k] of changed) {
        if (!p.startsWith(prefix)) continue
        if (k === 'modified') return 'modified'
        found = k
      }
      return found
    },
    [changed],
  )

  // A file's own git change kind, if any.
  const fileKind = (filePath: string): GitChangeKind | null =>
    changed.get(filePath.replace(/\\/g, '/').toLowerCase()) ?? null

  // A folder shows the change dot when any touched file is nested anywhere
  // inside it. `touched` holds lowercased, forward-slashed absolute paths;
  // match by directory prefix so nesting depth doesn't matter.
  const dirTouched = useCallback(
    (folderPath: string): boolean => {
      const prefix = folderPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '') + '/'
      for (const p of touched) if (p.startsWith(prefix)) return true
      return false
    },
    [touched],
  )

  return (
    <div className="flex h-full flex-col font-mono text-xs">
      <div className="flex shrink-0 items-center overflow-x-auto border-b border-zinc-800 px-2 py-1 whitespace-nowrap text-zinc-400">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1
          return (
            <span key={c.path} className="flex items-center">
              {i > 0 && <span className="mx-0.5 shrink-0 text-zinc-600">/</span>}
              <button
                onClick={() => navigate(c.path)}
                disabled={isLast}
                className={
                  isLast ? 'text-zinc-200' : 'shrink-0 hover:text-zinc-200 hover:underline'
                }
              >
                {c.name}
              </button>
            </span>
          )
        })}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-auto py-1">
        {!loading && entries.length === 0 && (
          <p className="px-3 py-2 text-zinc-600">empty folder</p>
        )}
        {shown.map((entry) => {
          // Change dot: git status first (persists across sessions), then fall
          // back to a session-touched dot when git doesn't flag it.
          const gitK = entry.isDir ? dirKind(entry.path) : fileKind(entry.path)
          const isTouched = entry.isDir
            ? dirTouched(entry.path)
            : touched.has(entry.path.toLowerCase())
          const dotColor = gitK ? kindColor(gitK) : isTouched ? '#34d399' : null
          const dotTitle = gitK
            ? entry.isDir
              ? `contains ${gitK === 'modified' ? 'modified' : 'new'} files (uncommitted)`
              : gitK === 'modified'
                ? 'modified — uncommitted change'
                : gitK === 'added'
                  ? 'added — staged, uncommitted'
                  : 'untracked — new file'
            : entry.isDir
              ? 'contains files edited by the agent this session'
              : 'edited by the agent this session'
          const dot = dotColor ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: dotColor }}
              title={dotTitle}
            />
          ) : null
          if (renaming && renaming.path === entry.path) {
            return (
              <div
                key={entry.path}
                className="flex h-6 w-full items-center gap-1.5 px-2 text-zinc-300"
              >
                <span className={`shrink-0 ${entry.isDir ? 'text-amber-500/80' : 'w-2'}`}>
                  {entry.isDir ? '▸' : ''}
                </span>
                <input
                  ref={renameInputRef}
                  value={renaming.value}
                  onChange={(e) => setRenaming({ path: entry.path, value: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    else if (e.key === 'Escape') setRenaming(null)
                  }}
                  onBlur={commitRename}
                  className="min-w-0 flex-1 rounded border border-sky-600 bg-zinc-800 px-1 py-0.5 text-xs text-zinc-100 outline-none"
                />
              </div>
            )
          }
          return entry.isDir ? (
            <button
              key={entry.path}
              onClick={() => navigate(entry.path)}
              onContextMenu={(e) => openMenu(e, entry)}
              className="flex h-6 w-full items-center gap-1.5 px-2 text-left text-zinc-300 hover:bg-zinc-800/60"
            >
              <span className="shrink-0 text-amber-500/80">▸</span>
              <span className="truncate">{entry.name}</span>
              {dot && <span className="ml-auto flex shrink-0 items-center">{dot}</span>}
              <span className={`shrink-0 text-zinc-600 ${dot ? 'ml-1' : 'ml-auto'}`}>›</span>
            </button>
          ) : (
            <button
              key={entry.path}
              onClick={() => onOpen(entry.path)}
              onContextMenu={(e) => openMenu(e, entry)}
              title={entry.path}
              className="flex h-6 w-full items-center gap-1.5 px-2 text-left text-zinc-300 hover:bg-zinc-800/60"
            >
              <span className="w-2 shrink-0" />
              <span className="truncate">{entry.name}</span>
              {dot && <span className="mr-1 ml-auto flex shrink-0 items-center">{dot}</span>}
            </button>
          )
        })}
        {entries.length > CAP && (
          <p className="px-3 py-2 text-zinc-600">
            showing first {CAP} of {entries.length} entries
          </p>
        )}
      </div>

      {menu && (
        <div
          style={{ left: menu.x, top: menu.y }}
          className="fixed z-50 w-52 rounded-md border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {menu.entry.isDir ? (
            <MenuItem
              icon="▸"
              label="Open folder"
              onClick={() => {
                navigate(menu.entry.path)
                setMenu(null)
              }}
            />
          ) : (
            <MenuItem
              icon="⧉"
              label="Open in preview"
              onClick={() => {
                onOpen(menu.entry.path)
                setMenu(null)
              }}
            />
          )}
          <MenuItem
            icon="↗"
            label="Open with default app"
            onClick={() => {
              void window.codehamr.openPath(root, menu.entry.path)
              setMenu(null)
            }}
          />
          <MenuItem
            icon="⊙"
            label={revealLabel}
            onClick={() => {
              void window.codehamr.revealPath(root, menu.entry.path)
              setMenu(null)
            }}
          />
          <div className="my-1 border-t border-zinc-800" />
          <MenuItem
            icon="⧉"
            label="Copy path"
            onClick={() => {
              void window.codehamr.writeClipboard(menu.entry.path)
              setMenu(null)
            }}
          />
          <MenuItem
            icon="⧉"
            label="Copy relative path"
            onClick={() => {
              const rel = menu.entry.path.slice(root.length).replace(/^[\\/]+/, '')
              void window.codehamr.writeClipboard(rel)
              setMenu(null)
            }}
          />
          <MenuItem
            icon="⧉"
            label="Copy name"
            onClick={() => {
              void window.codehamr.writeClipboard(menu.entry.name)
              setMenu(null)
            }}
          />
          <div className="my-1 border-t border-zinc-800" />
          <MenuItem
            icon="✎"
            label="Rename"
            onClick={() => {
              startRename(menu.entry)
              setMenu(null)
            }}
          />
          <MenuItem
            icon="🗑"
            label="Move to Trash"
            danger
            onClick={() => {
              const target = menu.entry
              void window.codehamr.trashPath(root, target.path).then(
                () => load(dir),
                () => load(dir),
              )
              setMenu(null)
            }}
          />
        </div>
      )}
    </div>
  )
}

// A single row in the file-tree context menu.
function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: string
  label: string
  onClick: () => void
  danger?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-800 ${
        danger ? 'text-red-400' : 'text-zinc-300'
      }`}
    >
      <span className="w-4 text-center">{icon}</span>
      {label}
    </button>
  )
}
