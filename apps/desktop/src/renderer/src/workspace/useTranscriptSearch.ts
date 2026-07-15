import { useRef, useState } from 'react'
import type { Item } from './types'

type SearchResult = Extract<Item, { kind: 'user' | 'assistant' }>

/**
 * Transcript search: filters user/assistant messages by query, handles the
 * search modal open/close state, and scrolls + flashes the target message
 * when the user picks a result.
 */
export function useTranscriptSearch(
  items: Item[],
  scrollToMessage: (id: string) => void,
): {
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void
  query: string
  setQuery: (q: string) => void
  trimmedQuery: string
  searchResults: SearchResult[]
  flashId: string | null
  jumpToMessage: (id: string) => void
} {
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<number | undefined>(undefined)

  const trimmedQuery = query.trim().toLowerCase()
  const searchResults = trimmedQuery
    ? items
        .filter(
          (it): it is SearchResult =>
            (it.kind === 'user' || it.kind === 'assistant') &&
            it.text.toLowerCase().includes(trimmedQuery),
        )
        .slice(0, 50)
    : []

  const jumpToMessage = (id: string): void => {
    setSearchOpen(false)
    scrollToMessage(id)
    setFlashId(id)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashId(null), 1600)
  }

  return {
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    trimmedQuery,
    searchResults,
    flashId,
    jumpToMessage,
  }
}
