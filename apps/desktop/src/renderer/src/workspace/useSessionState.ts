import { useState, useCallback, useRef, useEffect } from 'react'
import type { Item, Phase } from './types'

export function useSessionState(setItems: React.Dispatch<React.SetStateAction<Item[]>>) {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [runningTool, setRunningTool] = useState<string>('')
  const [turnStart, setTurnStart] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [step, setStep] = useState(0)
  const [streamMeter, setStreamMeter] = useState<{ tokens: number; tokPerSec: number } | null>(null)
  
  const genCharsRef = useRef(0)
  const prefillMsRef = useRef<number | null>(null)
  const roundStartRef = useRef<number | null>(null)
  const genStartRef = useRef<number | null>(null)

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
    genStartRef.current = null
    // Freeze any still-streaming bubbles so the caret stops blinking.
    setItems((prev) =>
      prev.map((it) =>
        (it.kind === 'assistant' || it.kind === 'reasoning') && it.streaming
          ? { ...it, streaming: false }
          : it,
      ),
    )
  }, [setItems])

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

  return {
    busy,
    setBusy,
    phase,
    setPhase,
    runningTool,
    setRunningTool,
    turnStart,
    setTurnStart,
    elapsed,
    setElapsed,
    step,
    setStep,
    streamMeter,
    setStreamMeter,
    genCharsRef,
    prefillMsRef,
    roundStartRef,
    genStartRef,
    endTurn,
  }
}
