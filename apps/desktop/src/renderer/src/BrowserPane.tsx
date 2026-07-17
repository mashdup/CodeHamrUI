import { useEffect, useRef, useState } from 'react'

/**
 * BrowserPane: a live Chromium <webview> in the preview slot, so you can watch
 * the app you're building (localhost:8080 etc.) without leaving the harness.
 * The webview runs out-of-process with Chromium defaults (no node integration).
 *
 * Multiple tabs share ONE mounted <webview> element that swaps `src` on
 * switch — tab metadata (url/title) lives in React state. Electron's
 * <webview> GuestView doesn't reliably resync its internal render viewport
 * once an element has ever been `display:none` (confirmed via devtools: the
 * guest reports a stale window.innerHeight stuck at its initial intrinsic
 * size), so keeping N stacked, hidden/shown webviews per tab silently breaks
 * layout. A single always-visible webview sidesteps that bug entirely.
 */

interface Tab {
  id: string
  url: string
  title: string
}

// React's JSX map already includes <webview>; this is the subset of Electron's
// WebviewTag methods the toolbar drives (typed locally to avoid pulling the
// electron types into the web tsconfig).
interface WebviewEl extends HTMLElement {
  getURL(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  insertCSS(css: string): Promise<string>
}

// Thin, rounded, semi-transparent scrollbar injected into every previewed
// page — replaces the chunky default OS scrollbar (very obvious on Windows).
// The neutral translucent thumb reads fine over both light and dark pages and
// only touches the scrollbar, leaving the page's own styling untouched.
const SCROLLBAR_CSS = `
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{
  background:rgba(120,120,130,.45);
  border-radius:8px;
  border:2px solid transparent;
  background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:rgba(140,140,150,.75);background-clip:content-box}
::-webkit-scrollbar-corner{background:transparent}`

const storageKey = (cwd: string): string => `chbrowser:${cwd}`

const normalize = (raw: string): string =>
  /^https?:\/\//i.test(raw) ? raw : `http://${raw}` // bare "localhost:8080" works

// Landing page shown before anything is loaded — beats defaulting to
// localhost:3000 (usually connection-refused). Self-contained data: URI; the
// port chips are ordinary links, so clicking one navigates the webview.
const PORTS: [string, string][] = [
  ['3000', 'Next · CRA · Node'],
  ['5173', 'Vite'],
  ['8080', 'webpack · misc'],
  ['4200', 'Angular'],
  ['8000', 'Django · Python'],
  ['5000', 'Flask · .NET'],
]
const LANDING_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root{color-scheme:dark}
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;
    font-family:'Segoe UI',system-ui,sans-serif;background:#09090b;color:#a1a1aa}
  .card{max-width:420px;padding:32px;text-align:center}
  svg{width:56px;height:56px;margin-bottom:14px}
  h1{font-size:17px;font-weight:600;color:#e4e4e7;margin:0 0 6px}
  p{font-size:13px;line-height:1.5;margin:0 0 20px}
  .ports{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
  a{display:flex;flex-direction:column;gap:2px;text-decoration:none;
    border:1px solid #3f3f46;border-radius:8px;padding:7px 12px;
    background:#18181b;color:#e4e4e7;font-size:13px;transition:background .12s}
  a:hover{background:#27272a;border-color:#52525b}
  a span{font-size:10px;color:#71717a}
</style></head><body><div class="card">
  <svg viewBox="96 100 320 316" xmlns="http://www.w3.org/2000/svg">
    <g stroke="#f59e0b" stroke-width="13" stroke-linecap="round" fill="none">
      <line x1="234" y1="158" x2="234" y2="116"/><line x1="188" y1="174" x2="166" y2="146"/>
      <line x1="280" y1="174" x2="302" y2="146"/></g>
    <circle cx="234" cy="136" r="10" fill="#fbbf24"/>
    <path fill="#d4d4d8" d="M 112 246 L 176 212 L 398 212 L 398 264 C 398 264 332 264 323 264 C 299 264 299 290 306 302 C 319 328 360 348 371 382 L 378 396 L 134 396 L 141 382 C 152 348 193 328 206 302 C 213 290 213 264 189 264 L 176 264 Z"/>
  </svg>
  <h1>Live preview</h1>
  <p>Start your dev server, then enter its address above — or pick a common port.
     The agent can also open a page for you.</p>
  <div class="ports">
    ${PORTS.map(([p, l]) => `<a href="http://localhost:${p}">:${p}<span>${l}</span></a>`).join('')}
  </div>
</div></body></html>`
const LANDING = `data:text/html;charset=utf-8,${encodeURIComponent(LANDING_HTML)}`
const isLanding = (u: string): boolean => u.startsWith('data:')

let tabSeq = 0
const nextTabId = (): string => `tab-${++tabSeq}`

export function BrowserPane({
  cwd,
  navigate,
  onClose,
}: {
  cwd: string
  /** External navigation request (e.g. the agent's preview_url tool). */
  navigate?: { url: string; nonce: number } | null
  onClose: () => void
}): React.JSX.Element {
  const initialUrl =
    (navigate && normalize(navigate.url.trim())) || localStorage.getItem(storageKey(cwd)) || ''

  const [tabs, setTabs] = useState<Tab[]>(() => [
    { id: nextTabId(), url: initialUrl || LANDING, title: initialUrl || 'New Tab' },
  ])
  const [activeId, setActiveId] = useState(() => tabs[0].id)
  // `src` only changes on explicit Go/Enter/tab-switch — retyping in the bar
  // must not navigate. The bar tracks in-page navigation via webview events.
  const [bar, setBar] = useState(initialUrl)
  const [failed, setFailed] = useState<string | null>(null)
  const wvRef = useRef<WebviewEl | null>(null)

  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0]

  const updateActiveTab = (patch: Partial<Tab>): void => {
    setTabs((prev) => prev.map((t) => (t.id === activeId ? { ...t, ...patch } : t)))
  }

  // External navigation: same URL means "show it again" — reload. Reuses an
  // existing tab with the same URL, else opens a new one.
  useEffect(() => {
    if (!navigate) return
    const u = normalize(navigate.url.trim())
    if (!u) return
    setFailed(null)
    setBar(u)
    setTabs((prev) => {
      const existing = prev.find((t) => t.url === u)
      if (existing) {
        setActiveId(existing.id)
        if (existing.id === activeId) {
          try {
            wvRef.current?.reload()
          } catch {
            /* not attached yet */
          }
        }
        return prev
      }
      const id = nextTabId()
      setActiveId(id)
      return [...prev, { id, url: u, title: u }]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate?.nonce])

  useEffect(() => {
    const wv = wvRef.current
    if (!wv) return
    const onNav = (): void => {
      const u = wv.getURL()
      if (!u) return
      if (isLanding(u)) {
        setBar('') // keep the address bar clean while the landing shows
      } else {
        setBar(u)
        localStorage.setItem(storageKey(cwd), u)
      }
      updateActiveTab({ url: u, title: u })
    }
    const onStart = (): void => setFailed(null)
    // Re-inject the scrollbar style on every page load — a full navigation
    // swaps the document, so CSS from the previous page is gone.
    const onReady = (): void => {
      try {
        void wv.insertCSS(SCROLLBAR_CSS)
      } catch {
        /* not attached yet */
      }
    }
    const onFail = (e: Event): void => {
      // did-fail-load also fires for aborted subframe loads (code -3); only
      // surface main-frame failures.
      const ev = e as unknown as { errorCode: number; isMainFrame: boolean; errorDescription: string }
      if (ev.isMainFrame && ev.errorCode !== -3) {
        setFailed(ev.errorDescription || 'failed to load')
      }
    }
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-fail-load', onFail)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, activeId])

  const go = (): void => {
    if (!bar.trim()) return
    const u = normalize(bar.trim())
    setFailed(null)
    setBar(u)
    localStorage.setItem(storageKey(cwd), u)
    if (u === activeTab.url) {
      wvRef.current?.reload() // same URL: Go acts as refresh
    } else {
      updateActiveTab({ url: u, title: u })
    }
  }

  const switchTab = (id: string): void => {
    if (id === activeId) return
    setActiveId(id)
    const tab = tabs.find((t) => t.id === id)
    setBar(tab && !isLanding(tab.url) ? tab.url : '')
    setFailed(null)
  }

  const addTab = (): void => {
    const id = nextTabId()
    setTabs((prev) => [...prev, { id, url: LANDING, title: 'New Tab' }])
    setActiveId(id)
    setBar('')
    setFailed(null)
  }

  const closeTab = (id: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id)
      const next = prev.filter((t) => t.id !== id)
      if (next.length === 0) {
        onClose()
        return next
      }
      if (id === activeId) {
        const newActive = next[Math.min(idx, next.length - 1)]
        setActiveId(newActive.id)
        setBar(isLanding(newActive.url) ? '' : newActive.url)
      }
      return next
    })
  }

  // Webview methods throw before the tag finishes attaching; ignore that.
  const nav = (fn: (wv: WebviewEl) => void): void => {
    const wv = wvRef.current
    if (!wv) return
    try {
      fn(wv)
    } catch {
      /* not attached yet */
    }
  }

  return (
    <div className="flex h-full w-full flex-col border-l border-zinc-800">
      {tabs.length > 1 && (
        <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-zinc-800 bg-zinc-950 px-1.5">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              title={isLanding(tab.url) ? 'New Tab' : tab.url}
              className={`group flex h-6 max-w-[160px] shrink-0 cursor-pointer items-center gap-1 rounded px-2 text-[11px] ${
                activeId === tab.id
                  ? 'bg-zinc-800 text-zinc-200'
                  : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
              }`}
            >
              <span className="truncate">
                {isLanding(tab.url) ? 'New Tab' : tab.title.replace(/^https?:\/\//, '')}
              </span>
              <button
                onClick={(e) => closeTab(tab.id, e)}
                className="rounded px-0.5 text-zinc-500 opacity-0 group-hover:opacity-100 hover:bg-zinc-600 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-2 py-1.5">
        <button
          onClick={() => nav((wv) => wv.goBack())}
          title="back"
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          ←
        </button>
        <button
          onClick={() => nav((wv) => wv.goForward())}
          title="forward"
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          →
        </button>
        <button
          onClick={() => nav((wv) => wv.reload())}
          title="reload"
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          ⟳
        </button>
        <input
          value={bar}
          onChange={(e) => setBar(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
          placeholder="localhost:8080"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 font-mono text-xs text-zinc-300 outline-none focus:border-zinc-500"
        />
        <button
          onClick={go}
          className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          Go
        </button>
        <button
          onClick={addTab}
          title="new tab"
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          +
        </button>
        <button
          onClick={() => {
            const url = wvRef.current?.getURL() || bar
            if (url && !isLanding(url)) {
              void window.codehamr.openExternal(url)
            }
          }}
          title="open in external browser"
          className="rounded px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          ↗
        </button>
        <button
          onClick={onClose}
          title="close browser (preview panel)"
          className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ✕
        </button>
      </div>
      {failed && (
        <div className="flex items-center gap-2 border-b border-red-900/50 bg-red-950/40 px-3 py-1 text-[11px] text-red-300">
          <span>{failed}</span>
          <button
            onClick={() => nav((wv) => wv.reload())}
            className="ml-auto rounded bg-red-900/50 px-2 py-0.5 hover:bg-red-900"
          >
            retry
          </button>
        </div>
      )}
      <webview
        // Re-mounting on tab switch (key=activeId) is deliberate: Electron's
        // <webview> GuestView never reliably resizes once an element has been
        // hidden, so we keep exactly one always-visible webview instead of
        // stacking one per tab. Cost: switching tabs reloads the page rather
        // than restoring scroll/live state — acceptable for a dev preview.
        key={activeId}
        ref={(el) => {
          wvRef.current = el as unknown as WebviewEl | null
        }}
        src={activeTab.url}
        className="h-full w-full flex-1 bg-white"
      />
    </div>
  )
}
