import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent, ModelProfile, PermissionMode } from '@codehamr-ui/protocol'
import { PROTOCOL_VERSION } from '@codehamr-ui/protocol'
import { AppearanceModal, SettingsPanel } from './Settings'
import { FileTree } from './FileTree'
import { FilePreview } from './FilePreview'
import { BrowserPane } from './BrowserPane'
import { StatusBar, ContextMeter, VisionHint } from './components/StatusBar'
import { TranscriptItem } from './components/TranscriptItem'
import { ToolGroupCard } from './components/ToolCard'
import { Composer } from './components/Composer'

import { ResizeHandle, RowResizeHandle, BarMenuItem } from './components/ResizeHandle'
import { SearchModal, HistoryModal } from './components/Modals'
import type { Attachment, ImageAttachment, FileAttachment, Item, ToolItem, Phase, SlashCmd, ChatEntry } from './workspace/types'
import { uid, reseatIds, SLASH_COMMANDS, MAX_ATTACHMENTS } from './workspace/types'
import { basename, clamp, normPath, isAbsPath, toolLabel, fileToAttachment, inlineFiles } from './workspace/helpers'
import { useElementWidth } from './workspace/hooks'
import { useGitStatus } from './workspace/useGitStatus'
import { usePreviewPanels } from './workspace/usePreviewPanels'
import { useAgentCommands } from './workspace/useAgentCommands'
import { TREE_MIN, TREE_MAX, PREVIEW_MIN } from './workspace/layout'

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
  const dragDepth = useRef(0)
  // Targeted tree reload: which directories to re-fetch (only loaded ones are
  // acted on). nonce makes each signal distinct even if the dirs repeat.
  const [treeReload, setTreeReload] = useState<{ dirs: string[]; nonce: number } | null>(null)
  const reloadDirs = useCallback((dirs: string[]) => {
    setTreeReload((prev) => ({ dirs, nonce: (prev?.nonce ?? 0) + 1 }))
  }, [])
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
  /** Resolve a tool-arg path (usually workspace-relative) to absolute. */
  const toAbs = useCallback(
    (p: string): string => (isAbsPath(p) ? p : `${cwd}/${p}`),
    [cwd],
  )
  // Responsive layout + stacked preview slot (file viewer + live browser).
  const {
    showFiles,
    setShowFiles,
    setTreeWidth,
    setPreviewWidth,
    viewer,
    browserOpen,
    setBrowserOpen,
    panelOrder,
    openPanel,
    closeViewer,
    closeBrowser,
    previewSlotRef,
    splitRatio,
    adjustSplit,
    browserNav,
    requestAgentPreview,
    previewInUse,
    mainRef,
    layout,
    openFile,
  } = usePreviewPanels(cwd, toAbs)
  const [items, setItems] = useState<Item[]>([])

  // Git branch + working-tree diff stat for the bar, refreshed on mount, on
  // filesystem changes, and when a turn ends (the agent just edited files).
  const { currentBranch, diffStats, changedPaths, refreshGitStat } = useGitStatus(cwd)
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Slash-command palette: highlighted row, and a dismissed flag so Escape can
  // hide the popover without clearing what the user typed.
  const [slashSel, setSlashSel] = useState(0)
  const [slashClosed, setSlashClosed] = useState(false)
  const [queue, setQueue] = useState<{ text: string; images: Attachment[] }[]>([])
  // Pending ask_user selection: the agent is blocked on the user picking one of
  // these options (or typing a custom answer) above the composer. Null when the
  // agent isn't asking. Cleared when the user answers.
  const [ask, setAsk] = useState<{ callId: string; prompt: string; options: string[] } | null>(
    null,
  )
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
  // True while the user has manually scrolled away from the bottom. While true,
  // auto-scroll-on-content is suppressed and a gradient overlay hints at new
  // content below. Resets whenever the user scrolls back to the bottom.
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const userScrolledUpRef = useRef(false) // mirror for hot-path reads in effects
  const AT_BOTTOM_THRESHOLD = 20 // px from true bottom to consider "at bottom"

  const handleMessagesScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distFromBottom < AT_BOTTOM_THRESHOLD
    userScrolledUpRef.current = !atBottom
    setUserScrolledUp(!atBottom)
  }, [])


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
          resetSessionStats()
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
          const abs = isAbsPath(event.path) ? event.path : `${cwd}/${event.path}`
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
          // Agent-requested preview (preview_file / preview_url tools); the
          // preview hook opens the panel in a follow-up effect.
          requestAgentPreview(event.path, event.url)
          break
        case 'ask_user':
          // Agent is blocked on a user selection: surface the options above the
          // composer. The tool card still renders as running; answering it
          // sends an ask_user_response and unblocks the turn.
          setAsk({ callId: event.callId, prompt: event.prompt, options: event.options })
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
        case 'tool_output_delta':
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'tool' && it.id === event.callId
                ? { ...it, liveOutput: (it.liveOutput ?? '') + event.text }
                : it,
            ),
          )
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
                    liveOutput: undefined,
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
    [endTurn, push, showToast, reloadDirs, requestAgentPreview, cwd],
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
    if (!userScrolledUpRef.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    }
  }, [items])

  // Composer auto-grow is handled inside the Composer component (TipTap).

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
        reseatIds(saved)
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
      reseatIds(saved)
      setItems(saved.map((it) => ('streaming' in it ? { ...it, streaming: false } : it)))
    } else {
      setItems([])
    }
  }

  // Token/context readouts describe the *active* session's last turn, so they
  // must be dropped when the session changes — otherwise the stale count and
  // context-window bar carry over into a freshly opened or switched-to chat.
  const resetSessionStats = (): void => {
    setLastInference(null)
    setStreamMeter(null)
    genStartRef.current = null
    lastGenMsRef.current = null
  }

  const newChat = async (): Promise<void> => {
    if (!connected || busy) return
    setHistoryOpen(false)
    await flushTranscript()
    setConnected(false)
    await window.codehamr.newChatSession(cwd) // archives the current pair
    setItems([])
    setQueue([])
    resetSessionStats()
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
    resetSessionStats()
    await window.codehamr.startAgent(cwd)
  }

  const removeChat = async (id: string): Promise<void> => {
    await window.codehamr.deleteChat(cwd, id)
    await loadChats()
  }

  // Files the agent wrote/edited this session — emerald dots in the tree.
  const touched = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      if (
        it.kind === 'tool' &&
        (it.name === 'write_file' || it.name === 'edit_file' || it.name === 'multi_edit') &&
        it.status === 'done'
      ) {
        const p = String(it.args.path ?? '')
        if (p) set.add(normPath(toAbs(p)))
      }
    }
    return set
  }, [items, toAbs])

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

  const {
    dispatchPrompt,
    cancelTurn,
    decide,
    answerAsk,
    switchModel,
    switchMode,
  } = useAgentCommands({
    cwd,
    busy,
    ask,
    activeModel,
    mode,
    setBusy,
    setPhase,
    setTurnStart,
    setElapsed,
    setStep,
    setStreamMeter,
    setItems,
    setQueue,
    setAsk,
    genCharsRef,
    prefillMsRef,
    roundStartRef,
    modeRef,
    push,
  })

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
    // A pending ask_user consumes the next typed message as the user's custom
    // answer (selection -1), rather than starting a fresh prompt. Attachments
    // aren't part of an answer, so only plain text routes here.
    if (ask && text && attachments.length === 0) {
      setInput('')
      await answerAsk(-1, text)
      return
    }
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

  // Drop-overlay safety net. The depth-counted enter/leave handlers on the
  // container clear the overlay in the normal case, but a drag can end without
  // any leave/drop landing on us: cancelled with Escape, dropped outside the
  // window, or swallowed by the out-of-process <webview>. These window-level
  // listeners guarantee the "drop files" banner never gets stranded on screen.
  useEffect(() => {
    if (!dragOver) return
    const clear = (): void => {
      dragDepth.current = 0
      setDragOver(false)
    }
    // A dragleave whose relatedTarget is null means the pointer left the
    // window entirely; a global drop/dragend covers drops that never reach us.
    const onLeave = (e: DragEvent): void => {
      if (!e.relatedTarget) clear()
    }
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('blur', clear)
    }
  }, [dragOver])

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
        } else if (historyOpen) {
          setHistoryOpen(false)
        } else if (viewer) {
          closeViewer()
        }
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [visible, searchOpen, historyOpen, viewer])

  // The stacked preview panels (file viewer + live browser), rendered the same
  // whether they sit inline in the column or float as an overlay modal.
  const previewStack = (
    <>
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
    </>
  )

  return (
    <div
      className={`${visible ? 'flex' : 'hidden'} relative min-h-0 flex-1 flex-col`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
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
        {!compactBar && (
          <>
            <button
              onClick={() => setShowFiles((s) => !s)}
              title={
                showFiles && layout.tree.mode === 'overlay'
                  ? 'file tree shown as an overlay — window too narrow to dock it'
                  : 'toggle the file tree (Ctrl+B)'
              }
              className={`rounded px-2.5 py-0.5 text-xs hover:bg-zinc-700 ${
                showFiles
                  ? layout.tree.mode === 'overlay'
                    ? 'bg-zinc-800 text-zinc-300 italic' // shown, but floating over the chat
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
                changed={changedPaths}
                reload={treeReload}
                onOpen={openFile}
              />
            </aside>
            <ResizeHandle
              onResize={(dx) => setTreeWidth((w) => clamp(w + dx, TREE_MIN, TREE_MAX))}
            />
          </>
        )}

        {/* File browser as a modal drawer when there's no room to seat it
            inline. It floats above the chat but below the file preview (z-30 <
            preview's z-40), honoring the view hierarchy. */}
        {layout.tree.mode === 'overlay' && (
          <div className="absolute inset-0 z-30 flex">
            <aside className="relative flex w-full flex-col overflow-hidden bg-zinc-950 shadow-2xl">
              <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-3 py-1.5">
                <span className="text-xs font-medium text-zinc-400">Files</span>
                <button
                  onClick={() => setShowFiles(false)}
                  title="close file browser"
                  className="rounded px-1 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  ✕
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden">
                <FileTree
                  root={cwd}
                  touched={touched}
                  changed={changedPaths}
                  reload={treeReload}
                  onOpen={openFile}
                />
              </div>
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex-1 min-h-0">
          <div
            ref={scrollRef}
            onScroll={handleMessagesScroll}
            // Compact (narrow) view: let bubbles fill the width and trim the
            // side padding, so a cramped column isn't wasting space on a cap.
            style={{ '--msg-max': compactBar ? '100%' : '85%' } as React.CSSProperties}
            className={`h-full space-y-3 overflow-y-auto py-4 ${compactBar ? 'px-2' : 'px-4'}`}
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
                  onOpenFile={openFile}
                  cwd={cwd}
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
                    onOpenFile={openFile}
                    cwd={cwd}
                  />
                </div>
              ),
            )}
          </div>
          {userScrolledUp && (
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-zinc-950 to-transparent" />
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
            {ask && (
              <div className="mb-2 rounded-lg border border-sky-800/60 bg-sky-950/30 p-3">
                <div className="mb-2 text-sm text-zinc-200">{ask.prompt}</div>
                <div className="flex flex-wrap gap-2">
                  {ask.options.map((opt, i) => (
                    <button
                      key={i}
                      autoFocus={i === 0}
                      onClick={() => void answerAsk(i)}
                      className="rounded-md border border-sky-700 bg-sky-900/50 px-3 py-1.5 text-sm text-sky-100 hover:bg-sky-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  Pick an option, or type your own answer below and press Enter.
                </div>
              </div>
            )}
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
              <Composer
                value={input}
                onChange={(v) => {
                  setInput(v)
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
                placeholder={
                  !connected
                    ? 'Starting agent…'
                    : busy
                      ? 'Type ahead — sends when the current turn finishes'
                      : 'Ask the agent… (Enter to send, Shift+Enter for newline)'
                }
                disabled={!connected}
                inputRef={inputRef}
                className="max-h-[260px] min-h-[52px]"
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
              {previewStack}
            </div>
          </>
        )}

        {/* Preview as a modal overlay when there's no room to seat it inline.
            It sits on top of everything (z-40, above the file browser's z-30)
            until closed, honoring the view hierarchy. */}
        {previewInUse && layout.preview.mode === 'overlay' && (
          <div className="absolute inset-0 z-40 flex">
            <div
              ref={previewSlotRef}
              className="relative flex w-full flex-col overflow-hidden bg-zinc-950 shadow-2xl"
            >
              {previewStack}
            </div>
          </div>
        )}
      </div>

      {showAppearance && <AppearanceModal onClose={() => setShowAppearance(false)} />}

      {searchOpen && (
        <SearchModal
          query={query}
          onQuery={setQuery}
          results={searchResults}
          trimmedQuery={trimmedQuery}
          onJump={jumpToMessage}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {historyOpen && (
        <HistoryModal
          chats={chats}
          onSwitch={(id) => void switchToChat(id)}
          onDelete={(id) => void removeChat(id)}
          onClose={() => setHistoryOpen(false)}
        />
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
