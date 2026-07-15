import { useEffect } from 'react'

interface UseDragOverlayParams {
  dragOver: boolean
  setDragOver: (over: boolean) => void
  dragDepth: React.MutableRefObject<number>
}

/**
 * Drop-overlay safety net. The depth-counted enter/leave handlers on the
 * container clear the overlay in the normal case, but a drag can end without
 * any leave/drop landing on us: cancelled with Escape, dropped outside the
 * window, or swallowed by the out-of-process <webview>. These window-level
 * listeners guarantee the "drop files" banner never gets stranded on screen.
 */
export function useDragOverlay({ dragOver, setDragOver, dragDepth }: UseDragOverlayParams): void {
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
}
