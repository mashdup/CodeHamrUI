import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * FileTree: lazy, virtualized directory tree for the open workspace.
 * Directories load on first expand (never a full recursive walk). The visible
 * subtree is flattened and windowed — only rows in the viewport render — so a
 * fully-expanded node_modules (thousands of rows) stays smooth. `touched`
 * paths get an emerald dot; `reload` re-fetches only the loaded directories
 * that changed on disk.
 */

interface Entry {
  name: string
  path: string
  isDir: boolean
}

interface FlatNode {
  entry: Entry
  depth: number
}

const ROW_H = 22 // px; fixed so the virtualizer can map scroll → index
const OVERSCAN = 10

/** Depth-first flatten of the currently-visible (loaded + expanded) subtree. */
function flatten(
  root: string,
  children: Record<string, Entry[]>,
  expanded: Set<string>,
): FlatNode[] {
  const out: FlatNode[] = []
  const walk = (dir: string, depth: number): void => {
    const entries = children[dir]
    if (!entries) return
    for (const e of entries) {
      out.push({ entry: e, depth })
      if (e.isDir && expanded.has(e.path)) walk(e.path, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

export function FileTree({
  root,
  touched,
  reload,
  onOpen,
}: {
  root: string
  touched: Set<string>
  reload: { dirs: string[]; nonce: number } | null
  onOpen: (path: string) => void
}): React.JSX.Element {
  const [children, setChildren] = useState<Record<string, Entry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Mirror of children for the reload effect to read which dirs are loaded
  // without depending on children (which would re-subscribe constantly).
  const loadedRef = useRef<Record<string, Entry[]>>({})

  const load = useCallback(
    async (dir: string): Promise<void> => {
      try {
        const entries = await window.codehamr.listDir(root, dir)
        setChildren((prev) => {
          const next = { ...prev, [dir]: entries }
          loadedRef.current = next
          return next
        })
      } catch {
        setChildren((prev) => {
          const next = { ...prev, [dir]: [] }
          loadedRef.current = next
          return next
        })
      }
    },
    [root],
  )

  // Load the root on mount / workspace change.
  useEffect(() => {
    loadedRef.current = {}
    setChildren({})
    setExpanded(new Set())
    void load(root)
  }, [root, load])

  // Targeted reload: re-fetch only the changed directories that are loaded
  // (or the root). Reloading a collapsed/unloaded dir would be wasted work.
  useEffect(() => {
    if (!reload) return
    for (const dir of reload.dirs) {
      if (dir === root || dir in loadedRef.current) void load(dir)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload?.nonce])

  const toggle = (dir: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) {
        next.delete(dir)
      } else {
        next.add(dir)
        if (!children[dir]) void load(dir)
      }
      return next
    })
  }

  // Flattened visible rows + viewport windowing.
  const rows = useMemo(() => flatten(root, children, expanded), [root, children, expanded])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setViewportH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN)
  const visible = rows.slice(start, end)

  // Spacer-based windowing: rows stay in normal document flow (they physically
  // stack, so they can never overlap), padded above and below by the off-screen
  // rows' collapsed height.
  return (
    <div
      ref={scrollRef}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className="h-full overflow-auto py-1 font-mono text-xs"
    >
      <div style={{ height: start * ROW_H }} />
      {visible.map(({ entry, depth }) => {
        const style: React.CSSProperties = { height: ROW_H, paddingLeft: depth * 14 + 6 }
        if (entry.isDir) {
          const open = expanded.has(entry.path)
          return (
            <button
              key={entry.path}
              onClick={() => toggle(entry.path)}
              style={style}
              className="flex w-full items-center gap-1 text-left text-zinc-400 hover:bg-zinc-800/60"
            >
              <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
              <span className="truncate">{entry.name}</span>
            </button>
          )
        }
        const isTouched = touched.has(entry.path.toLowerCase())
        return (
          <button
            key={entry.path}
            onClick={() => onOpen(entry.path)}
            style={style}
            title={entry.path}
            className="flex w-full items-center gap-1 text-left text-zinc-300 hover:bg-zinc-800/60"
          >
            <span className="w-3 shrink-0" />
            <span className="truncate">{entry.name}</span>
            {isTouched && (
              <span
                className="ml-auto mr-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
                title="edited by the agent this session"
              />
            )}
          </button>
        )
      })}
      <div style={{ height: (rows.length - end) * ROW_H }} />
    </div>
  )
}
