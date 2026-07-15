import { useEffect, useRef } from 'react'
import type { Item } from './types'

interface UseTranscriptPersistenceParams {
  cwd: string
  items: Item[]
  setItems: React.Dispatch<React.SetStateAction<Item[]>>
  setMode: (mode: any) => void
  modeRef: React.MutableRefObject<any>
  reseatIds: (items: Item[]) => void
  push: (item: Item) => void
  uid: () => string
}

export function useTranscriptPersistence({
  cwd,
  items,
  setItems,
  setMode,
  modeRef,
  reseatIds,
  push,
  uid,
}: UseTranscriptPersistenceParams): React.MutableRefObject<boolean> {
  const loadedRef = useRef(false)
  const bootedRef = useRef(false)

  // Boot: restore the saved transcript, then start (or adopt) the agent.
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

  return loadedRef
}
