import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { highlight } from './syntax'
import type { AgentEvent, ModelProfile, PermissionMode, TurnDoneEvent } from '@codehamr-ui/protocol'
import { PROTOCOL_VERSION } from '@codehamr-ui/protocol'
import { AppearanceModal, SettingsPanel } from './Settings'
import { FileTree } from './FileTree'
import { FilePreview, type Preview } from './FilePreview'
import { BrowserPane } from './BrowserPane'

// Module-scoped so ids stay unique across every workspace tab.
let nextId = 0
const uid = (): string => `i${nextId++}`

// ---------------------------------------------------------------------------
// Transcript model: the renderer's view of the conversation, built by folding
// protocol events. Kept deliberately flat — one array, discriminated items.
// ---------------------------------------------------------------------------

type ToolStatus = 'pending_approval' | 'running' | 'done' | 'failed' | 'denied'

type Item =
  | { kind: 'user'; id: string; text: string; images?: string[]; files?: string[]; pinned?: boolean } // data: URLs, file names
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; pinned?: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string // callId
      name: string
      args: Record<string, unknown>
      status: ToolStatus
      output?: string
      background?: boolean // bash left a process running past the turn
      diff?: { path: string; unifiedDiff: string }
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' }

type ToolItem = Extract<Item, { kind: 'tool' }>

/**
 * Phase drives the live status bar. Local models can be silent for minutes
 * during prefill, and reasoning models think before answering — without this
 * the app looks hung exactly when the agent is working hardest.
 */
type Phase = 'idle' | 'waiting' | 'thinking' | 'streaming' | 'tool'

/** Which preview panels are open, in stacking order (top → bottom). */
type PreviewPanel = 'file' | 'browser'

// Slash commands available from the composer. `arg` (when set) means the
// command takes an argument, so completing it inserts a trailing space instead
// of running immediately. Handlers live in runSlash inside the component.
type SlashCmd = { name: string; desc: string; arg?: string }
const SLASH_COMMANDS: SlashCmd[] = [
  { name: '/compact', desc: 'Summarize the conversation to reclaim context' },
  { name: '/model', desc: 'Switch model', arg: '<name>' },
  { name: '/clear', desc: 'Reset the conversation' },
  { name: '/help', desc: 'List slash commands' },
]

/**
 * Attachments are either images (sent as multimodal content parts, model
 * permitting) or text files (inlined into the prompt with their absolute
 * path, so the agent can go straight to read_file/edit_file on them).
 */
type ImageAttachment = { kind: 'image'; mime: string; dataB64: string }
type FileAttachment = {
  kind: 'file'
  name: string
  path: string // '' for pasted/synthetic files with no filesystem path
  text: string
  truncated: boolean
}
type Attachment = ImageAttachment | FileAttachment

const MAX_ATTACHMENTS = 6
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 2 * 1024 * 1024 // refuse to even read past this
const MAX_INLINE_CHARS = 60_000 // ~15k tokens; the rest is a read_file away

/** Last path segment, for the auto-mode banner and file chips. */
const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** Human status line for a running tool: what it's doing, not just its name. */
function toolLabel(name: string, args: Record<string, unknown>): string {
  const file = (p: unknown): string => (typeof p === 'string' && p ? basename(p) : '')
  const clip = (s: string, n = 44): string => (s.length > n ? s.slice(0, n) + '…' : s)
  switch (name) {
    case 'bash': {
      const cmd = typeof args.cmd === 'string' ? args.cmd : typeof args.command === 'string' ? args.command : ''
      return cmd ? `running: ${clip(cmd.replace(/\s+/g, ' ').trim())}` : 'running command'
    }
    case 'read_file':
      return file(args.path) ? `reading ${file(args.path)}` : 'reading file'
    case 'write_file':
      return file(args.path) ? `writing ${file(args.path)}` : 'writing file'
    case 'edit_file':
      return file(args.path) ? `editing ${file(args.path)}` : 'editing file'
    case 'preview_file':
      return 'opening preview'
    case 'preview_url':
      return 'opening browser'
    default:
      return `running ${name}`
  }
}

/** Panel width persisted app-wide so it survives restarts and new tabs. */
function usePanelWidth(
  key: string,
  initial: number,
): [number, (updater: (w: number) => number) => void] {
  const [w, setW] = useState(() => {
    const s = Number(localStorage.getItem(`chpanel:${key}`))
    return Number.isFinite(s) && s > 0 ? s : initial
  })
  const set = useCallback(
    (updater: (w: number) => number) =>
      setW((prev) => {
        const next = updater(prev)
        localStorage.setItem(`chpanel:${key}`, String(next))
        return next
      }),
    [key],
  )
  return [w, set]
}

/**
 * A full-viewport transparent overlay held up for the duration of a divider
 * drag. Electron's <webview> (and any iframe) runs out-of-process and swallows
 * mouse events the instant the cursor crosses it, which strands the drag's
 * document-level listeners — the pointer "escapes" and the drag goes haywire.
 * The shield sits on top so every move/up lands in this document instead, and
 * carries the resize cursor across the whole window. Returns a remover.
 */
function beginDragShield(cursor: string): () => void {
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;inset:0;z-index:9999;cursor:${cursor}`
  document.body.appendChild(el)
  return () => el.remove()
}

/**
 * Draggable vertical divider. `onResize` receives the incremental pointer
 * delta (px) since the last move; the parent clamps and applies it.
 */
function ResizeHandle({ onResize }: { onResize: (dx: number) => void }): React.JSX.Element {
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    let last = e.clientX
    const removeShield = beginDragShield('col-resize')
    const move = (ev: MouseEvent): void => {
      onResize(ev.clientX - last)
      last = ev.clientX
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      removeShield()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  return (
    <div
      onMouseDown={onMouseDown}
      className="w-1 shrink-0 cursor-col-resize bg-zinc-800 transition-colors hover:bg-sky-600"
    />
  )
}

/** Horizontal divider for the stacked preview panels; reports vertical delta. */
function RowResizeHandle({ onResize }: { onResize: (dy: number) => void }): React.JSX.Element {
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    let last = e.clientY
    const removeShield = beginDragShield('row-resize')
    const move = (ev: MouseEvent): void => {
      onResize(ev.clientY - last)
      last = ev.clientY
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      removeShield()
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
  }
  return (
    <div
      onMouseDown={onMouseDown}
      className="h-1 shrink-0 cursor-row-resize bg-zinc-800 transition-colors hover:bg-sky-600"
    />
  )
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** One row of the compact workspace-bar burger menu; closes the menu on use. */
function BarMenuItem({
  children,
  onClick,
  close,
  disabled,
}: {
  children: React.ReactNode
  onClick: () => void
  close: (open: boolean) => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      onClick={() => {
        close(false)
        onClick()
      }}
      disabled={disabled}
      className="block w-full px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Responsive three-pane layout. The file tree and preview are fixed-width side
// panels; the chat column is the flexible middle. Naively they'd squeeze the
// chat to nothing on a narrow window. Instead we measure the container and give
// the chat first claim on MIN_CHAT px; each side panel is shown only if it
// (down to its minimum) still fits in what's left, and otherwise auto-hides.
// Priority when space runs out: chat > file tree > preview. The tree is small
// and is primary navigation; the preview is large and transient (reopened by
// clicking a file), so it's the first to go.
// ---------------------------------------------------------------------------

const MIN_CHAT = 380 // chat keeps at least this many px; panels hide before eating into it
const TREE_MIN = 160
const TREE_MAX = 560
const PREVIEW_MIN = 300
const HANDLE_W = 4 // ResizeHandle width (w-1) + slack

type PanelMode = 'inline' | 'hidden'
type PanelLayout = { mode: PanelMode; width: number }

function computeLayout(
  cw: number,
  showTree: boolean,
  showPreview: boolean,
  treeW: number,
  previewW: number,
): { tree: PanelLayout; preview: PanelLayout } {
  const tree: PanelLayout = { mode: 'hidden', width: treeW }
  const preview: PanelLayout = { mode: 'hidden', width: previewW }
  // Reserve the chat's minimum up front; panels draw only from what remains.
  let remaining = cw - MIN_CHAT

  // Tree gets first refusal (small, primary navigation). It may shrink toward
  // its minimum to fit; below that it stays hidden.
  if (showTree && remaining >= TREE_MIN + HANDLE_W) {
    tree.mode = 'inline'
    tree.width = Math.min(treeW, remaining - HANDLE_W)
    remaining -= tree.width + HANDLE_W
  }
  // Preview takes whatever's left, shrinking toward its minimum, else hides.
  if (showPreview && remaining >= PREVIEW_MIN + HANDLE_W) {
    preview.mode = 'inline'
    preview.width = Math.min(previewW, remaining - HANDLE_W)
    remaining -= preview.width + HANDLE_W
  }
  return { tree, preview }
}

/** Track an element's live pixel width via ResizeObserver. */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(e.contentRect.width)
    })
    ro.observe(el)
    setW(el.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

const readAs = (file: File, how: 'dataURL' | 'text'): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    if (how === 'dataURL') r.readAsDataURL(file)
    else r.readAsText(file)
  })

/**
 * Classify a dropped file. Returns the attachment, or a rejection reason to
 * show the user — silently ignoring a dropped file is the worst outcome.
 */
async function fileToAttachment(
  file: File,
): Promise<{ ok: Attachment } | { reject: string }> {
  if (file.type.startsWith('image/')) {
    if (file.size > MAX_IMAGE_BYTES) return { reject: `${file.name}: image over 8MB` }
    const dataUrl = await readAs(file, 'dataURL')
    return { ok: { kind: 'image', mime: file.type, dataB64: dataUrl.slice(dataUrl.indexOf(',') + 1) } }
  }
  if (file.size > MAX_FILE_BYTES) {
    return { reject: `${file.name}: over 2MB — ask the agent to read it instead` }
  }
  const text = await readAs(file, 'text')
  // A NUL byte or a pile of replacement chars means we decoded binary as
  // text; inlining that is noise the model pays tokens for.
  const sample = text.slice(0, 4096)
  if (sample.includes("\u0000") || (sample.match(/\uFFFD/g)?.length ?? 0) > 8) {
    return { reject: `${file.name}: looks binary — only text files can be attached` }
  }
  return {
    ok: {
      kind: 'file',
      name: file.name,
      path: window.codehamr.getFilePath(file),
      text: text.slice(0, MAX_INLINE_CHARS),
      truncated: text.length > MAX_INLINE_CHARS,
    },
  }
}

/** Render file attachments as fenced blocks appended to the prompt. */
function inlineFiles(text: string, files: FileAttachment[]): string {
  if (files.length === 0) return text
  const blocks = files.map((f) => {
    const header = f.path ? `${f.name} (${f.path})` : f.name
    const note = f.truncated ? ' — TRUNCATED, read the file for the rest' : ''
    return `--- Attached file: ${header}${note} ---\n\`\`\`\n${f.text}\n\`\`\``
  })
  return [text, ...blocks].filter(Boolean).join('\n\n')
}

/**
 * Workspace: one open project — its agent session, transcript, file tree and
 * viewer. Stays mounted while its tab is inactive (visible=false) so state
 * and streams survive tab switches; the agent keeps running either way.
 */
export default function Workspace({
  cwd,
  visible,
}: {
  cwd: string
  visible: boolean
}): React.JSX.Element {
  const [connected, setConnected] = useState(false)
  const [activeModel, setActiveModel] = useState<string>('')
  const [models, setModels] = useState<ModelProfile[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [mode, setMode] = useState<PermissionMode>('ask')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [showFiles, setShowFiles] = useState(true)
  const [treeWidth, setTreeWidth] = usePanelWidth('tree', 224)
  const [previewWidth, setPreviewWidth] = usePanelWidth('preview', 480)
  // Targeted tree reload: which directories to re-fetch (only loaded ones are
  // acted on). nonce makes each signal distinct even if the dirs repeat.
  const [treeReload, setTreeReload] = useState<{ dirs: string[]; nonce: number } | null>(null)
  const reloadDirs = useCallback((dirs: string[]) => {
    setTreeReload((prev) => ({ dirs, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])
  const [viewer, setViewer] = useState<Preview | null>(null)
  const [lastInference, setLastInference] = useState<{
    promptTokens: number
    completionTokens: number
    contextWindow?: number // effective window the agent packed against this turn
    durationMs?: number // wall-clock of the last response's generation, for tok/s
  } | null>(null)
  // Time the last assistant generation (first content token → assistant_done)
  // in refs, so the readout doesn't cost a re-render per token.
  const genStartRef = useRef<number | null>(null)
  const lastGenMsRef = useRef<number | null>(null)
  // Mirror the open file's path in a ref so the fs-change effect can re-read it
  // without depending on `viewer` (which would resubscribe on every open).
  const viewerPathRef = useRef<string | null>(null)
  viewerPathRef.current = viewer?.path ?? null
  const [browserOpen, setBrowserOpen] = useState(false)
  // The preview slot stacks the file viewer and the live browser vertically.
  // panelOrder records open order: [0] on top, closing one gives the other the
  // full height. An adjustable row divider sets the split (each panel min 160px).
  const [panelOrder, setPanelOrder] = useState<PreviewPanel[]>([])
  const openPanel = useCallback((p: PreviewPanel) => {
    setPanelOrder((o) => (o.includes(p) ? o : [...o, p]))
  }, [])
  const closeViewer = useCallback(() => {
    setViewer(null)
    setPanelOrder((o) => o.filter((x) => x !== 'file'))
  }, [])
  const closeBrowser = useCallback(() => {
    setBrowserOpen(false)
    setPanelOrder((o) => o.filter((x) => x !== 'browser'))
  }, [])
  const previewSlotRef = useRef<HTMLDivElement>(null)
  const [splitRatio, setSplitRatio] = useState(() => {
    const s = Number(localStorage.getItem('chpreviewsplit'))
    return Number.isFinite(s) && s > 0.1 && s < 0.9 ? s : 0.5
  })
  const adjustSplit = useCallback((dy: number) => {
    setSplitRatio((prev) => {
      const h = previewSlotRef.current?.clientHeight ?? 600
      const min = 160 / h
      const next = clamp(prev + dy / h, min, 1 - min)
      localStorage.setItem('chpreviewsplit', String(next))
      return next
    })
  }, [])
  // Agent-driven navigation for the browser pane (preview_url tool).
  const [browserNav, setBrowserNav] = useState<{ url: string; nonce: number } | null>(null)
  // Pending agent preview request from the event stream (see the effect below).
  const [agentPreview, setAgentPreview] = useState<{
    path?: string
    url?: string
    nonce: number
  } | null>(null)
  const previewInUse = panelOrder.length > 0
  const [mainRef, mainW] = useElementWidth<HTMLDivElement>()
  // Default to a wide value until measured so the first paint is inline (the
  // common case) rather than flashing the overlay drawers.
  const layout = useMemo(
    () => computeLayout(mainW || 99999, showFiles, previewInUse, treeWidth, previewWidth),
    [mainW, showFiles, previewInUse, treeWidth, previewWidth],
  )
  const [items, setItems] = useState<Item[]>([])

  // Current git branch, shown next to the diff badge. null while unknown / not
  // a git repo → hidden. Refreshed alongside the diff stat (a checkout changes
  // both), see refreshGitStat.
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  // Working-tree git diff stat, shown in the bar. Fetched from the main process
  // (real `git diff --numstat`) and refreshed on mount, on filesystem changes,
  // and when a turn ends. null while unknown / not a git repo → badge hidden.
  const [diffStats, setDiffStats] = useState<{ added: number; removed: number } | null>(null)
  const gitTimer = useRef<number | undefined>(undefined)
  const refreshGitStat = useCallback(() => {
    window.clearTimeout(gitTimer.current)
    gitTimer.current = window.setTimeout(() => {
      void window.codehamr.gitDiffStat(cwd).then(setDiffStats)
      void window.codehamr.gitBranch(cwd).then(setCurrentBranch)
    }, 250)
  }, [cwd])
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Slash-command palette: highlighted row, and a dismissed flag so Escape can
  // hide the popover without clearing what the user typed.
  const [slashSel, setSlashSel] = useState(0)
  const [slashClosed, setSlashClosed] = useState(false)
  const [queue, setQueue] = useState<{ text: string; images: Attachment[] }[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Right-click context menu on user/assistant messages (copy / pin).
  const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  // Right-click context menu on the composer input (cut / copy / paste). The
  // selection is captured at open time so the actions are unaffected by the
  // textarea losing focus to the menu.
  const [inputMenu, setInputMenu] = useState<{
    x: number
    y: number
    start: number
    end: number
  } | null>(null)
  const [pinsOpen, setPinsOpen] = useState(false)
  const [showAppearance, setShowAppearance] = useState(false)
  // Workspace bar collapses its buttons into a burger menu when narrow.
  const [barRef, barW] = useElementWidth<HTMLDivElement>()
  const compactBar = barW > 0 && barW < 520
  const [barMenuOpen, setBarMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [runningTool, setRunningTool] = useState<string>('')
  const [turnStart, setTurnStart] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  // Richer progress: agentic round number, live generation meter, and per-round
  // prefill timing (time-to-first-token). Refs for the hot path (per token).
  const [step, setStep] = useState(0)
  const [streamMeter, setStreamMeter] = useState<{ tokens: number; tokPerSec: number } | null>(null)
  const genCharsRef = useRef(0) // chars streamed in the current generation (≈ tokens×4)
  const prefillMsRef = useRef<number | null>(null) // time-to-first-token of the current round
  const roundStartRef = useRef<number | null>(null) // when the current round's wait began
  const scrollRef = useRef<HTMLDivElement>(null)

  const push = useCallback((item: Item) => {
    setItems((prev) => [...prev, item])
  }, [])

  // The agent always boots in ask mode, so every start/restart must re-apply
  // the workspace's chosen mode. A ref keeps onEvent free of a mode dep.
  const modeRef = useRef<PermissionMode>('ask')
  modeRef.current = mode

  const endTurn = useCallback(() => {
    setBusy(false)
    setPhase('idle')
    setRunningTool('')
    setTurnStart(null)
    setStep(0)
    setStreamMeter(null)
    genCharsRef.current = 0
    prefillMsRef.current = null
    roundStartRef.current = null
    // Freeze any still-streaming bubbles so the caret stops blinking.
    setItems((prev) =>
      prev.map((it) =>
        (it.kind === 'assistant' || it.kind === 'reasoning') && it.streaming
          ? { ...it, streaming: false }
          : it,
      ),
    )
  }, [])

  // Transient toast for ephemeral status (session resume, etc.) that doesn't
  // belong in the permanent chat log.
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)
  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3500)
  }, [])
  useEffect(() => () => window.clearTimeout(toastTimer.current ?? undefined), [])

  // Fold agent events into the transcript.
  const onEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'ready':
          setConnected(true)
          setActiveModel(event.activeModel)
          setModels(event.models)
          if (modeRef.current !== (event.mode ?? 'ask')) {
            void window.codehamr.send(cwd, {
              v: PROTOCOL_VERSION,
              type: 'set_mode',
              mode: modeRef.current,
            })
          }
          if (event.historyLen) {
            showToast(`Resumed session — the model remembers ${event.historyLen} messages`)
          }
          break
        case 'cleared':
          setItems([])
          break
        case 'compacted':
          endTurn()
          push({
            kind: 'notice',
            id: uid(),
            text:
              event.historyLen === 0
                ? 'Nothing to compact yet.'
                : `Context compacted — ${event.message ?? 'the agent’s memory was summarized'}. Your visible chat is unchanged.`,
            tone: 'info',
          })
          break
        case 'mode':
          setMode(event.mode) // the agent is the source of truth
          break
        case 'file_diff': {
          // Reload just the edited file's directory (the watcher also catches
          // it, but this is instant).
          const abs = /^([a-zA-Z]:[\\/]|\/)/.test(event.path) ? event.path : `${cwd}/${event.path}`
          reloadDirs([abs.replace(/[\\/][^\\/]*$/, '')])
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.id === event.callId
                ? { ...it, diff: { path: event.path, unifiedDiff: event.unifiedDiff } }
                : it,
            ),
          )
          break
        }
        case 'preview':
          // Agent-requested preview (preview_file / preview_url tools); a
          // later effect opens the panel — openFile isn't defined yet here.
          setAgentPreview((prev) => ({
            path: event.path,
            url: event.url,
            nonce: (prev?.nonce ?? 0) + 1,
          }))
          break
        case 'reasoning_delta':
          setPhase('thinking')
          setItems((prev) => {
            const last = prev[prev.length - 1]
            if (last?.kind === 'reasoning' && last.streaming) {
              return [...prev.slice(0, -1), { ...last, text: last.text + event.text }]
            }
            return [...prev, { kind: 'reasoning', id: uid(), text: event.text, streaming: true }]
          })
          break
        case 'assistant_delta':
          if (genStartRef.current === null) {
            genStartRef.current = Date.now() // first content token
            genCharsRef.current = 0
            setStep((s) => s + 1) // a new agentic round's response has begun
            if (roundStartRef.current !== null) prefillMsRef.current = Date.now() - roundStartRef.current
          }
          genCharsRef.current += event.text.length
          setPhase('streaming')
          setItems((prev) => {
            // Answer tokens end the thinking display: collapse the reasoning
            // bubble to its summary line.
            const closed = prev.map((it) =>
              it.kind === 'reasoning' && it.streaming ? { ...it, streaming: false } : it,
            )
            const last = closed[closed.length - 1]
            if (last?.kind === 'assistant' && last.streaming) {
              return [...closed.slice(0, -1), { ...last, text: last.text + event.text }]
            }
            return [...closed, { kind: 'assistant', id: uid(), text: event.text, streaming: true }]
          })
          break
        case 'assistant_done':
          if (genStartRef.current !== null) {
            lastGenMsRef.current = Date.now() - genStartRef.current
            genStartRef.current = null
          }
          setStreamMeter(null)
          setItems((prev) =>
            prev.map((it) =>
              (it.kind === 'assistant' || it.kind === 'reasoning') && it.streaming
                ? { ...it, streaming: false }
                : it,
            ),
          )
          break
        case 'tool_call':
          setPhase('tool')
          setRunningTool(toolLabel(event.name, event.args))
          setItems((prev) => [
            ...prev,
            {
              kind: 'tool',
              id: event.callId,
              name: event.name,
              args: event.args,
              status: event.needsApproval ? 'pending_approval' : 'running',
            },
          ])
          break
        case 'tool_result':
          // Round-trip continues: next LLM round follows, so back to waiting.
          setPhase('waiting')
          setRunningTool('')
          roundStartRef.current = Date.now() // the next round's wait (prefill) begins now
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.id === event.callId
                ? {
                    ...it,
                    status: event.ok ? 'done' : 'failed',
                    output: event.output,
                    background: event.background ?? false,
                  }
                : it,
            ),
          )
          break
        case 'turn_done':
          // Keep the last stat when a turn ends without usage (cancel, or an
          // endpoint that doesn't report it) — only overwrite on a real number.
          if (event.usage)
            setLastInference({ ...event.usage, durationMs: lastGenMsRef.current ?? undefined })
          genStartRef.current = null
          endTurn()
          break
        case 'error':
          endTurn()
          setItems((prev) => [
            ...prev,
            { kind: 'notice', id: uid(), text: event.message, tone: 'error' },
          ])
          break
        case 'models':
          setActiveModel(event.activeModel)
          setModels(event.models)
          break
        case 'log':
          push({
            kind: 'notice',
            id: uid(),
            text: event.message,
            tone: event.level === 'warn' || event.level === 'error' ? 'error' : 'info',
          })
          break
        default:
          break
      }
    },
    [endTurn, push, showToast, reloadDirs, cwd],
  )

  // Subscribe to this workspace's slice of the event streams.
  useEffect(() => {
    const offEvent = window.codehamr.onEvent((p) => {
      if (p.cwd === cwd) onEvent(p.event)
    })
    // Agent stderr / non-protocol stdout: a Go panic or startup failure lands
    // here. Surfacing it is the difference between a debuggable crash and a
    // silent "agent exited".
    const offNoise = window.codehamr.onNoise((p) => {
      if (p.cwd === cwd) push({ kind: 'notice', id: uid(), text: p.line, tone: 'info' })
    })
    const offExit = window.codehamr.onExit(({ cwd: eCwd, code, signal }) => {
      if (eCwd !== cwd) return
      setConnected(false)
      endTurn()
      const why = code !== null ? `code ${code}` : signal ? `signal ${signal}` : 'reason unknown'
      push({
        kind: 'notice',
        id: uid(),
        text: `agent exited (${why}) — see the lines above for its last words`,
        tone: 'error',
      })
    })
    return () => {
      offEvent()
      offNoise()
      offExit()
    }
  }, [cwd, onEvent, endTurn, push])

  // Filesystem changes in this workspace (agent bash, external edits) refresh
  // only the affected directories in the tree.
  useEffect(() => {
    return window.codehamr.onFsChanged(({ cwd: changedCwd, dirs }) => {
      if (changedCwd === cwd && dirs.length) {
        reloadDirs(dirs)
        refreshGitStat()
      }
    })
  }, [cwd, reloadDirs, refreshGitStat])

  // Refresh the git diff stat on load and whenever a turn finishes (the agent
  // just edited files), plus fs:changed above catches manual/external edits.
  useEffect(() => {
    if (!busy) refreshGitStat()
  }, [busy, refreshGitStat])

  // Elapsed ticker for the status bar: proof of life while the model is silent.
  // Also refreshes the live generation meter (token estimate + tok/s) once a
  // second, off the per-token hot path.
  useEffect(() => {
    if (turnStart === null) return
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - turnStart) / 1000))
      if (genStartRef.current !== null) {
        const ms = Date.now() - genStartRef.current
        const tokens = Math.round(genCharsRef.current / 4) // ~4 chars/token estimate
        setStreamMeter({ tokens, tokPerSec: ms > 500 ? Math.round(tokens / (ms / 1000)) : 0 })
      }
    }, 1000)
    return () => clearInterval(t)
  }, [turnStart])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items])

  // Auto-grow the composer with its content, between ~2 lines and a cap, then
  // scroll internally. Runs on every input change (typing, paste, snippet
  // insert, and clear-on-send).
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(52, Math.min(el.scrollHeight, 260))}px`
  }, [input])

  // Boot: restore the saved transcript, then start (or adopt) the agent.
  const loadedRef = useRef(false)
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    void (async () => {
      // Before the agent starts, so 'ready' can re-apply it.
      const stored = await window.codehamr.getMode(cwd)
      setMode(stored)
      modeRef.current = stored
      const saved = (await window.codehamr.readTranscript(cwd)) as Item[] | null
      if (Array.isArray(saved)) {
        // Reseat the id counter past restored ids so new items can't collide.
        for (const it of saved) {
          const n = Number(String(it.id).slice(1))
          if (Number.isFinite(n) && n >= nextId) nextId = n + 1
        }
        setItems(saved.map((it) => ('streaming' in it ? { ...it, streaming: false } : it)))
      }
      loadedRef.current = true
      const { seededFrom } = await window.codehamr.startAgent(cwd)
      if (seededFrom) {
        push({
          kind: 'notice',
          id: uid(),
          text: `new project — endpoints configured from your "${seededFrom}" preset`,
          tone: 'info',
        })
      }
    })()
  }, [cwd, push])

  // Debounced transcript autosave; gated on loadedRef so the initial empty
  // state can never clobber a saved transcript before the restore completes.
  useEffect(() => {
    if (!loadedRef.current) return
    const t = setTimeout(() => void window.codehamr.writeTranscript(cwd, items), 500)
    return () => clearTimeout(t)
  }, [items, cwd])

  // ---------------------------------------------------------------------
  // Chat history: New chat archives the current conversation; History
  // switches between archived ones (agent restarts with that session).
  // ---------------------------------------------------------------------
  interface ChatEntry {
    id: string
    title: string
    updatedAt: number
    current: boolean
  }
  const [chats, setChats] = useState<ChatEntry[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)

  /** Force-write the transcript now — the autosave debounce may be pending. */
  const flushTranscript = async (): Promise<void> => {
    if (loadedRef.current) await window.codehamr.writeTranscript(cwd, items)
  }

  const loadChats = async (): Promise<void> => {
    setChats(await window.codehamr.listChats(cwd))
  }

  const loadTranscriptFromDisk = async (): Promise<void> => {
    const saved = (await window.codehamr.readTranscript(cwd)) as Item[] | null
    if (Array.isArray(saved)) {
      for (const it of saved) {
        const n = Number(String(it.id).slice(1))
        if (Number.isFinite(n) && n >= nextId) nextId = n + 1
      }
      setItems(saved.map((it) => ('streaming' in it ? { ...it, streaming: false } : it)))
    } else {
      setItems([])
    }
  }

  const newChat = async (): Promise<void> => {
    if (!connected || busy) return
    setHistoryOpen(false)
    await flushTranscript()
    setConnected(false)
    await window.codehamr.newChatSession(cwd) // archives the current pair
    setItems([])
    setQueue([])
    await window.codehamr.startAgent(cwd)
  }

  const switchToChat = async (id: string): Promise<void> => {
    setHistoryOpen(false)
    if (busy || chats.find((c) => c.id === id)?.current) return
    await flushTranscript()
    setConnected(false)
    await window.codehamr.switchChat(cwd, id)
    await loadTranscriptFromDisk()
    setQueue([])
    await window.codehamr.startAgent(cwd)
  }

  const removeChat = async (id: string): Promise<void> => {
    await window.codehamr.deleteChat(cwd, id)
    await loadChats()
  }

  /** Normalize a path for cross-item comparison (win/mac slashes, case). */
  const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

  /** Resolve a tool-arg path (usually workspace-relative) to absolute. */
  const toAbs = useCallback(
    (p: string): string => (/^([a-zA-Z]:[\\/]|\/)/.test(p) ? p : `${cwd}/${p}`),
    [cwd],
  )

  // Files the agent wrote/edited this session — emerald dots in the tree.
  const touched = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      if (
        it.kind === 'tool' &&
        (it.name === 'write_file' || it.name === 'edit_file') &&
        it.status === 'done'
      ) {
        const p = String(it.args.path ?? '')
        if (p) set.add(normPath(toAbs(p)))
      }
    }
    return set
  }, [items, toAbs])

  // Read an absolute path into the viewer. Shared by openFile and the live
  // fs-refresh, so re-reading on a disk change doesn't re-stack the panel.
  const loadViewer = useCallback(
    async (abs: string): Promise<void> => {
      let r: Awaited<ReturnType<typeof window.codehamr.readPreview>>
      try {
        r = await window.codehamr.readPreview(cwd, abs)
      } catch {
        return // file vanished (deleted/renamed) between the change and the read
      }
      switch (r.kind) {
        case 'text':
        case 'markdown':
          setViewer({ kind: r.kind, path: abs, content: r.content, note: r.truncated ? 'truncated view' : null })
          break
        case 'image':
          setViewer({ kind: 'image', path: abs, mime: r.mime, dataB64: r.dataB64 })
          break
        case 'pdf':
        case 'docx':
          setViewer({ kind: r.kind, path: abs, dataB64: r.dataB64 })
          break
        case 'binary':
          setViewer({ kind: 'unsupported', path: abs, note: 'no preview for this file type' })
          break
        case 'too-large':
          setViewer({ kind: 'unsupported', path: abs, note: `too large to preview (${Math.round(r.size / 1024)}KB)` })
          break
      }
    },
    [cwd],
  )

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      openPanel('file') // stacks alongside the browser rather than replacing it
      await loadViewer(toAbs(path))
    },
    [loadViewer, toAbs, openPanel],
  )

  // Live-refresh the open file preview when its directory changes on disk
  // (agent writes or external edits). The watcher already debounces (300ms) and
  // reports absolute dirs; re-read only when the open file's own dir is among
  // them, so unrelated changes don't reload the viewer.
  useEffect(() => {
    return window.codehamr.onFsChanged(({ cwd: changedCwd, dirs }) => {
      if (changedCwd !== cwd || !dirs.length) return
      const vp = viewerPathRef.current
      if (!vp) return
      const n = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
      const vdir = n(vp).replace(/\/[^/]*$/, '')
      if (dirs.some((d) => n(d) === vdir)) void loadViewer(vp)
    })
  }, [cwd, loadViewer])

  // React to agent preview requests (preview_file / preview_url tools). File
  // and browser now stack rather than replace, so opening one keeps the other.
  useEffect(() => {
    if (!agentPreview) return
    if (agentPreview.url) {
      setBrowserNav({ url: agentPreview.url, nonce: agentPreview.nonce })
      setBrowserOpen(true)
      openPanel('browser')
    } else if (agentPreview.path) {
      void openFile(agentPreview.path)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentPreview])

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    const results = await Promise.all([...files].map(fileToAttachment))
    const good: Attachment[] = []
    for (const r of results) {
      if ('ok' in r) good.push(r.ok)
      // A dropped file that vanishes with no explanation is the worst
      // outcome; say why it didn't attach.
      else push({ kind: 'notice', id: uid(), text: `not attached — ${r.reject}`, tone: 'info' })
    }
    if (good.length === 0) return
    setAttachments((prev) => [...prev, ...good].slice(0, MAX_ATTACHMENTS))
  }

  const dispatchPrompt = useCallback(
    async (text: string, atts: Attachment[]): Promise<void> => {
      const images = atts.filter((a): a is ImageAttachment => a.kind === 'image')
      const files = atts.filter((a): a is FileAttachment => a.kind === 'file')
      setBusy(true)
      setPhase('waiting')
      setTurnStart(Date.now())
      setElapsed(0)
      setStep(0)
      setStreamMeter(null)
      genCharsRef.current = 0
      prefillMsRef.current = null
      roundStartRef.current = Date.now() // first round's wait (prefill) begins now
      // Transcript shows what you typed plus chips; the wire carries the
      // inlined file contents.
      push({
        kind: 'user',
        id: uid(),
        text,
        images: images.length ? images.map((a) => `data:${a.mime};base64,${a.dataB64}`) : undefined,
        files: files.length ? files.map((f) => f.name) : undefined,
      })
      await window.codehamr.send(cwd, {
        v: PROTOCOL_VERSION,
        type: 'prompt',
        text: inlineFiles(text, files),
        images: images.length ? images.map(({ mime, dataB64 }) => ({ mime, dataB64 })) : undefined,
      })
    },
    [cwd, push],
  )

  // Run a slash command instead of sending a prompt. Only invoked for text
  // whose first word is a known command (see sendPrompt), so ordinary messages
  // that merely start with "/" (e.g. a path) still go through as prompts.
  const runSlash = async (raw: string): Promise<void> => {
    const [name, ...rest] = raw.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    switch (name) {
      case '/compact':
        if (!connected) return
        if (busy) {
          push({ kind: 'notice', id: uid(), text: 'Finish or stop the current turn before compacting.', tone: 'info' })
          return
        }
        setBusy(true)
        setPhase('waiting')
        setTurnStart(Date.now())
        setElapsed(0)
        push({ kind: 'notice', id: uid(), text: 'Compacting the conversation…', tone: 'info' })
        try {
          await window.codehamr.send(cwd, { v: PROTOCOL_VERSION, type: 'compact' })
        } catch (err) {
          // A rejected send (e.g. the agent predates /compact — restart the
          // app) must not leave the composer wedged on busy forever.
          endTurn()
          push({
            kind: 'notice',
            id: uid(),
            text: `Couldn't start compaction: ${err instanceof Error ? err.message : String(err)}. If you just updated, fully restart the app.`,
            tone: 'error',
          })
        }
        return
      case '/clear':
        await window.codehamr.send(cwd, { v: PROTOCOL_VERSION, type: 'clear' })
        return
      case '/model':
        if (!arg) {
          push({
            kind: 'notice',
            id: uid(),
            text: `Models: ${models.map((m) => m.name).join(', ') || '(none)'} · active: ${activeModel}. Use /model <name>.`,
            tone: 'info',
          })
        } else if (models.some((m) => m.name === arg)) {
          await window.codehamr.send(cwd, { v: PROTOCOL_VERSION, type: 'set_model', name: arg })
        } else {
          push({
            kind: 'notice',
            id: uid(),
            text: `Unknown model "${arg}" — available: ${models.map((m) => m.name).join(', ')}`,
            tone: 'info',
          })
        }
        return
      case '/help':
        push({
          kind: 'notice',
          id: uid(),
          text: 'Slash commands:\n' + SLASH_COMMANDS.map((c) => `  ${c.name}${c.arg ? ' ' + c.arg : ''} — ${c.desc}`).join('\n'),
          tone: 'info',
        })
        return
    }
  }

  // Palette is open while typing a command NAME (a leading "/" with no space
  // yet) and not dismissed; once a space is typed we're in argument entry and
  // the popover hides.
  const slashTyping = input.startsWith('/') && !input.includes(' ') && !input.includes('\n')
  const slashMatches = slashTyping && !slashClosed ? SLASH_COMMANDS.filter((c) => c.name.startsWith(input)) : []
  const slashOpen = slashMatches.length > 0
  const slashIdx = slashMatches.length ? Math.min(slashSel, slashMatches.length - 1) : 0
  // Complete to a command: commands with an arg get a trailing space; the rest
  // run immediately.
  const pickSlash = (c: SlashCmd): void => {
    if (c.arg) {
      setInput(c.name + ' ')
      setSlashClosed(true)
      inputRef.current?.focus()
    } else {
      setInput('')
      void runSlash(c.name)
    }
  }

  const sendPrompt = async (): Promise<void> => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !connected) return
    // A known slash command runs instead of being sent as a prompt.
    if (attachments.length === 0 && SLASH_COMMANDS.some((c) => c.name === text.split(/\s+/)[0])) {
      setInput('')
      setSlashClosed(false)
      setSlashSel(0)
      await runSlash(text)
      return
    }
    const atts = attachments
    setInput('')
    setAttachments([])
    // Mid-turn: queue instead of rejecting — it dispatches when the turn ends.
    if (busy) {
      setQueue((q) => [...q, { text, images: atts }])
      return
    }
    await dispatchPrompt(text, atts)
  }

  // Auto-dispatch the queue whenever the agent goes idle.
  useEffect(() => {
    if (busy || !connected || queue.length === 0) return
    const [next, ...rest] = queue
    setQueue(rest)
    void dispatchPrompt(next.text, next.images)
  }, [busy, connected, queue, dispatchPrompt])

  const cancelTurn = async (): Promise<void> => {
    await window.codehamr.send(cwd, { v: PROTOCOL_VERSION, type: 'cancel' })
    // Cancel means "stop everything", not "stop this one and run the rest".
    setQueue((q) => {
      if (q.length > 0) {
        push({ kind: 'notice', id: uid(), text: `cancelled (${q.length} queued prompt${q.length > 1 ? 's' : ''} discarded)`, tone: 'info' })
        return []
      }
      push({ kind: 'notice', id: uid(), text: 'cancelled', tone: 'info' })
      return q
    })
  }

  const decide = async (
    callId: string,
    decision: 'allow' | 'deny',
    scope?: 'session',
  ): Promise<void> => {
    setItems((prev) =>
      prev.map((it) =>
        it.kind === 'tool' && it.id === callId
          ? { ...it, status: decision === 'allow' ? 'running' : 'denied' }
          : it,
      ),
    )
    if (decision === 'allow') setPhase('tool')
    await window.codehamr.send(cwd, {
      v: PROTOCOL_VERSION,
      type: 'approve',
      callId,
      decision,
      scope,
    })
  }

  const switchModel = async (name: string): Promise<void> => {
    if (busy || name === activeModel) return
    await window.codehamr.send(cwd, { v: PROTOCOL_VERSION, type: 'set_model', name })
  }

  /** Insert a snippet from the preview pane into the chat input, then focus. */
  const useSnippetInPrompt = (snippet: string): void => {
    setInput((prev) => (prev.trim() ? `${prev.replace(/\s*$/, '')}\n\n${snippet}\n` : `${snippet}\n`))
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.selectionStart = el.selectionEnd = el.value.length
      }
    })
  }

  // --- Composer right-click clipboard actions. Each works off the selection
  // captured when the menu opened, then restores focus + caret. -------------
  const restoreCaret = (pos: number): void => {
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.selectionStart = el.selectionEnd = pos
      }
    })
  }
  const copyInput = (): void => {
    if (!inputMenu) return
    const sel = input.slice(inputMenu.start, inputMenu.end)
    if (sel) void window.codehamr.writeClipboard(sel)
    setInputMenu(null)
  }
  const cutInput = (): void => {
    if (!inputMenu) return
    const { start, end } = inputMenu
    const sel = input.slice(start, end)
    if (sel) {
      void window.codehamr.writeClipboard(sel)
      setInput(input.slice(0, start) + input.slice(end))
      restoreCaret(start)
    }
    setInputMenu(null)
  }
  const pasteInput = async (): Promise<void> => {
    if (!inputMenu) return
    const { start, end } = inputMenu
    const text = await window.codehamr.readClipboard()
    setInputMenu(null)
    if (!text) return
    setInput(input.slice(0, start) + text + input.slice(end))
    restoreCaret(start + text.length)
  }
  const selectAllInput = (): void => {
    setInputMenu(null)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    })
  }

  const switchMode = async (next: PermissionMode): Promise<void> => {
    if (busy || next === mode) return
    modeRef.current = next // 'ready' after a restart must see the new choice
    await window.codehamr.setMode(cwd, next) // persist for this workspace
    await window.codehamr.send(cwd, { v: PROTOCOL_VERSION, type: 'set_mode', mode: next })
  }

  const awaitingApproval = items.some(
    (it) => it.kind === 'tool' && it.status === 'pending_approval',
  )

  // Search modal: matches user/assistant messages; clicking a result jumps to
  // (and briefly flashes) the message in the transcript. The transcript itself
  // always shows everything — no inline filtering.
  const trimmedQuery = query.trim().toLowerCase()
  const searchResults = trimmedQuery
    ? items
        .filter(
          (it): it is Extract<Item, { kind: 'user' | 'assistant' }> =>
            (it.kind === 'user' || it.kind === 'assistant') &&
            it.text.toLowerCase().includes(trimmedQuery),
        )
        .slice(0, 50)
    : []
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<number | undefined>(undefined)
  const jumpToMessage = (id: string): void => {
    setSearchOpen(false)
    scrollToMessage(id)
    setFlashId(id)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashId(null), 1600)
  }

  // Consecutive tool calls collapse into one group card (agents often chain
  // several reads/writes back to back); anything else renders as itself.
  const rendered = useMemo(() => {
    const out: ({ kind: 'item'; item: Item } | { kind: 'group'; id: string; tools: ToolItem[] })[] =
      []
    for (const it of items) {
      const prev = out[out.length - 1]
      if (it.kind === 'tool' && prev?.kind === 'group') {
        prev.tools.push(it)
      } else if (it.kind === 'tool') {
        out.push({ kind: 'group', id: `g-${it.id}`, tools: [it] })
      } else {
        out.push({ kind: 'item', item: it })
      }
    }
    return out
  }, [items])

  const pinned = items.filter(
    (it): it is Extract<Item, { kind: 'user' | 'assistant' }> =>
      (it.kind === 'user' || it.kind === 'assistant') && !!it.pinned,
  )

  const togglePin = (id: string): void => {
    setItems((prev) =>
      prev.map((it) =>
        it.id === id && (it.kind === 'user' || it.kind === 'assistant')
          ? { ...it, pinned: !it.pinned }
          : it,
      ),
    )
  }

  const copyMessage = (id: string): void => {
    const it = items.find((i) => i.id === id)
    if (it && (it.kind === 'user' || it.kind === 'assistant')) {
      void navigator.clipboard.writeText(it.text)
      showToast('message copied')
    }
  }

  const scrollToMessage = (id: string): void => {
    document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // Any click or Escape dismisses the message context menu.
  useEffect(() => {
    if (!msgMenu) return
    const close = (): void => setMsgMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [msgMenu])

  // Any click or Escape dismisses the composer clipboard menu.
  useEffect(() => {
    if (!inputMenu) return
    const close = (): void => setInputMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [inputMenu])

  // Clicking anywhere else closes the compact-bar burger menu. The toggle
  // button's own click fires first (bubbles later), so this runs after it.
  useEffect(() => {
    if (!barMenuOpen) return
    const close = (): void => setBarMenuOpen(false)
    // Defer so the opening click doesn't immediately close it.
    const id = window.setTimeout(() => window.addEventListener('click', close), 0)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('click', close)
    }
  }, [barMenuOpen])

  // Keyboard shortcuts, active tab only.
  useEffect(() => {
    if (!visible) return
    const h = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      } else if (e.ctrlKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setShowFiles((s) => !s)
      } else if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      } else if (e.key === 'Escape') {
        if (searchOpen) {
          setSearchOpen(false)
          setQuery('')
        } else if (viewer) {
          closeViewer()
        }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [visible, searchOpen, viewer])

  return (
    <div
      className={`${visible ? 'flex' : 'hidden'} relative min-h-0 flex-1 flex-col`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (connected) void addFiles(e.dataTransfer.files)
      }}
    >
      {dragOver && connected && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-2 border-dashed border-emerald-500 bg-emerald-950/40 text-sm text-emerald-300">
          drop files to attach — images go to the model, text files are inlined
        </div>
      )}

      <div ref={barRef} className="relative flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        {compactBar ? (
          <div className="relative">
            <button
              onClick={() => setBarMenuOpen((o) => !o)}
              title="menu"
              className={`rounded p-1 hover:bg-zinc-700 ${barMenuOpen ? 'bg-zinc-700' : 'bg-zinc-800'}`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 text-zinc-300"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            {barMenuOpen && (
              <div className="absolute top-full left-0 z-30 mt-1 w-44 rounded border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl">
                <BarMenuItem onClick={() => setShowAppearance(true)} close={setBarMenuOpen}>
                  Appearance…
                </BarMenuItem>
                <BarMenuItem
                  disabled={!connected || busy}
                  onClick={() => void newChat()}
                  close={setBarMenuOpen}
                >
                  New chat
                </BarMenuItem>
                <BarMenuItem
                  disabled={busy}
                  onClick={() => {
                    setHistoryOpen(true)
                    void loadChats()
                  }}
                  close={setBarMenuOpen}
                >
                  History…
                </BarMenuItem>
                <BarMenuItem onClick={() => setShowFiles((s) => !s)} close={setBarMenuOpen}>
                  {showFiles ? '✓ ' : ''}Files panel
                </BarMenuItem>
                <BarMenuItem
                  onClick={() => {
                    if (browserOpen) closeBrowser()
                    else {
                      setBrowserOpen(true)
                      openPanel('browser')
                    }
                  }}
                  close={setBarMenuOpen}
                >
                  {browserOpen ? '✓ ' : ''}Browser
                </BarMenuItem>
                <BarMenuItem onClick={() => setSearchOpen(true)} close={setBarMenuOpen}>
                  Search…
                </BarMenuItem>
              </div>
            )}
          </div>
        ) : (
          <>
            <button
              onClick={() => setShowAppearance(true)}
              title="appearance — theme & accessibility"
              className="rounded bg-zinc-800 p-1 hover:bg-zinc-700"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 text-zinc-300"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M4 7h9M19 7h1M4 17h1M11 17h9" />
                <circle cx="16" cy="7" r="2.2" />
                <circle cx="8" cy="17" r="2.2" />
              </svg>
            </button>
            <button
              onClick={() => void newChat()}
              disabled={!connected || busy}
              title="start a fresh conversation (this one is kept in History)"
              className="rounded bg-zinc-800 px-2.5 py-0.5 text-xs hover:bg-zinc-700 disabled:opacity-40"
            >
              New chat
            </button>
            <button
              onClick={() => {
                setHistoryOpen((o) => !o)
                if (!historyOpen) void loadChats()
              }}
              disabled={busy}
              title={busy ? 'finish or cancel the turn first' : 'previous chats in this project'}
              className={`rounded px-2.5 py-0.5 text-xs hover:bg-zinc-700 disabled:opacity-40 ${historyOpen ? 'bg-zinc-700' : 'bg-zinc-800'}`}
            >
              History
            </button>
          </>
        )}
        {historyOpen && (
          <div className="absolute top-full left-3 z-20 mt-1 max-h-80 w-96 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
            {chats.map((c) => (
              <div
                key={c.id}
                className={`group flex items-center gap-2 px-3 py-1.5 text-xs ${
                  c.current ? 'text-emerald-300' : 'text-zinc-300 hover:bg-zinc-800'
                }`}
              >
                <button
                  onClick={() => void switchToChat(c.id)}
                  disabled={c.current}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="truncate">{c.title}</span>
                  {c.current && <span className="shrink-0 text-[10px] text-emerald-500">· active</span>}
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-500">
                    {new Date(c.updatedAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </button>
                {!c.current && (
                  <button
                    onClick={() => void removeChat(c.id)}
                    title="delete this chat permanently"
                    className="shrink-0 rounded px-1 text-zinc-600 opacity-0 group-hover:opacity-100 hover:bg-red-950 hover:text-red-400"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            {chats.length === 0 && (
              <p className="px-3 py-2 text-xs text-zinc-500">no chats yet</p>
            )}
          </div>
        )}
        {!compactBar && (
          <>
            <button
              onClick={() => setShowFiles((s) => !s)}
              title={
                showFiles && layout.tree.mode === 'hidden'
                  ? 'file tree hidden — window too narrow (widen to show)'
                  : 'toggle the file tree (Ctrl+B)'
              }
              className={`rounded px-2.5 py-0.5 text-xs hover:bg-zinc-700 ${
                showFiles
                  ? layout.tree.mode === 'hidden'
                    ? 'bg-zinc-800 text-zinc-500 italic' // wants to show but collapsed by width
                    : 'bg-zinc-700'
                  : 'bg-zinc-800'
              }`}
            >
              Files
            </button>
            <button
              onClick={() => {
                if (browserOpen) closeBrowser()
                else {
                  setBrowserOpen(true)
                  openPanel('browser') // stacks with the file preview
                }
              }}
              title="live browser preview (localhost etc.)"
              className={`rounded p-1 hover:bg-zinc-700 ${browserOpen ? 'bg-zinc-700' : 'bg-zinc-800'}`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 text-zinc-300"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
              </svg>
            </button>
            <button
              onClick={() => setSearchOpen(true)}
              title="search chat messages (Ctrl+F)"
              className="rounded bg-zinc-800 p-1 hover:bg-zinc-700"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3.5 w-3.5 text-zinc-300"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20.5 20.5-4.2-4.2" />
              </svg>
            </button>
          </>
        )}
        <div className="relative ml-auto flex items-center gap-2 text-xs text-zinc-400">
          {currentBranch && (
            <div
              title="current git branch"
              className="flex max-w-[12rem] items-center gap-1 rounded border border-zinc-700 bg-zinc-900/50 px-2 py-0.5 font-mono text-sky-400"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-3 w-3 shrink-0"
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
              <span className="truncate">{currentBranch}</span>
            </div>
          )}
          {diffStats && (diffStats.added > 0 || diffStats.removed > 0) && (
            <div
              title="git diff — lines changed in the working tree vs HEAD"
              className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900/50 px-2 py-0.5 font-mono"
            >
              {diffStats.added > 0 && (
                <span className="text-emerald-400">+{diffStats.added.toLocaleString()}</span>
              )}
              {diffStats.removed > 0 && (
                <span className="text-red-400">-{diffStats.removed.toLocaleString()}</span>
              )}
            </div>
          )}
          {pinned.length > 0 && (
            <button
              onClick={() => setPinsOpen((o) => !o)}
              title="pinned messages"
              className={`rounded px-1.5 py-0.5 hover:bg-zinc-700 ${pinsOpen ? 'bg-zinc-700' : 'bg-zinc-800'}`}
            >
              📌 {pinned.length}
            </button>
          )}
          {pinsOpen && pinned.length > 0 && (
            <div className="absolute top-full right-0 z-20 mt-1 max-h-72 w-80 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
              {pinned.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setPinsOpen(false)
                    scrollToMessage(p.id)
                  }}
                  className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  <span className="shrink-0 text-zinc-500">{p.kind === 'user' ? 'you' : 'agent'}</span>
                  <span className="line-clamp-2">{p.text.slice(0, 160)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {showSettings && (
        <SettingsPanel
          workspace={cwd}
          onClose={() => setShowSettings(false)}
          onSaved={() => {
            setShowSettings(false)
            // Restart so the agent bootstraps the new config; transcript
            // survives (it's ours), history doesn't (it's the agent's).
            setConnected(false)
            push({
              kind: 'notice',
              id: uid(),
              text: 'config saved — restarting agent',
              tone: 'info',
            })
            void window.codehamr.startAgent(cwd)
          }}
        />
      )}

      <div ref={mainRef} className="relative flex min-h-0 flex-1">
        {layout.tree.mode === 'inline' && (
          <>
            <aside
              style={{ width: layout.tree.width }}
              className="shrink-0 overflow-hidden border-r border-zinc-800"
            >
              <FileTree
                root={cwd}
                touched={touched}
                reload={treeReload}
                onOpen={(p) => void openFile(p)}
              />
            </aside>
            <ResizeHandle
              onResize={(dx) => setTreeWidth((w) => clamp(w + dx, TREE_MIN, TREE_MAX))}
            />
          </>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            // Compact (narrow) view: let bubbles fill the width and trim the
            // side padding, so a cramped column isn't wasting space on a cap.
            style={{ '--msg-max': compactBar ? '100%' : '85%' } as React.CSSProperties}
            className={`flex-1 space-y-3 overflow-y-auto py-4 ${compactBar ? 'px-2' : 'px-4'}`}
          >
            {items.length === 0 && (
              <p className="mt-24 text-center text-sm text-zinc-500">
                {connected ? 'Ready. Ask the agent something.' : 'Starting agent…'}
              </p>
            )}
            {rendered.map((r) =>
              r.kind === 'group' ? (
                <ToolGroupCard
                  key={r.id}
                  tools={r.tools}
                  onDecide={decide}
                  onOpenFile={(p) => void openFile(p)}
                />
              ) : (
                <div
                  key={r.item.id}
                  id={`msg-${r.item.id}`}
                  className={
                    flashId === r.item.id
                      ? 'rounded-lg ring-2 ring-sky-500/60 transition-shadow'
                      : ''
                  }
                  onContextMenu={
                    r.item.kind === 'user' || r.item.kind === 'assistant'
                      ? (e) => {
                          e.preventDefault()
                          setMsgMenu({
                            x: Math.min(e.clientX, window.innerWidth - 180),
                            y: Math.min(e.clientY, window.innerHeight - 90),
                            id: r.item.id,
                          })
                        }
                      : undefined
                  }
                >
                  {(r.item.kind === 'user' || r.item.kind === 'assistant') && r.item.pinned && (
                    <div
                      className={`mb-0.5 flex items-center gap-1 text-[10px] text-amber-400/90 ${
                        r.item.kind === 'user' ? 'justify-end' : ''
                      }`}
                    >
                      <span>📌 pinned</span>
                    </div>
                  )}
                  <TranscriptItem
                    item={r.item}
                    onDecide={decide}
                    onOpenFile={(p) => void openFile(p)}
                  />
                </div>
              ),
            )}
          </div>

          {busy && (
            <StatusBar
              phase={awaitingApproval ? 'approval' : phase}
              tool={runningTool}
              elapsed={elapsed}
              step={step}
              streamMeter={streamMeter}
              prefillMs={prefillMsRef.current}
              onCancel={() => void cancelTurn()}
            />
          )}

          <footer className="border-t border-zinc-800 p-3">
            {queue.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {queue.map((q, i) => (
                  <span
                    key={i}
                    className="flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-0.5 text-xs text-zinc-400"
                  >
                    <span className="text-zinc-500">queued:</span>
                    <span className="max-w-64 truncate">
                      {q.text || `${q.images.length} image${q.images.length > 1 ? 's' : ''}`}
                    </span>
                    <button
                      onClick={() => setQueue((prev) => prev.filter((_, idx) => idx !== i))}
                      className="text-zinc-500 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap items-end gap-2">
                {attachments.map((a, i) => {
                  const remove = (): void =>
                    setAttachments((prev) => prev.filter((_, idx) => idx !== i))
                  return a.kind === 'image' ? (
                    <div key={i} className="group relative">
                      <img
                        src={`data:${a.mime};base64,${a.dataB64}`}
                        className="h-16 w-16 rounded border border-zinc-700 object-cover"
                      />
                      <button
                        onClick={remove}
                        className="absolute -top-1.5 -right-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-[10px] leading-none group-hover:flex hover:bg-red-700"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <span
                      key={i}
                      title={a.path || a.name}
                      className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
                    >
                      <span>📄</span>
                      <span className="max-w-48 truncate font-mono">{a.name}</span>
                      <span className="text-[10px] text-zinc-500">
                        {a.truncated ? 'truncated' : `${Math.max(1, Math.round(a.text.length / 1024))}KB`}
                      </span>
                      <button onClick={remove} className="text-zinc-500 hover:text-red-400">
                        ✕
                      </button>
                    </span>
                  )
                })}
                {attachments.some((a) => a.kind === 'image') && (
                  <VisionHint models={models} activeModel={activeModel} />
                )}
              </div>
            )}
            <div className="mb-2 flex items-center gap-2 text-xs text-zinc-400">
              <span
                className="flex overflow-hidden rounded border border-zinc-700"
                title={
                  busy
                    ? 'finish or cancel the turn first'
                    : 'Ask: approve each bash/write/edit. Auto: the agent runs them unattended.'
                }
              >
                {(['ask', 'auto'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => void switchMode(m)}
                    disabled={busy}
                    className={`px-2 py-0.5 disabled:opacity-50 ${
                      mode === m
                        ? m === 'auto'
                          ? 'bg-amber-700 text-amber-50'
                          : 'bg-zinc-700 text-zinc-100'
                        : 'bg-zinc-900 hover:bg-zinc-800'
                    }`}
                  >
                    {m === 'ask' ? 'Ask' : 'Auto'}
                  </button>
                ))}
              </span>
              {mode === 'auto' && (
                <span
                  className="text-[11px] text-amber-400/80"
                  title={`the agent runs bash commands and file writes in ${basename(cwd)} without asking — cancel anytime`}
                >
                  ⚠ runs without asking
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <ContextMeter
                  models={models}
                  activeModel={activeModel}
                  promptTokens={lastInference?.promptTokens ?? 0}
                  contextWindow={lastInference?.contextWindow ?? 0}
                />
                {lastInference && (
                  <div
                    className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-500"
                    title={`last message — ${lastInference.promptTokens.toLocaleString()} prompt + ${lastInference.completionTokens.toLocaleString()} completion tokens`}
                  >
                    <span>
                      {(lastInference.promptTokens + lastInference.completionTokens).toLocaleString()} tok
                    </span>
                    {!!lastInference.durationMs && lastInference.durationMs > 0 && (
                      <>
                        <span className="text-zinc-600">·</span>
                        <span title="completion tokens per second (this response's generation)">
                          {Math.round(
                            lastInference.completionTokens / (lastInference.durationMs / 1000),
                          ).toLocaleString()}{' '}
                          tok/s
                        </span>
                      </>
                    )}
                  </div>
                )}
                {models.length > 0 && (
                  <select
                    value={activeModel}
                    onChange={(e) => void switchModel(e.target.value)}
                    disabled={busy}
                    title={busy ? 'cannot switch models mid-turn' : 'switch model profile'}
                    className="rounded bg-zinc-800 px-2 py-0.5 outline-none hover:bg-zinc-700 disabled:opacity-50"
                  >
                    {models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name} · {m.llm}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  onClick={() => setShowSettings(true)}
                  title="model profiles & endpoints"
                  className="rounded px-1.5 py-0.5 hover:bg-zinc-800"
                >
                  ⚙
                </button>
                <span
                  className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-zinc-600'}`}
                  title={connected ? 'agent connected' : 'agent not running'}
                />
              </div>
            </div>
            <div className="relative flex gap-2">
              {slashOpen && (
                <div className="absolute bottom-full left-0 mb-2 w-full max-w-md overflow-hidden rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
                  {slashMatches.map((c, i) => (
                    <button
                      key={c.name}
                      // mousedown (not click) so the textarea doesn't blur first.
                      onMouseDown={(e) => {
                        e.preventDefault()
                        pickSlash(c)
                      }}
                      onMouseEnter={() => setSlashSel(i)}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs ${
                        i === slashIdx ? 'bg-zinc-800' : ''
                      } hover:bg-zinc-800`}
                    >
                      <span className="font-mono text-zinc-200">
                        {c.name}
                        {c.arg ? <span className="text-zinc-500"> {c.arg}</span> : null}
                      </span>
                      <span className="truncate text-zinc-500">{c.desc}</span>
                    </button>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  setSlashSel(0)
                  setSlashClosed(false)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  const el = e.currentTarget
                  // The composer is at the bottom of the window, so a menu drawn
                  // downward from the cursor overflows off-screen — clamp both
                  // axes to keep the whole menu inside the viewport.
                  const MENU_W = 160
                  const MENU_H = 140
                  setInputMenu({
                    x: Math.max(8, Math.min(e.clientX, window.innerWidth - MENU_W - 8)),
                    y: Math.max(8, Math.min(e.clientY, window.innerHeight - MENU_H - 8)),
                    start: el.selectionStart ?? 0,
                    end: el.selectionEnd ?? 0,
                  })
                }}
                onPaste={(e) => {
                  const files = [...e.clipboardData.items]
                    .filter((it) => it.kind === 'file')
                    .map((it) => it.getAsFile())
                    .filter((f): f is File => f !== null)
                  if (files.length > 0) {
                    e.preventDefault()
                    void addFiles(files)
                  }
                }}
                onKeyDown={(e) => {
                  // Palette navigation takes over the arrow/Tab/Enter/Escape keys
                  // while the command list is showing.
                  if (slashOpen) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      setSlashSel((s) => (Math.min(s, slashMatches.length - 1) + 1) % slashMatches.length)
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      setSlashSel((s) => (Math.min(s, slashMatches.length - 1) - 1 + slashMatches.length) % slashMatches.length)
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setSlashClosed(true)
                      return
                    }
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                      e.preventDefault()
                      const pick = slashMatches[slashIdx]
                      if (pick) pickSlash(pick)
                      return
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void sendPrompt()
                  }
                }}
                rows={1}
                placeholder={
                  !connected
                    ? 'Starting agent…'
                    : busy
                      ? 'Type ahead — sends when the current turn finishes'
                      : 'Ask the agent… (Enter to send, Shift+Enter for newline)'
                }
                disabled={!connected}
                className="max-h-[260px] flex-1 resize-none overflow-y-auto rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-500 disabled:opacity-50"
              />
              <button
                onClick={() => void sendPrompt()}
                disabled={!connected || (input.trim() === '' && attachments.length === 0)}
                title={busy ? 'queue — sends when the current turn finishes' : 'send (Enter)'}
                className={`flex items-center justify-center rounded px-3 disabled:opacity-40 ${
                  busy ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-emerald-700 hover:bg-emerald-600'
                }`}
              >
                {busy ? (
                  // queue: list with a plus
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  >
                    <path d="M4 6h16M4 12h9M4 18h9M18 14v6M15 17h6" />
                  </svg>
                ) : (
                  // send: paper plane
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor">
                    <path d="M3.4 20.4 22 12 3.4 3.6l-.01 6.53L16 12 3.39 13.87z" />
                  </svg>
                )}
              </button>
            </div>
          </footer>
        </div>

        {previewInUse && layout.preview.mode === 'inline' && (
          <>
            <ResizeHandle
              // Handle sits left of the preview: dragging left widens it.
              onResize={(dx) =>
                setPreviewWidth((w) => clamp(w - dx, PREVIEW_MIN, window.innerWidth - 360))
              }
            />
            <div
              ref={previewSlotRef}
              style={{ width: layout.preview.width }}
              className="flex shrink-0 flex-col overflow-hidden"
            >
              {panelOrder.map((p, i) => {
                const both = panelOrder.length === 2
                const isTop = i === 0
                const flex = both
                  ? { flexGrow: isTop ? splitRatio : 1 - splitRatio, flexShrink: 1, flexBasis: 0 }
                  : { flex: '1 1 0' }
                return (
                  <Fragment key={p}>
                    {i > 0 && <RowResizeHandle onResize={adjustSplit} />}
                    <div className="flex min-h-0 min-w-0" style={{ ...flex, minHeight: both ? 160 : 0 }}>
                      {p === 'file'
                        ? viewer && (
                            <FilePreview
                              preview={viewer}
                              workspaceRoot={cwd}
                              onClose={closeViewer}
                              onUseInPrompt={useSnippetInPrompt}
                            />
                          )
                        : browserOpen && (
                            <BrowserPane cwd={cwd} navigate={browserNav} onClose={closeBrowser} />
                          )}
                    </div>
                  </Fragment>
                )
              })}
            </div>
          </>
        )}
      </div>

      {showAppearance && <AppearanceModal onClose={() => setShowAppearance(false)} />}

      {searchOpen && (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-24"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="w-[560px] max-w-[90vw] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchResults.length > 0) {
                  jumpToMessage(searchResults[0].id)
                }
              }}
              placeholder="search chat messages… (Enter jumps to the first match)"
              className="w-full border-b border-zinc-800 bg-transparent px-4 py-3 text-sm outline-none"
            />
            <div className="max-h-80 overflow-y-auto py-1">
              {searchResults.map((m) => {
                const idx = m.text.toLowerCase().indexOf(trimmedQuery)
                const from = Math.max(0, idx - 40)
                const snippet =
                  (from > 0 ? '…' : '') + m.text.slice(from, from + 160).replace(/\s+/g, ' ')
                return (
                  <button
                    key={m.id}
                    onClick={() => jumpToMessage(m.id)}
                    className="flex w-full items-start gap-2 px-4 py-2 text-left text-xs hover:bg-zinc-800"
                  >
                    <span
                      className={`w-10 shrink-0 pt-0.5 text-[10px] ${
                        m.kind === 'user' ? 'text-emerald-400' : 'text-zinc-500'
                      }`}
                    >
                      {m.kind === 'user' ? 'you' : 'agent'}
                    </span>
                    <span className="line-clamp-2 text-zinc-300">{snippet}</span>
                  </button>
                )
              })}
              {trimmedQuery && searchResults.length === 0 && (
                <p className="px-4 py-3 text-xs text-zinc-500">no messages match</p>
              )}
              {!trimmedQuery && (
                <p className="px-4 py-3 text-xs text-zinc-600">
                  type to search this chat — click a result to jump to it
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {msgMenu && (
        <div
          style={{ left: msgMenu.x, top: msgMenu.y }}
          className="fixed z-50 w-44 rounded-md border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
        >
          <button
            onClick={() => copyMessage(msgMenu.id)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800"
          >
            <span className="w-4 text-center">⧉</span> Copy message
          </button>
          <button
            onClick={() => togglePin(msgMenu.id)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800"
          >
            <span className="w-4 text-center">📌</span>
            {items.find((i) => i.id === msgMenu.id && (i.kind === 'user' || i.kind === 'assistant') && i.pinned)
              ? 'Unpin message'
              : 'Pin message'}
          </button>
        </div>
      )}

      {inputMenu && (
        <div
          style={{ left: inputMenu.x, top: inputMenu.y }}
          className="fixed z-50 w-40 rounded-md border border-zinc-700 bg-zinc-900 py-1 text-xs shadow-xl"
        >
          <button
            onClick={cutInput}
            disabled={inputMenu.start === inputMenu.end}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span className="flex items-center gap-2">
              <span className="w-4 text-center">✂</span> Cut
            </span>
          </button>
          <button
            onClick={copyInput}
            disabled={inputMenu.start === inputMenu.end}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span className="flex items-center gap-2">
              <span className="w-4 text-center">⧉</span> Copy
            </span>
          </button>
          <button
            onClick={() => void pasteInput()}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800"
          >
            <span className="flex items-center gap-2">
              <span className="w-4 text-center">📋</span> Paste
            </span>
          </button>
          <div className="my-1 border-t border-zinc-800" />
          <button
            onClick={selectAllInput}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800"
          >
            <span className="w-4 text-center">▦</span> Select all
          </button>
        </div>
      )}

      {toast && (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-30 -translate-x-1/2">
          <div className="rounded-full border border-zinc-700 bg-zinc-800/95 px-4 py-1.5 text-xs text-zinc-200 shadow-lg">
            {toast}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * VisionHint sits beside queued attachments and names the model they'll be
 * sent to. Capability can't be detected reliably across arbitrary endpoints,
 * so this is a soft heuristic: warn-toned when the model name doesn't look
 * multimodal (some servers silently IGNORE image parts on text-only models —
 * no error ever arrives, so this hint is the only clue the user gets).
 */
function VisionHint({
  models,
  activeModel,
}: {
  models: ModelProfile[]
  activeModel: string
}): React.JSX.Element | null {
  const llm = models.find((m) => m.name === activeModel)?.llm ?? ''
  if (!llm) return null
  const looksVision = /vl|vision|llava|gemma3|4o|pixtral|multimodal/i.test(llm)
  return (
    <span className={`pb-0.5 text-[11px] ${looksVision ? 'text-zinc-500' : 'text-amber-400'}`}>
      {looksVision
        ? `image will be sent to ${llm}`
        : `heads-up: "${llm}" doesn't look like a vision model — it may ignore or reject the image`}
    </span>
  )
}

/**
 * ContextMeter shows how full the active model's context window is, using the
 * prompt-token count of the last turn (what the agent actually packed and
 * sent) against the effective window. The denominator is the agent-reported
 * contextWindow when available (covers server-managed profiles whose config
 * omits context_size), else the profile's configured contextSize. A thin bar
 * plus a percentage; it warns-tones as the window fills so a compact/clear is
 * an obvious next move before the agent starts trimming history.
 */
function ContextMeter({
  models,
  activeModel,
  promptTokens,
  contextWindow,
}: {
  models: ModelProfile[]
  activeModel: string
  promptTokens: number
  contextWindow: number
}): React.JSX.Element | null {
  const denom = contextWindow || (models.find((m) => m.name === activeModel)?.contextSize ?? 0)
  if (!denom) return null
  const ratio = Math.min(Math.max(promptTokens, 0) / denom, 1)
  const pct = Math.round(ratio * 100)
  const tone =
    ratio >= 0.9 ? 'text-red-400' : ratio >= 0.75 ? 'text-amber-400' : 'text-zinc-500'
  const barColor =
    ratio >= 0.9 ? 'bg-red-500' : ratio >= 0.75 ? 'bg-amber-500' : 'bg-zinc-500'
  return (
    <div
      className={`flex items-center gap-1.5 font-mono text-[10px] ${tone}`}
      title={`context window — ${promptTokens.toLocaleString()} of ${denom.toLocaleString()} tokens (${pct}%) ${
        promptTokens > 0 ? 'used by the last prompt' : 'used'
      }`}
    >
      <div className="h-1.5 w-10 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full ${barColor}`} style={{ width: `${Math.max(pct, 2)}%` }} />
      </div>
      <span>{pct}%</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status bar: continuous proof of life during silent phases.
// ---------------------------------------------------------------------------

const phaseText: Record<Phase | 'approval', string> = {
  idle: '',
  waiting: 'waiting for the model — local models can be silent for a while during prefill',
  thinking: 'model is thinking',
  streaming: 'responding',
  tool: 'running tool',
  approval: 'waiting for your approval on the tool call above',
}

function StatusBar({
  phase,
  tool,
  elapsed,
  step,
  streamMeter,
  prefillMs,
  onCancel,
}: {
  phase: Phase | 'approval'
  tool: string
  elapsed: number
  step: number
  streamMeter: { tokens: number; tokPerSec: number } | null
  prefillMs: number | null
  onCancel: () => void
}): React.JSX.Element {
  const clock = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`
  const num = (n: number): string => n.toLocaleString()

  let label: string
  if (phase === 'tool') {
    // Contextual tool line, e.g. "reading api.ts" / "running: npm test".
    label = tool || 'running tool'
  } else if (phase === 'streaming') {
    // Prefill/gen split + live generation meter.
    const parts: string[] = []
    if (prefillMs != null) parts.push(`prefill ${(prefillMs / 1000).toFixed(1)}s ·`)
    parts.push('generating')
    if (streamMeter && streamMeter.tokens > 0) {
      parts.push(`· ~${num(streamMeter.tokens)} tok`)
      if (streamMeter.tokPerSec > 0) parts.push(`· ~${num(streamMeter.tokPerSec)} tok/s`)
    }
    label = parts.join(' ')
  } else if (phase === 'waiting') {
    // Reassurance escalation once a silent local model has run a while.
    label =
      elapsed >= 20
        ? 'still working — large prompts can take a while on local models; Cancel anytime'
        : 'waiting for the model — local models can be silent during prefill'
  } else {
    label = phaseText[phase]
  }

  // Step badge for multi-round agentic turns (hidden for a simple single reply).
  const showStep = step >= 1 && (phase === 'tool' || step >= 2)

  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-900/70 px-4 py-1.5 text-xs text-zinc-400">
      <span
        className={`h-2 w-2 shrink-0 animate-pulse rounded-full ${
          phase === 'approval' ? 'bg-amber-400' : 'bg-emerald-500'
        }`}
      />
      {showStep && (
        <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-300">
          step {step}
        </span>
      )}
      <span className="truncate">{label}</span>
      <span className="ml-auto shrink-0 tabular-nums">{clock}</span>
      <button
        onClick={onCancel}
        className="shrink-0 rounded bg-zinc-800 px-2 py-0.5 text-zinc-300 hover:bg-zinc-700"
      >
        Cancel
      </button>
    </div>
  )
}

type Decide = (callId: string, decision: 'allow' | 'deny', scope?: 'session') => void

function TranscriptItem({
  item,
  onDecide,
  onOpenFile,
}: {
  item: Item
  onDecide: Decide
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <div className="ml-auto w-fit max-w-[var(--msg-max,85%)] rounded-lg bg-emerald-900/40 px-3 py-2 text-sm">
          {item.images && item.images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {item.images.map((src, i) => (
                <img key={i} src={src} className="max-h-40 rounded border border-emerald-800/50" />
              ))}
            </div>
          )}
          {item.files && item.files.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {item.files.map((name, i) => (
                <span
                  key={i}
                  className="rounded bg-emerald-950/60 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300"
                >
                  📄 {name}
                </span>
              ))}
            </div>
          )}
          {item.text && <Markdown text={item.text} />}
        </div>
      )
    case 'assistant':
      return (
        <div className="w-fit max-w-[var(--msg-max,85%)] rounded-lg bg-zinc-900 px-3 py-2 text-sm">
          <Markdown text={item.text} />
          {item.streaming && <span className="animate-pulse text-zinc-500"> ▍</span>}
        </div>
      )
    case 'reasoning':
      return <ReasoningCard item={item} />
    case 'tool':
      return <ToolCard item={item} onDecide={onDecide} onOpenFile={onOpenFile} />
    case 'notice':
      return (
        <div
          className={`rounded px-3 py-1.5 text-xs ${
            item.tone === 'error' ? 'bg-red-950 text-red-300' : 'bg-zinc-900 text-zinc-400'
          }`}
        >
          {item.text}
        </div>
      )
  }
}

/**
 * ReasoningCard: live-streams chain-of-thought while thinking, collapses to a
 * one-line summary once answer tokens start. Click to re-open.
 */
function ReasoningCard({
  item,
}: {
  item: Extract<Item, { kind: 'reasoning' }>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expanded = item.streaming || open
  return (
    <div className="max-w-[var(--msg-max,85%)] rounded-lg border border-zinc-800/60 bg-zinc-900/40 text-xs text-zinc-500">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <span className={item.streaming ? 'animate-pulse text-violet-400' : 'text-violet-500/70'}>
          {item.streaming ? '◈ thinking…' : '◈ thought'}
        </span>
        {!expanded && <span className="truncate">{item.text.slice(0, 120)}</span>}
      </button>
      {expanded && (
        <div className="max-h-48 overflow-y-auto border-t border-zinc-800/60 px-3 py-2 whitespace-pre-wrap">
          {item.text}
          {item.streaming && <span className="animate-pulse"> ▍</span>}
        </div>
      )}
    </div>
  )
}

const statusLabel: Record<ToolStatus, string> = {
  pending_approval: 'needs approval',
  running: 'running…',
  done: 'done',
  failed: 'failed',
  denied: 'denied',
}

function ToolCard({
  item,
  onDecide,
  onOpenFile,
  embedded = false,
}: {
  item: Extract<Item, { kind: 'tool' }>
  onDecide: Decide
  onOpenFile: (path: string) => void
  embedded?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const summary =
    item.name === 'bash'
      ? String(item.args.cmd ?? '')
      : String(item.args.path ?? item.args.url ?? JSON.stringify(item.args))

  return (
    <div
      className={`${embedded ? '' : 'max-w-[var(--msg-max,85%)]'} rounded-lg border border-zinc-800 bg-zinc-900/60 text-sm`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-xs text-amber-400">{item.name}</span>
        <span className="truncate font-mono text-xs text-zinc-400">{summary}</span>
        {item.background && (
          <span
            title="a background process is still running after the shell exited"
            className="shrink-0 rounded bg-sky-950 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
          >
            background
          </span>
        )}
        <span
          className={`ml-auto shrink-0 text-xs ${
            item.status === 'failed' || item.status === 'denied'
              ? 'text-red-400'
              : item.status === 'done'
                ? 'text-emerald-400'
                : 'text-zinc-400'
          }`}
        >
          {statusLabel[item.status]}
        </span>
      </button>

      {item.status === 'pending_approval' && (
        <div className="flex gap-2 border-t border-zinc-800 px-3 py-2">
          <button
            onClick={() => onDecide(item.id, 'allow')}
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium hover:bg-emerald-600"
          >
            Allow
          </button>
          <button
            onClick={() => onDecide(item.id, 'allow', 'session')}
            title={`don't ask again for ${item.name} this session`}
            className="rounded bg-emerald-900 px-3 py-1 text-xs hover:bg-emerald-800"
          >
            Always allow {item.name}
          </button>
          <button
            onClick={() => onDecide(item.id, 'deny')}
            className="ml-auto rounded bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600"
          >
            Deny
          </button>
        </div>
      )}

      {item.diff && <DiffBlock diff={item.diff} onOpenFile={onOpenFile} />}

      {open && item.output !== undefined && (
        <pre className="max-h-64 overflow-auto border-t border-zinc-800 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-zinc-300">
          {item.output}
        </pre>
      )}
    </div>
  )
}

/**
 * ToolGroupCard: consecutive tool calls collapse into one summary row —
 * agents often chain many reads/greps back to back and the transcript drowns
 * in cards. Click to reveal the individual calls. Forced open while any call
 * inside still needs approval or is running (Allow/Deny must stay reachable).
 */
function ToolGroupCard({
  tools,
  onDecide,
  onOpenFile,
}: {
  tools: ToolItem[]
  onDecide: Decide
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (tools.length === 1) {
    return <ToolCard item={tools[0]} onDecide={onDecide} onOpenFile={onOpenFile} />
  }
  const active = tools.some((t) => t.status === 'pending_approval' || t.status === 'running')
  const expanded = open || active
  const failed = tools.filter((t) => t.status === 'failed' || t.status === 'denied').length
  const names = [...new Set(tools.map((t) => t.name))].join(', ')
  const hasBackground = tools.some((t) => t.background)
  return (
    <div className="max-w-[var(--msg-max,85%)] rounded-lg border border-zinc-800 bg-zinc-900/40 text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs text-zinc-500">{expanded ? '▾' : '▸'}</span>
        <span className="text-xs text-zinc-300">
          {tools.length} tool call{tools.length === 1 ? '' : 's'}
        </span>
        <span className="truncate font-mono text-xs text-zinc-500">{names}</span>
        {hasBackground && (
          <span
            title="a background process is still running after the shell exited"
            className="shrink-0 rounded bg-sky-950 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
          >
            background
          </span>
        )}
        <span
          className={`ml-auto shrink-0 text-xs ${
            active ? 'text-zinc-400' : failed > 0 ? 'text-red-400' : 'text-emerald-400'
          }`}
        >
          {active ? 'working…' : failed > 0 ? `${failed} failed` : 'done'}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-zinc-800 p-2">
          {tools.map((t) => (
            <ToolCard key={t.id} item={t} onDecide={onDecide} onOpenFile={onOpenFile} embedded />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * DiffBlock: colored unified diff, auto-expanded — seeing what the agent
 * changed is the harness's whole point. Long diffs scroll inside the card.
 */
function DiffBlock({
  diff,
  onOpenFile,
}: {
  diff: { path: string; unifiedDiff: string }
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const lines = diff.unifiedDiff.split('\n')
  return (
    <div className="border-t border-zinc-800 px-3 pt-1.5 pb-3">
      <button
        onClick={() => onOpenFile(diff.path)}
        title="open this file in the viewer"
        className="pb-1.5 font-mono text-xs text-sky-400 hover:underline"
      >
        {diff.path}
      </button>
      {/* Inset, rounded panel on the fixed code palette (dark on dark themes,
          light on light) — see --code-* / --diff-* in styles.css. */}
      <pre
        className="max-h-80 overflow-y-auto rounded-lg border px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap"
        style={{
          background: 'var(--code-bg)',
          color: 'var(--code-fg)',
          borderColor: 'var(--code-border)',
        }}
      >
        {lines.map((line, i) => {
          let style: React.CSSProperties | undefined
          if (line.startsWith('+') && !line.startsWith('+++'))
            style = { background: 'var(--diff-add-bg)', color: 'var(--diff-add-fg)' }
          else if (line.startsWith('-') && !line.startsWith('---'))
            style = { background: 'var(--diff-del-bg)', color: 'var(--diff-del-fg)' }
          else if (line.startsWith('@@')) style = { color: 'var(--diff-hunk-fg)' }
          else if (line.startsWith('+++') || line.startsWith('---'))
            style = { color: 'var(--diff-meta-fg)' }
          return (
            <div key={i} style={style}>
              {line || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

/** Markdown renderer for assistant bubbles, styled for the dark transcript. */
// Custom code renderer: syntax-highlight fenced blocks with the shared hljs;
// leave inline code (no language class) to the CSS styling.
function MdCode({
  className,
  children,
}: {
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const lang = /language-(\w+)/.exec(className ?? '')?.[1]
  const html = lang ? highlight(String(children).replace(/\n$/, ''), lang) : null
  if (html) {
    return <code className="hljs !bg-transparent" dangerouslySetInnerHTML={{ __html: html }} />
  }
  return <code className={className}>{children}</code>
}

/** Small clipboard button; flips to "Copied" for a beat after a click. */
function CopyButton({
  text,
  className = '',
}: {
  text: string
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }}
      title="copy to clipboard"
      className={`rounded border border-zinc-700 bg-zinc-800/80 px-1.5 py-0.5 text-[10px] leading-none text-zinc-300 backdrop-blur transition hover:bg-zinc-700 ${className}`}
    >
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  )
}

// Minimal shape of the hast node react-markdown hands to element components —
// enough to walk it for the block's raw text (the rendered <code> may be
// highlighted HTML, so the DOM children aren't a reliable source).
type HastNode = { type?: string; value?: string; children?: HastNode[] }
const nodeText = (n?: HastNode): string =>
  !n ? '' : n.type === 'text' ? (n.value ?? '') : (n.children ?? []).map(nodeText).join('')

/**
 * Fenced code block wrapper: adds a hover-reveal Copy button. Overriding `pre`
 * (not `code`) keeps inline code untouched — react-markdown only wraps block
 * code in <pre>.
 */
function MdPre({
  children,
  node,
}: {
  children?: React.ReactNode
  node?: HastNode
}): React.JSX.Element {
  const code = nodeText(node).replace(/\n$/, '')
  return (
    <div className="group/code relative">
      <CopyButton
        text={code}
        className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100"
      />
      <pre>{children}</pre>
    </div>
  )
}

const MD_COMPONENTS = { code: MdCode, pre: MdPre }

function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="space-y-2 text-sm [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-400 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:text-base [&_h1]:font-bold [&_h2]:text-sm [&_h2]:font-bold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-[var(--code-border)] [&_pre]:bg-[var(--code-bg)] [&_pre]:p-3 [&_pre]:text-[var(--code-fg)] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:border-collapse [&_td]:border [&_td]:border-zinc-700 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-zinc-700 [&_th]:bg-zinc-800 [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
