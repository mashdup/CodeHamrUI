import { useState } from 'react'
import Workspace from './Workspace'

/** Last path segment, for tab labels. */
const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/**
 * App: the tab shell. Each open project is a Workspace with its own agent
 * process; inactive workspaces stay mounted (hidden) so transcripts, streams
 * and in-flight turns survive tab switches.
 */
export default function App(): React.JSX.Element {
  const [tabs, setTabs] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)

  const openWorkspace = async (): Promise<void> => {
    const dir = await window.codehamr.pickWorkspace()
    if (!dir) return
    setTabs((prev) => (prev.includes(dir) ? prev : [...prev, dir]))
    setActive(dir)
  }

  const closeTab = async (dir: string): Promise<void> => {
    await window.codehamr.stopAgent(dir)
    setTabs((prev) => {
      const next = prev.filter((t) => t !== dir)
      setActive((cur) => {
        if (cur !== dir) return cur
        const idx = prev.indexOf(dir)
        return next[Math.min(idx, next.length - 1)] ?? null
      })
      return next
    })
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
        <span className="px-2 font-semibold tracking-tight">CodeHamr UI</span>
        {tabs.map((dir) => (
          <div
            key={dir}
            className={`group flex items-center gap-1 rounded px-2 py-1 text-sm ${
              active === dir
                ? 'bg-zinc-700 text-zinc-100'
                : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            <button onClick={() => setActive(dir)} title={dir} className="max-w-40 truncate">
              {basename(dir)}
            </button>
            <button
              onClick={() => void closeTab(dir)}
              title="close project (stops its agent)"
              className="rounded px-0.5 text-xs text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-600 hover:text-zinc-200"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={() => void openWorkspace()}
          title="open a project folder"
          className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800"
        >
          +
        </button>
      </header>

      {tabs.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <button
            onClick={() => void openWorkspace()}
            className="rounded bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
          >
            Open a project folder to start
          </button>
        </div>
      )}

      {tabs.map((dir) => (
        <Workspace key={dir} cwd={dir} visible={active === dir} />
      ))}
    </div>
  )
}
