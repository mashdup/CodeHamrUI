import { useEffect, useState } from 'react'
import Workspace from './Workspace'
import { Logo } from './Logo'
import { applyStoredTheme, applyZoom, loadZoom, applyTheme, loadThemeChoice } from './themes'

// Apply before first paint — a flash of the stock theme would be ugly.
// This loads from localStorage (fast). If localStorage is empty (dev restart),
// we'll load from the main process after mount.
applyStoredTheme()
applyZoom(loadZoom(), false) // don't persist during startup

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
  const [updateVersion, setUpdateVersion] = useState<string | null>(null)

  useEffect(() => {
    // Load appearance from main process on startup. This is the durable
    // source of truth; localStorage is just a fast cache for HMR.
    void window.codehamr.loadAppearance().then((saved) => {
      if (saved?.theme) {
        console.log('[App] Applying theme:', saved.theme.name, saved.theme.custom)
        applyTheme(saved.theme as any, false)
      }
      if (saved?.zoom) {
        applyZoom(saved.zoom, false)
      }
    })
  }, [])

  useEffect(() => window.codehamr.onUpdateReady(setUpdateVersion), [])

  const openWorkspace = async (): Promise<void> => {
    const dir = await window.codehamr.pickWorkspace()
    if (!dir) return
    setTabs((prev) => (prev.includes(dir) ? prev : [...prev, dir]))
    setActive(dir)
  }

  // Ctrl+O opens a project from anywhere.
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openWorkspace()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

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

  const isMac = window.codehamr.platform === 'darwin'
  const isWin = window.codehamr.platform === 'win32'

  return (
    <div className="flex h-screen flex-col">
      <header
        className={`titlebar flex h-10 shrink-0 items-center gap-1 border-b border-zinc-800 px-2 ${
          isMac ? 'pl-20' : '' // clear the traffic lights
        } ${isWin ? 'pr-[140px]' : ''}`} // clear the caption buttons
      >
        <span className="flex items-center gap-1.5 px-2 text-sm font-semibold tracking-tight text-zinc-200 select-none">
          <Logo className="h-5 w-5 shrink-0" />
          Anvil
        </span>
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
          title="open a project folder (Ctrl+O)"
          className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800"
        >
          +
        </button>
        {updateVersion && (
          <button
            onClick={() => void window.codehamr.installUpdate()}
            title="an update downloaded in the background; restarting applies it (stops running agents)"
            className="ml-auto rounded bg-sky-800 px-2.5 py-1 text-xs font-medium text-sky-100 hover:bg-sky-700"
          >
            Update to v{updateVersion} — restart
          </button>
        )}
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
