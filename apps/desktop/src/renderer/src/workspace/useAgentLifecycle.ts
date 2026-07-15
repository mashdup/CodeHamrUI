import { useEffect } from 'react'
import type { Item } from './types'

interface UseAgentLifecycleParams {
  cwd: string
  onEvent: (event: any) => void
  push: (item: Item) => void
  uid: () => string
  setConnected: (connected: boolean) => void
  endTurn: () => void
}

/**
 * Subscribe to this workspace's slice of the event streams: protocol events,
 * agent stderr noise, and exit notifications.
 */
export function useAgentLifecycle({
  cwd,
  onEvent,
  push,
  uid,
  setConnected,
  endTurn,
}: UseAgentLifecycleParams): void {
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
}
