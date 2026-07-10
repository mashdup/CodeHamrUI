import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AgentEvent, ModelProfile } from '@codehamr-ui/protocol'
import { PROTOCOL_VERSION } from '@codehamr-ui/protocol'
import { SettingsPanel } from './Settings'
import { FileTree, FileViewer } from './FileTree'

// ---------------------------------------------------------------------------
// Transcript model: the renderer's view of the conversation, built by folding
// protocol events. Kept deliberately flat — one array, discriminated items.
// ---------------------------------------------------------------------------

type ToolStatus = 'pending_approval' | 'running' | 'done' | 'failed' | 'denied'

type Item =
  | { kind: 'user'; id: string; text: string; images?: string[] } // data: URLs
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string // callId
      name: string
      args: Record<string, unknown>
      status: ToolStatus
      output?: string
      diff?: { path: string; unifiedDiff: string }
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' }

/**
 * Phase drives the live status bar. Local models can be silent for minutes
 * during prefill, and reasoning models think before answering — without this
 * the app looks hung exactly when the agent is working hardest.
 */
type Phase = 'idle' | 'waiting' | 'thinking' | 'streaming' | 'tool'

// Module-scoped so ids stay unique across every workspace tab.
let nextId = 0
const uid = (): string => `i${nextId++}`

interface Attachment {
  mime: string
  dataB64: string
}

const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** File → base64 attachment; oversized or non-image files resolve to null. */
async function fileToAttachment(file: File): Promise<Attachment | null> {
  if (!file.type.startsWith('image/') || file.size > MAX_IMAGE_BYTES) return null
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
  const comma = dataUrl.indexOf(',')
  return { mime: file.type, dataB64: dataUrl.slice(comma + 1) }
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
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [showFiles, setShowFiles] = useState(true)
  const [treeRefresh, setTreeRefresh] = useState(0)
  const [viewer, setViewer] = useState<{ path: string; body: string; note: string | null } | null>(
    null,
  )
  const [items, setItems] = useState<Item[]>([])
  const [input, setInput] = useState('')
  const [queue, setQueue] = useState<{ text: string; images: Attachment[] }[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [runningTool, setRunningTool] = useState<string>('')
  const [turnStart, setTurnStart] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const push = useCallback((item: Item) => {
    setItems((prev) => [...prev, item])
  }, [])

  const endTurn = useCallback(() => {
    setBusy(false)
    setPhase('idle')
    setRunningTool('')
    setTurnStart(null)
    // Freeze any still-streaming bubbles so the caret stops blinking.
    setItems((prev) =>
      prev.map((it) =>
        (it.kind === 'assistant' || it.kind === 'reasoning') && it.streaming
          ? { ...it, streaming: false }
          : it,
      ),
    )
  }, [])

  // Fold agent events into the transcript.
  const onEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'ready':
          setConnected(true)
          setActiveModel(event.activeModel)
          setModels(event.models)
          if (event.historyLen) {
            push({
              kind: 'notice',
              id: uid(),
              text: `resumed session — the model remembers ${event.historyLen} messages`,
              tone: 'info',
            })
          }
          break
        case 'cleared':
          setItems([])
          break
        case 'file_diff':
          setTreeRefresh((n) => n + 1) // the agent changed a file; tree catches up
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.id === event.callId
                ? { ...it, diff: { path: event.path, unifiedDiff: event.unifiedDiff } }
                : it,
            ),
          )
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
          setRunningTool(event.name)
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
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.id === event.callId
                ? { ...it, status: event.ok ? 'done' : 'failed', output: event.output }
                : it,
            ),
          )
          break
        case 'turn_done':
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
    [endTurn, push],
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

  // Elapsed ticker for the status bar: proof of life while the model is silent.
  useEffect(() => {
    if (turnStart === null) return
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - turnStart) / 1000)), 1000)
    return () => clearInterval(t)
  }, [turnStart])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items])

  // Boot: restore the saved transcript, then start (or adopt) the agent.
  const loadedRef = useRef(false)
  const bootedRef = useRef(false)
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true
    void (async () => {
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

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      const abs = toAbs(path)
      const result = await window.codehamr.readTextFile(cwd, abs)
      if (result.kind === 'text') {
        setViewer({
          path: abs,
          body: result.content,
          note: result.truncated ? 'truncated view' : null,
        })
      } else {
        setViewer({
          path: abs,
          body: '',
          note: result.kind === 'binary' ? 'binary file' : `too large (${result.size} bytes)`,
        })
      }
    },
    [cwd, toAbs],
  )

  const addFiles = async (files: Iterable<File>): Promise<void> => {
    const converted = await Promise.all([...files].map(fileToAttachment))
    const good = converted.filter((a): a is Attachment => a !== null)
    if (good.length === 0) return
    setAttachments((prev) => [...prev, ...good].slice(0, MAX_IMAGES))
  }

  const dispatchPrompt = useCallback(
    async (text: string, images: Attachment[]): Promise<void> => {
      setBusy(true)
      setPhase('waiting')
      setTurnStart(Date.now())
      setElapsed(0)
      push({
        kind: 'user',
        id: uid(),
        text,
        images: images.length
          ? images.map((a) => `data:${a.mime};base64,${a.dataB64}`)
          : undefined,
      })
      await window.codehamr.send(cwd, {
        v: PROTOCOL_VERSION,
        type: 'prompt',
        text,
        images: images.length ? images : undefined,
      })
    },
    [cwd, push],
  )

  const sendPrompt = async (): Promise<void> => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !connected) return
    const images = attachments
    setInput('')
    setAttachments([])
    // Mid-turn: queue instead of rejecting — it dispatches when the turn ends.
    if (busy) {
      setQueue((q) => [...q, { text, images }])
      return
    }
    await dispatchPrompt(text, images)
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

  const awaitingApproval = items.some(
    (it) => it.kind === 'tool' && it.status === 'pending_approval',
  )

  // Transcript search: filter view over the item's searchable text (never the
  // base64 image payloads — they'd false-match almost any query).
  const itemText = (it: Item): string => {
    switch (it.kind) {
      case 'tool':
        return `${it.name} ${JSON.stringify(it.args)} ${it.output ?? ''} ${it.diff?.unifiedDiff ?? ''}`
      default:
        return it.text
    }
  }
  const trimmedQuery = query.trim().toLowerCase()
  const shown = trimmedQuery
    ? items.filter((it) => itemText(it).toLowerCase().includes(trimmedQuery))
    : items

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
          setViewer(null)
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
          drop images to attach
        </div>
      )}

      <div className="relative flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
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
        <button
          onClick={() => setShowFiles((s) => !s)}
          title="toggle the file tree (Ctrl+B)"
          className={`rounded px-2.5 py-0.5 text-xs hover:bg-zinc-700 ${showFiles ? 'bg-zinc-700' : 'bg-zinc-800'}`}
        >
          Files
        </button>
        {searchOpen ? (
          <span className="flex items-center gap-1.5">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search transcript… (Esc closes)"
              className="w-56 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs outline-none focus:border-zinc-500"
            />
            {trimmedQuery && (
              <span className="text-[11px] text-zinc-500">
                {shown.length} match{shown.length === 1 ? '' : 'es'}
              </span>
            )}
          </span>
        ) : (
          <button
            onClick={() => setSearchOpen(true)}
            title="search transcript (Ctrl+F)"
            className="rounded bg-zinc-800 px-2.5 py-0.5 text-xs hover:bg-zinc-700"
          >
            Search
          </button>
        )}
        <div className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
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

      <div className="flex min-h-0 flex-1">
        {showFiles && (
          <aside className="w-56 shrink-0 overflow-y-auto border-r border-zinc-800">
            <FileTree
              root={cwd}
              touched={touched}
              refreshKey={treeRefresh}
              onOpen={(p) => void openFile(p)}
            />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {items.length === 0 && (
              <p className="mt-24 text-center text-sm text-zinc-500">
                {connected ? 'Ready. Ask the agent something.' : 'Starting agent…'}
              </p>
            )}
            {items.length > 0 && shown.length === 0 && (
              <p className="mt-24 text-center text-sm text-zinc-500">
                nothing matches “{query.trim()}”
              </p>
            )}
            {shown.map((item) => (
              <TranscriptItem
                key={item.id}
                item={item}
                onDecide={decide}
                onOpenFile={(p) => void openFile(p)}
              />
            ))}
          </div>

          {busy && (
            <StatusBar
              phase={awaitingApproval ? 'approval' : phase}
              tool={runningTool}
              elapsed={elapsed}
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
              <div className="mb-2 flex items-end gap-2">
                {attachments.map((a, i) => (
                  <div key={i} className="group relative">
                    <img
                      src={`data:${a.mime};base64,${a.dataB64}`}
                      className="h-16 w-16 rounded border border-zinc-700 object-cover"
                    />
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                      className="absolute -top-1.5 -right-1.5 hidden h-4 w-4 items-center justify-center rounded-full bg-zinc-700 text-[10px] leading-none group-hover:flex hover:bg-red-700"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <VisionHint models={models} activeModel={activeModel} />
              </div>
            )}
            <div className="flex gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
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
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void sendPrompt()
                  }
                }}
                rows={2}
                placeholder={
                  !connected
                    ? 'Starting agent…'
                    : busy
                      ? 'Type ahead — sends when the current turn finishes'
                      : 'Ask the agent… (Enter to send)'
                }
                disabled={!connected}
                className="flex-1 resize-none rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none focus:border-zinc-500 disabled:opacity-50"
              />
              <button
                onClick={() => void sendPrompt()}
                disabled={!connected || (input.trim() === '' && attachments.length === 0)}
                className={`rounded px-4 text-sm font-medium disabled:opacity-40 ${
                  busy ? 'bg-zinc-700 hover:bg-zinc-600' : 'bg-emerald-700 hover:bg-emerald-600'
                }`}
              >
                {busy ? 'Queue' : 'Send'}
              </button>
            </div>
          </footer>
        </div>

        {viewer && (
          <div className="flex w-2/5 shrink-0">
            <FileViewer file={viewer} onClose={() => setViewer(null)} />
          </div>
        )}
      </div>
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
  onCancel,
}: {
  phase: Phase | 'approval'
  tool: string
  elapsed: number
  onCancel: () => void
}): React.JSX.Element {
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  const clock = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
  const label = phase === 'tool' && tool ? `running ${tool}` : phaseText[phase]
  return (
    <div className="flex items-center gap-2 border-t border-zinc-800 bg-zinc-900/70 px-4 py-1.5 text-xs text-zinc-400">
      <span
        className={`h-2 w-2 shrink-0 animate-pulse rounded-full ${
          phase === 'approval' ? 'bg-amber-400' : 'bg-emerald-500'
        }`}
      />
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
        <div className="ml-auto max-w-[80%] rounded-lg bg-emerald-900/40 px-3 py-2 text-sm whitespace-pre-wrap">
          {item.images && item.images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {item.images.map((src, i) => (
                <img key={i} src={src} className="max-h-40 rounded border border-emerald-800/50" />
              ))}
            </div>
          )}
          {item.text}
        </div>
      )
    case 'assistant':
      return (
        <div className="max-w-[85%] rounded-lg bg-zinc-900 px-3 py-2 text-sm">
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
    <div className="max-w-[85%] rounded-lg border border-zinc-800/60 bg-zinc-900/40 text-xs text-zinc-500">
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
}: {
  item: Extract<Item, { kind: 'tool' }>
  onDecide: Decide
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const summary =
    item.name === 'bash'
      ? String(item.args.cmd ?? '')
      : String(item.args.path ?? JSON.stringify(item.args))

  return (
    <div className="max-w-[85%] rounded-lg border border-zinc-800 bg-zinc-900/60 text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="font-mono text-xs text-amber-400">{item.name}</span>
        <span className="truncate font-mono text-xs text-zinc-400">{summary}</span>
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
    <div className="border-t border-zinc-800">
      <button
        onClick={() => onOpenFile(diff.path)}
        title="open this file in the viewer"
        className="px-3 pt-2 font-mono text-xs text-sky-400 hover:underline"
      >
        {diff.path}
      </button>
      <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-5">
        {lines.map((line, i) => {
          let cls = 'text-zinc-400'
          if (line.startsWith('+') && !line.startsWith('+++'))
            cls = 'bg-emerald-950/60 text-emerald-300'
          else if (line.startsWith('-') && !line.startsWith('---'))
            cls = 'bg-red-950/60 text-red-300'
          else if (line.startsWith('@@')) cls = 'text-sky-400'
          else if (line.startsWith('+++') || line.startsWith('---')) cls = 'text-zinc-500'
          return (
            <div key={i} className={cls}>
              {line || ' '}
            </div>
          )
        })}
      </pre>
    </div>
  )
}

/** Markdown renderer for assistant bubbles, styled for the dark transcript. */
function Markdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="space-y-2 text-sm [&_a]:text-sky-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-700 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-400 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:text-base [&_h1]:font-bold [&_h2]:text-sm [&_h2]:font-bold [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-zinc-950 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:border-collapse [&_td]:border [&_td]:border-zinc-700 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-zinc-700 [&_th]:bg-zinc-800 [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}
