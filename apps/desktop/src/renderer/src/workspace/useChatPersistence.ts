import { useRef, useState } from 'react'
import type { Attachment, ChatEntry, Item } from './types'
import { reseatIds } from './types'

interface ChatPersistenceDeps {
  cwd: string
  connected: boolean
  busy: boolean
  items: Item[]
  setConnected: (v: boolean) => void
  setItems: React.Dispatch<React.SetStateAction<Item[]>>
  setQueue: React.Dispatch<React.SetStateAction<{ text: string; images: Attachment[] }[]>>
  resetSessionStats: () => void
  push: (item: Item) => void
}

/**
 * Chat persistence: manages the chat list, transcript load/save, and
 * chat lifecycle (new, switch, remove). Owns `loadedRef` which gates
 * both the initial transcript restore and the autosave debounce.
 */
export function useChatPersistence({
  cwd,
  connected,
  busy,
  items,
  setConnected,
  setItems,
  setQueue,
  resetSessionStats,
  push,
}: ChatPersistenceDeps): {
  chats: ChatEntry[]
  setChats: React.Dispatch<React.SetStateAction<ChatEntry[]>>
  historyOpen: boolean
  setHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>
  loadedRef: React.MutableRefObject<boolean>
  flushTranscript: () => Promise<void>
  loadChats: () => Promise<void>
  loadTranscriptFromDisk: () => Promise<void>
  newChat: () => Promise<void>
  switchToChat: (id: string) => Promise<void>
  removeChat: (id: string) => Promise<void>
} {
  const [chats, setChats] = useState<ChatEntry[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const loadedRef = useRef(false)

  /** Force-write the transcript now — the autosave debounce may be pending. */
  const flushTranscript = async (): Promise<void> => {
    if (loadedRef.current) await window.codehamr.writeTranscript(cwd, items)
  }

  const loadChats = async (): Promise<void> => {
    setChats(await window.codehamr.listChats(cwd))
  }

  const loadTranscriptFromDisk = async (): Promise<void> => {
    const saved = (await window.codehamr.readTranscript(cwd)) as Item[] | null
    if (Array.isArray(saved)) {
      reseatIds(saved)
      setItems(saved.map((it) => ('streaming' in it ? { ...it, streaming: false } : it)))
    } else {
      setItems([])
    }
  }

  const newChat = async (): Promise<void> => {
    if (!connected || busy) return
    setHistoryOpen(false)
    await flushTranscript()
    setConnected(false)
    await window.codehamr.newChatSession(cwd) // archives the current pair
    setItems([])
    setQueue([])
    resetSessionStats()
    await window.codehamr.startAgent(cwd)
  }

  const switchToChat = async (id: string): Promise<void> => {
    setHistoryOpen(false)
    if (busy || chats.find((c) => c.id === id)?.current) return
    await flushTranscript()
    setConnected(false)
    await window.codehamr.switchChat(cwd, id)
    await loadTranscriptFromDisk()
    setQueue([])
    resetSessionStats()
    await window.codehamr.startAgent(cwd)
  }

  const removeChat = async (id: string): Promise<void> => {
    await window.codehamr.deleteChat(cwd, id)
    await loadChats()
  }

  return {
    chats,
    setChats,
    historyOpen,
    setHistoryOpen,
    loadedRef,
    flushTranscript,
    loadChats,
    loadTranscriptFromDisk,
    newChat,
    switchToChat,
    removeChat,
  }
}
