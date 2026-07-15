import { useMemo } from 'react'
import type { Item, ToolItem } from './types'

export type RenderedEntry =
  | { kind: 'item'; item: Item }
  | { kind: 'group'; id: string; tools: ToolItem[] }

type PinnedMessage = Extract<Item, { kind: 'user' | 'assistant' }>

/**
 * Groups consecutive tool items into a single render entry and exposes
 * pinned-message helpers (filter, toggle, copy, scroll-to).
 */
export function useTranscriptRender(
  items: Item[],
  setItems: React.Dispatch<React.SetStateAction<Item[]>>,
  showToast: (msg: string) => void,
): {
  rendered: RenderedEntry[]
  pinned: PinnedMessage[]
  togglePin: (id: string) => void
  copyMessage: (id: string) => void
  scrollToMessage: (id: string) => void
} {
  // Consecutive tool calls collapse into one group card (agents often chain
  // several reads/writes back to back); anything else renders as itself.
  const rendered = useMemo<RenderedEntry[]>(() => {
    const out: RenderedEntry[] = []
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
    (it): it is PinnedMessage =>
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

  return { rendered, pinned, togglePin, copyMessage, scrollToMessage }
}
