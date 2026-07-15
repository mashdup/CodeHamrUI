import { useEffect, type RefObject } from 'react'
import { PROTOCOL_VERSION } from '@codehamr-ui/protocol'
import type { Attachment, Item, SlashCmd, Phase } from './types'
import { uid, SLASH_COMMANDS } from './types'

interface UseSlashCommandsParams {
  cwd: string
  input: string
  setInput: (value: string | ((prev: string) => string)) => void
  attachments: Attachment[]
  setAttachments: (value: Attachment[] | ((prev: Attachment[]) => Attachment[])) => void
  slashClosed: boolean
  setSlashClosed: (value: boolean) => void
  slashSel: number
  setSlashSel: (value: number | ((prev: number) => number)) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  busy: boolean
  setBusy: (value: boolean) => void
  connected: boolean
  ask: { callId: string; prompt: string; options: string[] } | null
  answerAsk: (index: number, text?: string) => Promise<void>
  queue: Array<{ text: string; images: Attachment[] }>
  setQueue: (value: Array<{ text: string; images: Attachment[] }> | ((prev: Array<{ text: string; images: Attachment[] }>) => Array<{ text: string; images: Attachment[] }>)) => void
  dispatchPrompt: (text: string, attachments: Attachment[]) => Promise<void>
  models: Array<{ name: string; llm: string; url: string; contextSize: number }>
  activeModel: string
  push: (item: Item) => void
  endTurn: () => void
  setPhase: (phase: Phase) => void
  setTurnStart: (time: number) => void
  setElapsed: (time: number) => void
}

export function useSlashCommands({
  cwd,
  input,
  setInput,
  attachments,
  setAttachments,
  slashClosed,
  setSlashClosed,
  slashSel,
  setSlashSel,
  inputRef,
  busy,
  setBusy,
  connected,
  ask,
  answerAsk,
  queue,
  setQueue,
  dispatchPrompt,
  models,
  activeModel,
  push,
  endTurn,
  setPhase,
  setTurnStart,
  setElapsed,
}: UseSlashCommandsParams) {
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

  return {
    slashOpen,
    slashMatches,
    slashIdx,
    pickSlash,
    sendPrompt,
  }
}
