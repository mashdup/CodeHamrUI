import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * FileTree: lazy directory tree for the open workspace. Directories load on
 * first expand (never a full recursive walk — node_modules stays cheap).
 * `touched` paths (files the agent wrote/edited this session) get an emerald
 * dot. `reload` carries the specific directories that changed on disk; only
 * those that are currently loaded are re-fetched — reloading the whole loaded
 * tree on every change froze the panel once node_modules was expanded.
 */

interface Entry {
  name: string
  path: string
  isDir: boolean
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

  const renderDir = (dir: string, depth: number): React.JSX.Element[] => {
    const entries = children[dir] ?? []
    return entries.flatMap((e) => {
      const pad = { paddingLeft: `${depth * 14 + 6}px` }
      if (e.isDir) {
        const open = expanded.has(e.path)
        return [
          <button
            key={e.path}
            onClick={() => toggle(e.path)}
            style={pad}
            className="flex w-full items-center gap-1 truncate py-0.5 text-left text-zinc-400 hover:bg-zinc-800/60"
          >
            <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
            <span className="truncate">{e.name}</span>
          </button>,
          ...(open ? renderDir(e.path, depth + 1) : []),
        ]
      }
      const isTouched = touched.has(e.path.toLowerCase())
      return [
        <button
          key={e.path}
          onClick={() => onOpen(e.path)}
          style={pad}
          className="flex w-full items-center gap-1 truncate py-0.5 text-left text-zinc-300 hover:bg-zinc-800/60"
          title={e.path}
        >
          <span className="w-3 shrink-0" />
          <span className="truncate">{e.name}</span>
          {isTouched && (
            <span className="ml-auto mr-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" title="edited by the agent this session" />
          )}
        </button>,
      ]
    })
  }

  return <div className="py-1 font-mono text-xs">{renderDir(root, 0)}</div>
}
