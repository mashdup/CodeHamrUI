import { useEffect } from 'react'
import type { Preview } from '../FilePreview'

interface UseKeyboardShortcutsParams {
  visible: boolean
  searchOpen: boolean
  historyOpen: boolean
  viewer: Preview | null
  setSearchOpen: (open: boolean) => void
  setQuery: (query: string) => void
  setHistoryOpen: (open: boolean) => void
  setShowFiles: (updater: (prev: boolean) => boolean) => void
  setShowSettings: (show: boolean) => void
  closeViewer: () => void
}

export function useKeyboardShortcuts({
  visible,
  searchOpen,
  historyOpen,
  viewer,
  setSearchOpen,
  setQuery,
  setHistoryOpen,
  setShowFiles,
  setShowSettings,
  closeViewer,
}: UseKeyboardShortcutsParams): void {
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
}
