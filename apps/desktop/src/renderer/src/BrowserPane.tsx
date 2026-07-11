import { useEffect, useRef, useState } from 'react'

/**
 * BrowserPane: a live Chromium <webview> in the preview slot, so you can watch
 * the app you're building (localhost:8080 etc.) without leaving the harness.
 * The webview runs out-of-process with Chromium defaults (no node integration).
 * Last URL persists per-workspace.
 */

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
}

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
  // `src` only changes on explicit Go/Enter — retyping in the bar must not
  // navigate. The bar tracks in-page navigation via webview events.
  const initialUrl =
    (navigate && normalize(navigate.url.trim())) || localStorage.getItem(storageKey(cwd)) || ''
  const [src, setSrc] = useState(() => initialUrl || LANDING)
  const [bar, setBar] = useState(initialUrl) // empty while the landing shows
  const [failed, setFailed] = useState<string | null>(null)
  const wvRef = useRef<WebviewEl | null>(null)

  // External navigation: same URL means "show it again" — reload.
  useEffect(() => {
    if (!navigate) return
    const u = normalize(navigate.url.trim())
    if (!u) return
    setFailed(null)
    setBar(u)
    localStorage.setItem(storageKey(cwd), u)
    setSrc((prev) => {
      if (prev === u) {
        try {
          wvRef.current?.reload()
        } catch {
          /* not attached yet */
        }
      }
      return u
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
    }
    const onStart = (): void => setFailed(null)
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
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-fail-load', onFail)
    }
  }, [cwd])

  const go = (): void => {
    if (!bar.trim()) return
    const u = normalize(bar.trim())
    setFailed(null)
    setBar(u)
    localStorage.setItem(storageKey(cwd), u)
    if (u === src) {
      wvRef.current?.reload() // same URL: Go acts as refresh
    } else {
      setSrc(u)
    }
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
        ref={(el) => {
          wvRef.current = el as unknown as WebviewEl | null
        }}
        src={src}
        className="h-full w-full flex-1 bg-white"
      />
    </div>
  )
}
