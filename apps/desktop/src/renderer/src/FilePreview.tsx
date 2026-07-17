import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { renderAsync } from 'docx-preview'
import { EXT_LANG, highlight } from './syntax'
import { numberDiffLines, gut } from './workspace/diff'

// Bundled worker (no network — the strict CSP forbids external fetches).
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/** The viewer's per-file state, produced by Workspace.openFile. */
export type Preview =
  | { kind: 'text' | 'markdown'; path: string; content: string; note: string | null }
  | { kind: 'image'; path: string; mime: string; dataB64: string }
  | { kind: 'pdf' | 'docx'; path: string; dataB64: string }
  | { kind: 'unsupported'; path: string; note: string }

const PDF_PAGE_CAP = 50

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export function FilePreview({
  preview,
  workspaceRoot,
  onClose,
  onUseInPrompt,
}: {
  preview: Preview
  workspaceRoot: string
  onClose: () => void
  onUseInPrompt: (snippet: string) => void
}): React.JSX.Element {
  // Word wrap for code previews: on by default, persisted app-wide.
  const [wrap, setWrap] = useState(() => localStorage.getItem('chwrap') !== '0')
  const toggleWrap = (): void =>
    setWrap((w) => {
      localStorage.setItem('chwrap', w ? '0' : '1')
      return !w
    })

  // Markdown preview vs raw source, persisted app-wide.
  const [mdRaw, setMdRaw] = useState(() => localStorage.getItem('chmdraw') === '1')
  const toggleMdRaw = (): void =>
    setMdRaw((r) => {
      localStorage.setItem('chmdraw', r ? '0' : '1')
      return !r
    })

  // Show the file vs its git diff. Only meaningful for text; the diff string is
  // fetched lazily (null = unknown/not fetched, '' = no changes → toggle hidden).
  const [showDiff, setShowDiff] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  const [gitChanges, setGitChanges] = useState<
    | {
        added: Set<number>
        modified: Set<number>
        removedBefore: Set<number>
      }
    | null
  >(null)
  useEffect(() => {
    setShowDiff(false)
    if (preview.kind !== 'text') {
      setDiff('')
      setGitChanges(null)
      return
    }
    let cancelled = false
    void window.codehamr
      .gitFileDiff(workspaceRoot, preview.path)
      .then((d) => {
        if (!cancelled) setDiff(d ?? '')
      })
      .catch(() => {
        if (!cancelled) setDiff('')
      })
    return () => {
      cancelled = true
    }
  }, [preview.kind === 'text' ? preview.path : preview.kind, preview.kind === 'text' ? preview.content : '', workspaceRoot])
  // Per-line git change bars (gutter markers), used by CodeView in the File
  // view (i.e. whenever showDiff is false). Fetched here — not gated on
  // showDiff, since that's the view that actually renders them — and
  // re-fetched below on refreshTick (commits, external edits, etc).
  const fetchGitChanges = useCallback(() => {
    if (preview.kind !== 'text') {
      setGitChanges(null)
      return
    }
    void window.codehamr
      .gitFileChanges(workspaceRoot, preview.path)
      .then((c) => {
        setGitChanges(
          c
            ? {
                added: new Set(c.added),
                modified: new Set(c.modified),
                removedBefore: new Set(c.removedBefore),
              }
            : null,
        )
      })
      .catch(() => setGitChanges(null))
  }, [preview.kind, preview.kind === 'text' ? preview.path : '', workspaceRoot])
  useEffect(() => {
    fetchGitChanges()
  }, [fetchGitChanges])
  // Refresh the diff and gutter markers whenever the working tree's git state
  // changes (commit, external checkout/add, etc.) — not just when this file's
  // own directory changes on disk, since a commit touches only .git/.
  useEffect(() => {
    return window.codehamr.onGitChanged(({ cwd: changedCwd }) => {
      if (changedCwd !== workspaceRoot || preview.kind !== 'text') return
      fetchGitChanges()
      void window.codehamr
        .gitFileDiff(workspaceRoot, preview.path)
        .then((d) => setDiff(d ?? ''))
        .catch(() => setDiff(''))
    })
  }, [workspaceRoot, preview.kind, preview.kind === 'text' ? preview.path : '', fetchGitChanges])
  const hasDiff = preview.kind === 'text' && !!diff

  return (
    <div className="flex min-w-0 flex-1 flex-col border-l border-zinc-800">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span
          dir="rtl"
          className="truncate text-left font-mono text-xs text-zinc-300"
          title={preview.path}
        >
          {/* dir=rtl clips the ellipsis at the START (keeping the filename
              visible); the bdi keeps the path itself rendering left-to-right. */}
          <bdi>{preview.path}</bdi>
        </span>
        {'note' in preview && preview.note && (
          <span className="shrink-0 text-[10px] text-amber-400">{preview.note}</span>
        )}
        {hasDiff && (
          <button
            onClick={() => setShowDiff((s) => !s)}
            title={showDiff ? 'show the file' : 'show this file’s changes vs git HEAD'}
            className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-zinc-800 ${
              showDiff ? 'bg-zinc-800 text-sky-400' : 'text-zinc-400'
            }`}
          >
            {showDiff ? 'File' : 'Diff'}
          </button>
        )}
        {preview.kind === 'text' && !showDiff && (
          <button
            onClick={toggleWrap}
            title={wrap ? 'word wrap on — click to scroll long lines instead' : 'word wrap off'}
            className={`${hasDiff ? '' : 'ml-auto'} shrink-0 rounded p-1 hover:bg-zinc-800 ${
              wrap ? 'text-sky-400' : 'text-zinc-500'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4" />
              <path d="m13 15-3 3 3 3M4 18h3" />
            </svg>
          </button>
        )}
        {preview.kind === 'markdown' && mdRaw && (
          <button
            onClick={toggleWrap}
            title={wrap ? 'word wrap on — click to scroll long lines instead' : 'word wrap off'}
            className={`ml-auto shrink-0 rounded p-1 hover:bg-zinc-800 ${
              wrap ? 'text-sky-400' : 'text-zinc-500'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 6h16M4 12h13a3 3 0 0 1 0 6h-4" />
              <path d="m13 15-3 3 3 3M4 18h3" />
            </svg>
          </button>
        )}
        {preview.kind === 'markdown' && (
          <button
            onClick={toggleMdRaw}
            title={mdRaw ? 'showing raw markdown — click to render' : 'showing rendered markdown — click to view raw'}
            className={`${mdRaw ? '' : 'ml-auto'} shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium hover:bg-zinc-800 ${
              mdRaw ? 'bg-zinc-800 text-sky-400' : 'text-zinc-400'
            }`}
          >
            {mdRaw ? 'Preview' : 'Raw'}
          </button>
        )}
        <button
          onClick={onClose}
          className={`shrink-0 rounded px-1.5 text-zinc-400 hover:bg-zinc-800 ${
            preview.kind === 'text' || preview.kind === 'markdown' || hasDiff ? '' : 'ml-auto'
          }`}
        >
          ✕
        </button>
      </div>
      {/* Code sits on the fixed code palette (dark on dark themes, light on
          light) — see --code-* in styles.css. The header/chrome follows the
          app theme; the code body has its own look. */}
      <div
        className={`min-h-0 flex-1 overflow-auto ${
          preview.kind === 'text' || (preview.kind === 'markdown' && mdRaw)
            ? 'bg-[var(--code-bg)] text-[var(--code-fg)]'
            : ''
        }`}
      >
        {showDiff && hasDiff ? (
          <DiffView diff={diff} />
        ) : (
          <Body
            preview={preview}
            workspaceRoot={workspaceRoot}
            gitChanges={gitChanges}
            onUseInPrompt={onUseInPrompt}
            wrap={wrap}
            mdRaw={mdRaw}
          />
        )}
      </div>
    </div>
  )
}

/**
 * DiffView: a colored unified diff (git diff HEAD) for the previewed file,
 * using the shared --diff-* palette so it tracks light/dark themes and matches
 * the tool-card diffs. An old·new line-number gutter is derived from the @@
 * hunk headers. Header/index lines are dimmed; +/- lines are tinted.
 */
function DiffView({ diff }: { diff: string }): React.JSX.Element {
  const rows = numberDiffLines(diff)
  return (
    <div className="px-3 py-2 font-mono text-xs leading-5">
      {rows.map((row, i) => {
        let style: React.CSSProperties | undefined
        if (row.kind === 'add')
          style = { background: 'var(--diff-add-bg)', color: 'var(--diff-add-fg)' }
        else if (row.kind === 'del')
          style = { background: 'var(--diff-del-bg)', color: 'var(--diff-del-fg)' }
        else if (row.kind === 'hunk') style = { color: 'var(--diff-hunk-fg)' }
        else if (row.kind === 'meta') style = { color: 'var(--diff-meta-fg)' }
        return (
          <div key={i} className="flex" style={style}>
            <span
              className="shrink-0 pr-2 text-right whitespace-pre select-none tabular-nums"
              style={{ color: 'var(--code-gutter-fg)' }}
            >
              {gut(row.oldNo)} {gut(row.newNo)}
            </span>
            <span className="flex-1 break-words whitespace-pre-wrap">{row.text || ' '}</span>
          </div>
        )
      })}
    </div>
  )
}

function Body({
  preview,
  workspaceRoot,
  gitChanges,
  onUseInPrompt,
  wrap,
  mdRaw,
}: {
  preview: Preview
  workspaceRoot: string
  gitChanges:
    | {
        added: Set<number>
        modified: Set<number>
        removedBefore: Set<number>
      }
    | null
  onUseInPrompt: (snippet: string) => void
  wrap: boolean
  mdRaw: boolean
}): React.JSX.Element {
  switch (preview.kind) {
    case 'text':
      return (
        <CodeView
          content={preview.content}
          path={preview.path}
          workspaceRoot={workspaceRoot}
          gitChanges={gitChanges}
          onUseInPrompt={onUseInPrompt}
          wrap={wrap}
        />
      )
    case 'markdown':
      return mdRaw ? (
        <CodeView
          content={preview.content}
          path={preview.path}
          workspaceRoot={workspaceRoot}
          gitChanges={gitChanges}
          onUseInPrompt={onUseInPrompt}
          wrap={wrap}
        />
      ) : (
        <div className="markdown px-4 py-3 text-sm text-zinc-200">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown>
        </div>
      )
    case 'image':
      return (
        <div className="flex items-center justify-center p-4">
          <img
            src={`data:${preview.mime};base64,${preview.dataB64}`}
            className="max-h-full max-w-full"
            style={{ imageRendering: 'auto' }}
          />
        </div>
      )
    case 'pdf':
      return <PdfView dataB64={preview.dataB64} />
    case 'docx':
      return <DocxView dataB64={preview.dataB64} />
    case 'unsupported':
      return <p className="p-6 text-center text-sm text-zinc-500">{preview.note}</p>
  }
}

// Above this line count, drop the per-line interactive rendering for one fast
// blob — tens of thousands of React rows would jank on open.
const LINE_INTERACTIVE_CAP = 5000

/**
 * Split highlight.js output into one balanced HTML fragment per source line.
 * hljs spans may cross newlines (block comments, template strings), so at each
 * newline we close the currently-open spans and reopen them on the next line —
 * every line renders as valid standalone markup. hljs emits only
 * `<span class="...">`, `</span>`, and escaped text, which this tokenizer
 * relies on.
 */
function splitHighlightedLines(html: string): string[] {
  const tokens = html.match(/<span [^>]*>|<\/span>|[^<]+/g) ?? []
  const lines: string[] = []
  const open: string[] = []
  let line = ''
  for (const tok of tokens) {
    if (tok === '</span>') {
      open.pop()
      line += tok
    } else if (tok[0] === '<') {
      open.push(tok)
      line += tok
    } else {
      const parts = tok.split('\n')
      for (let k = 0; k < parts.length; k++) {
        line += parts[k]
        if (k < parts.length - 1) {
          lines.push(line + '</span>'.repeat(open.length))
          line = open.join('')
        }
      }
    }
  }
  lines.push(line + '</span>'.repeat(open.length))
  return lines
}

/**
 * Syntax-highlighted code with a line-number gutter. Clicking a gutter number
 * selects that line; dragging across numbers selects the range. Falls back to
 * plain text for unknown types and to a non-interactive blob for huge files.
 */
function CodeView({
  content,
  path,
  workspaceRoot,
  gitChanges,
  onUseInPrompt,
  wrap,
}: {
  content: string
  path: string
  workspaceRoot: string
  gitChanges:
    | {
        added: Set<number>
        modified: Set<number>
        removedBefore: Set<number>
      }
    | null
  onUseInPrompt: (snippet: string) => void
  wrap: boolean
}): React.JSX.Element {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  const lang = EXT_LANG[ext]
  const html = useMemo(() => highlight(content, lang), [content, lang])

  // Per-line git change status vs HEAD, for the gutter change bar (like an
  // editor). Re-fetched when the file or its content changes (live refresh).
  // We do NOT re-fetch here; the parent (FilePreview) fetches it and passes
  // it down. This keeps the refresh in sync with the Diff/File toggle.
  const changeClass = (n: number): string => {
    if (!gitChanges) return ''
    if (gitChanges.added.has(n)) return 'ch-git-added'
    if (gitChanges.modified.has(n)) return 'ch-git-modified'
    if (gitChanges.removedBefore.has(n)) return 'ch-git-removed'
    return ''
  }

  const rawLines = useMemo(() => content.split('\n'), [content])
  const interactive = rawLines.length <= LINE_INTERACTIVE_CAP
  const htmlLines = useMemo(
    () => (html && interactive ? splitHighlightedLines(html) : null),
    [html, interactive],
  )

  // Workspace-relative path for snippet provenance headers.
  const relPath = useMemo(() => {
    const p = path.replace(/\\/g, '/')
    const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
    return p.toLowerCase().startsWith(root.toLowerCase() + '/')
      ? p.slice(root.length + 1)
      : (p.split('/').pop() ?? p)
  }, [path, workspaceRoot])

  const [anchor, setAnchor] = useState<number | null>(null)
  const [head, setHead] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  // Refs mirror anchor/head so the drag-end handler reads the latest values
  // without re-subscribing on every hover.
  const anchorRef = useRef<number | null>(null)
  const headRef = useRef<number | null>(null)
  const setAnchorL = (n: number | null): void => {
    anchorRef.current = n
    setAnchor(n)
  }
  const setHeadL = (n: number | null): void => {
    headRef.current = n
    setHead(n)
  }

  // One floating menu drives both selection kinds. `lines`, when set, means it
  // came from a gutter line-selection; null means a free text selection.
  const containerRef = useRef<HTMLDivElement>(null)
  const gutterDragRef = useRef(false)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    code: string
    lines: [number, number] | null
  } | null>(null)

  // Clear selection state + menu when the previewed file changes.
  useEffect(() => {
    setAnchorL(null)
    setHeadL(null)
    setMenu(null)
  }, [content])

  // End a gutter drag anywhere, and open the line menu at the pointer.
  useEffect(() => {
    if (!dragging) return
    const up = (e: MouseEvent): void => {
      setDragging(false)
      const a = anchorRef.current
      const h = headRef.current
      if (a !== null && h !== null) {
        const loN = Math.min(a, h)
        const hiN = Math.max(a, h)
        setMenu({
          x: e.clientX,
          y: e.clientY + 6,
          code: rawLines.slice(loN - 1, hiN).join('\n'),
          lines: [loN, hiN],
        })
      }
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [dragging, rawLines])

  // Dismiss the menu on scroll (its fixed position would otherwise detach).
  useEffect(() => {
    if (!menu) return
    const dismiss = (): void => setMenu(null)
    window.addEventListener('scroll', dismiss, true)
    return () => window.removeEventListener('scroll', dismiss, true)
  }, [menu])

  // Line number of the row containing a DOM node, via its data-ln ancestor.
  const lineOf = (node: Node | null): number | null => {
    let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null)
    while (el && el !== containerRef.current) {
      const ln = (el as HTMLElement).dataset?.ln
      if (ln) return parseInt(ln, 10)
      el = el.parentElement
    }
    return null
  }

  const onTextMouseUp = (): void => {
    // A gutter drag manages its own (line) menu; don't let this handler,
    // which fires on the same mouseup, clear it.
    if (gutterDragRef.current) {
      gutterDragRef.current = false
      return
    }
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      setMenu(null)
      return
    }
    const range = sel.getRangeAt(0)
    if (!containerRef.current?.contains(range.commonAncestorContainer)) {
      setMenu(null)
      return
    }
    const a = lineOf(range.startContainer)
    const b = lineOf(range.endContainer)
    const lines: [number, number] | null =
      a !== null && b !== null ? [Math.min(a, b), Math.max(a, b)] : null
    const rect = range.getBoundingClientRect()
    setMenu({ x: rect.left, y: rect.bottom + 6, code: sel.toString(), lines })
  }

  const dismiss = (): void => {
    setMenu(null)
    window.getSelection()?.removeAllRanges()
  }

  const buildSnippet = (code: string, lines: [number, number] | null): string => {
    const loc = lines
      ? lines[0] === lines[1]
        ? `${relPath} (line ${lines[0]})`
        : `${relPath} (lines ${lines[0]}-${lines[1]})`
      : relPath
    return '`' + loc + '`:\n```' + (lang || ext) + '\n' + code.replace(/\n+$/, '') + '\n```'
  }

  const useInPrompt = (): void => {
    if (menu) onUseInPrompt(buildSnippet(menu.code, menu.lines))
    dismiss()
  }

  const copySelection = (): void => {
    if (menu) void navigator.clipboard.writeText(menu.code)
    dismiss()
  }

  const lo = anchor !== null && head !== null ? Math.min(anchor, head) : null
  const hi = anchor !== null && head !== null ? Math.max(anchor, head) : null
  const selected = (n: number): boolean => lo !== null && n >= lo && n <= hi!

  // Wrapped lines keep the gutter honest in the interactive path because each
  // line is its own flex row — the number top-aligns while the code wraps
  // beneath itself. The huge-file fallback's separate gutter column can't
  // track wrapped heights, so wrap mode drops line numbers there.
  const codeWrap = wrap ? 'min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre'
  const body =
    !interactive ? (
      wrap ? (
        <pre className="px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
          {html ? (
            <code
              className="hljs whitespace-pre-wrap break-words"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <code className="whitespace-pre-wrap break-words">{content}</code>
          )}
        </pre>
      ) : (
        <div className="flex font-mono text-xs leading-5">
          <pre className="sticky left-0 shrink-0 border-r border-[var(--code-border)] bg-[var(--code-gutter-bg)] px-3 py-2 text-right text-[var(--code-gutter-fg)] select-none">
            {rawLines.map((_, i) => i + 1).join('\n')}
          </pre>
          <pre className="flex-1 overflow-x-auto px-3 py-2">
            {html ? (
              <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <code className="whitespace-pre">{content}</code>
            )}
          </pre>
        </div>
      )
    ) : (
      <div
        className={`hljs ${wrap ? 'w-full' : 'w-max min-w-full'} py-2 font-mono text-xs leading-5`}
      >
        {rawLines.map((raw, i) => {
          const n = i + 1
          const sel = selected(n)
          return (
            <div
              key={i}
              data-ln={n}
              className="flex w-full"
              style={sel ? { background: 'var(--code-sel-bg)' } : undefined}
            >
              <span
                onMouseDown={(e) => {
                  e.preventDefault() // don't start a native text selection
                  gutterDragRef.current = true
                  setAnchorL(n)
                  setHeadL(n)
                  setDragging(true)
                }}
                onMouseEnter={() => dragging && setHeadL(n)}
                style={
                  sel
                    ? { background: 'var(--code-sel-bg)', color: 'var(--code-sel-fg)' }
                    : { background: 'var(--code-gutter-bg)', color: 'var(--code-gutter-fg)' }
                }
                className={`sticky left-0 w-12 shrink-0 cursor-pointer border-r border-[var(--code-border)] px-2 text-right select-none ${changeClass(n)}`}
              >
                {n}
              </span>
              {htmlLines ? (
                <code
                  className={`flex-1 px-3 ${codeWrap}`}
                  dangerouslySetInnerHTML={{ __html: htmlLines[i] || ' ' }}
                />
              ) : (
                <code className={`flex-1 px-3 ${codeWrap}`}>{raw || ' '}</code>
              )}
            </div>
          )
        })}
      </div>
    )

  return (
    <div ref={containerRef} onMouseUp={onTextMouseUp}>
      {body}
      {menu && (
        <div
          // preventDefault on mousedown keeps the text selection alive through
          // the click, so the handlers still see it.
          onMouseDown={(e) => e.preventDefault()}
          style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 50 }}
          className="flex items-center overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 text-xs shadow-xl"
        >
          {menu.lines && (
            <span className="px-2 py-1 text-[10px] text-zinc-500">
              {menu.lines[0] === menu.lines[1]
                ? `L${menu.lines[0]}`
                : `L${menu.lines[0]}–${menu.lines[1]}`}
            </span>
          )}
          <button
            onClick={useInPrompt}
            className="border-l border-zinc-700 px-2.5 py-1 font-medium text-emerald-300 hover:bg-zinc-800"
          >
            Use in prompt
          </button>
          <button
            onClick={copySelection}
            className="border-l border-zinc-700 px-2.5 py-1 text-zinc-300 hover:bg-zinc-800"
          >
            Copy
          </button>
        </div>
      )}
    </div>
  )
}

/** Renders each PDF page to a canvas via the bundled pdf.js. */
function PdfView({ dataB64 }: { dataB64: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'done' | string>('loading')
  const [truncated, setTruncated] = useState(0)

  useEffect(() => {
    let cancelled = false
    const container = ref.current
    if (container) container.innerHTML = ''
    let task: ReturnType<typeof pdfjsLib.getDocument> | undefined
    void (async () => {
      try {
        task = pdfjsLib.getDocument({ data: b64ToBytes(dataB64) })
        const doc = await task.promise
        if (cancelled) return
        const n = Math.min(doc.numPages, PDF_PAGE_CAP)
        if (doc.numPages > PDF_PAGE_CAP) setTruncated(doc.numPages)
        for (let i = 1; i <= n; i++) {
          const page = await doc.getPage(i)
          if (cancelled) return
          const viewport = page.getViewport({ scale: 1.4 })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.className = 'mx-auto mb-3 block max-w-full shadow-lg'
          container?.appendChild(canvas)
          const ctx = canvas.getContext('2d')
          if (ctx) await page.render({ canvasContext: ctx, viewport }).promise
        }
        if (!cancelled) setStatus('done')
      } catch (e) {
        if (!cancelled) setStatus((e as Error).message || 'could not render PDF')
      }
    })()
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [dataB64])

  return (
    <div className="bg-zinc-950/40 p-4">
      {status === 'loading' && <p className="text-center text-sm text-zinc-500">rendering PDF…</p>}
      {status !== 'loading' && status !== 'done' && (
        <p className="text-center text-sm text-red-400">{status}</p>
      )}
      {truncated > 0 && (
        <p className="mb-2 text-center text-xs text-amber-400">
          showing first {PDF_PAGE_CAP} of {truncated} pages
        </p>
      )}
      <div ref={ref} />
    </div>
  )
}

/** Renders a .docx with docx-preview (page-level fidelity: styles, tables,
 *  images, headers/footers, track-changes), then scales the fixed-pixel pages
 *  to fit the pane width — like PdfView's canvases do via max-w-full. A
 *  ResizeObserver recomputes the scale when the pane resizes. */
function DocxView({ dataB64 }: { dataB64: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'done' | string>('loading')

  // Scale the wrapper so its natural page width fits the pane. transform:
  // scale() doesn't affect layout box, so the outer container height must be
  // set to the scaled height to avoid a giant blank gap below.
  const applyFit = useCallback(() => {
    const outer = ref.current
    const wrapper = outer?.querySelector<HTMLElement>('.docx-wrapper')
    if (!outer || !wrapper) return
    const avail = outer.clientWidth - 32 // match the p-4 padding
    if (avail <= 0) return
    const natWidth = wrapper.scrollWidth
    if (natWidth <= 0) return
    const scale = Math.min(1, avail / natWidth)
    wrapper.style.transformOrigin = 'top center'
    wrapper.style.transform = scale < 1 ? `scale(${scale})` : ''
    // Compensate the layout height: scaled height - natural height (the gap
    // transform leaves behind).
    const natHeight = wrapper.scrollHeight
    outer.style.height = scale < 1 ? `${natHeight * scale + 16}px` : ''
  }, [])

  useEffect(() => {
    let cancelled = false
    const container = ref.current
    if (!container) return
    container.innerHTML = ''
    void (async () => {
      try {
        const bytes = b64ToBytes(dataB64)
        await renderAsync(bytes.buffer as ArrayBuffer, container, undefined, {
          className: 'docx-preview',
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderChanges: true,
          renderComments: true,
        })
        if (!cancelled) {
          setStatus('done')
          applyFit()
        }
      } catch (e) {
        if (!cancelled) setStatus((e as Error).message || 'could not read document')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dataB64, applyFit])

  // Re-fit on pane resize.
  useEffect(() => {
    const outer = ref.current
    if (!outer) return
    const ro = new ResizeObserver(() => applyFit())
    ro.observe(outer)
    return () => ro.disconnect()
  }, [applyFit])

  if (status !== 'loading' && status !== 'done')
    return <p className="p-6 text-center text-sm text-red-400">{status}</p>
  // docx-preview renders only styled DOM (no scripts); innerHTML never runs
  // scripts and the CSP blocks external loads. Embedded images arrive as
  // data: URLs (img-src data: is allowed).
  return (
    <div className="bg-zinc-950/40 p-4">
      {status === 'loading' && (
        <p className="text-center text-sm text-zinc-500">rendering document…</p>
      )}
      <div
        ref={ref}
        className="mx-auto max-w-3xl [&_.docx-wrapper]:bg-white [&_.docx-wrapper]:shadow-lg"
      />
    </div>
  )
}
