import { useCallback } from 'react'
import type { AgentEvent, ModelProfile, PermissionMode } from '@codehamr-ui/protocol'
import { PROTOCOL_VERSION } from '@codehamr-ui/protocol'
import type { InferenceStats, Item, Phase } from './types'
import { uid } from './types'
import { toolLabel, isAbsPath } from './helpers'

/**
 * useAgentEvents: handles all agent protocol events (ready, deltas, tool calls, etc.)
 * and updates workspace state accordingly. Extracted from Workspace.tsx to reduce
 * its size and improve maintainability.
 */
export function useAgentEvents({
  cwd,
  modeRef,
  showToast,
  setConnected,
  setActiveModel,
  setModels,
  setMode,
  resetSessionStats,
  endTurn,
  push,
  reloadDirs,
  setItems,
  requestAgentPreview,
  setAsk,
  setPhase,
  genStartRef,
  genCharsRef,
  prefillMsRef,
  roundStartRef,
  setStep,
  setStreamMeter,
  setRunningTool,
  setLastInference,
  lastGenMsRef,
}: {
  cwd: string
  modeRef: React.MutableRefObject<PermissionMode>
  showToast: (msg: string) => void
  setConnected: (v: boolean) => void
  setActiveModel: (v: string) => void
  setModels: (v: ModelProfile[]) => void
  setMode: (v: PermissionMode) => void
  resetSessionStats: () => void
  endTurn: () => void
  push: (item: Item) => void
  reloadDirs: (dirs: string[]) => void
  setItems: React.Dispatch<React.SetStateAction<Item[]>>
  requestAgentPreview: (path?: string, url?: string) => void
  setAsk: (v: { callId: string; prompt: string; options: string[] } | null) => void
  setPhase: (v: Phase) => void
  genStartRef: React.MutableRefObject<number | null>
  genCharsRef: React.MutableRefObject<number>
  prefillMsRef: React.MutableRefObject<number | null>
  roundStartRef: React.MutableRefObject<number | null>
  setStep: React.Dispatch<React.SetStateAction<number>>
  setStreamMeter: (v: { tokens: number; tokPerSec: number } | null) => void
  setRunningTool: (v: string) => void
  setLastInference: (v: InferenceStats | null) => void
  lastGenMsRef: React.MutableRefObject<number | null>
}): (event: AgentEvent) => void {
  return useCallback(
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
                : `Context compacted — ${event.message ?? "the agent's memory was summarized"}. Your visible chat is unchanged.`,
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
    [cwd, modeRef, showToast, setConnected, setActiveModel, setModels, setMode, resetSessionStats, endTurn, push, reloadDirs, setItems, requestAgentPreview, setAsk, setPhase, genStartRef, genCharsRef, prefillMsRef, roundStartRef, setStep, setStreamMeter, setRunningTool, setLastInference, lastGenMsRef],
  )
}
