import { useCallback } from 'react'
import type { Attachment, ImageAttachment, FileAttachment, Item, Phase } from './types'
import { PROTOCOL_VERSION } from '@codehamr-ui/protocol'
import type { PermissionMode } from '@codehamr-ui/protocol'
import { uid } from './types'
import { inlineFiles } from './helpers'

interface AgentCommandDeps {
  cwd: string
  busy: boolean
  ask: { callId: string; prompt: string; options: string[] } | null
  activeModel: string
  mode: PermissionMode
  setBusy: (v: boolean) => void
  setPhase: (v: Phase) => void
  setTurnStart: (v: number | null) => void
  setElapsed: (v: number) => void
  setStep: React.Dispatch<React.SetStateAction<number>>
  setStreamMeter: (v: { tokens: number; tokPerSec: number } | null) => void
  setItems: React.Dispatch<React.SetStateAction<Item[]>>
  setQueue: React.Dispatch<React.SetStateAction<Array<{ text: string; images: Attachment[] }>>>
  setAsk: (v: { callId: string; prompt: string; options: string[] } | null) => void
  genCharsRef: React.MutableRefObject<number>
  prefillMsRef: React.MutableRefObject<number | null>
  roundStartRef: React.MutableRefObject<number | null>
  modeRef: React.MutableRefObject<PermissionMode>
  push: (item: Item) => void
}

/**
 * Pure agent commands: thin wrappers around window.codehamr.send() for
 * approvals, ask_user responses, cancellation, model/mode switching, and
 * prompt dispatch. Separated from UI concerns (slash palette, clipboard,
 * snippet insertion) which stay in Workspace.
 */
export function useAgentCommands({
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
}: AgentCommandDeps): {
  dispatchPrompt: (text: string, atts: Attachment[]) => Promise<void>
  cancelTurn: () => Promise<void>
  decide: (callId: string, decision: 'allow' | 'deny', scope?: 'session') => Promise<void>
  answerAsk: (selection: number, custom?: string) => Promise<void>
  switchModel: (name: string) => Promise<void>
  switchMode: (next: PermissionMode) => Promise<void>
} {
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

  const decide = useCallback(
    async (
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
    },
    [cwd],
  )

  // Answer a pending ask_user: either a chosen option (selection >= 0) or a
  // typed custom answer (selection -1 + custom text). Either way the turn
  // continues, so we clear the prompt and return to the tool-wait phase.
  const answerAsk = async (selection: number, custom?: string): Promise<void> => {
    if (!ask) return
    const callId = ask.callId
    setAsk(null)
    setPhase('tool')
    await window.codehamr.send(cwd, {
      v: PROTOCOL_VERSION,
      type: 'ask_user_response',
      callId,
      selection,
      custom,
    })
  }

  const switchModel = async (name: string): Promise<void> => {
    if (busy || name === activeModel) return
    await window.codehamr.send(cwd, { v: PROTOCOL_VERSION, type: 'set_model', name })
  }

  const switchMode = async (next: PermissionMode): Promise<void> => {
    if (busy || next === mode) return
    modeRef.current = next // 'ready' after a restart must see the new choice
    await window.codehamr.setMode(cwd, next) // persist for this workspace
    await window.codehamr.send(cwd, { v: PROTOCOL_VERSION, type: 'set_mode', mode: next })
  }

  return {
    dispatchPrompt,
    cancelTurn,
    decide,
    answerAsk,
    switchModel,
    switchMode,
  }
}
