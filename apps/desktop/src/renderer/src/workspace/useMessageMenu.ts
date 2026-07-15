import type { Item } from './types'
import { useMenuDismiss } from './useMenuDismiss'

interface UseMessageMenuParams {
  msgMenu: { x: number; y: number; id: string } | null
  setMsgMenu: React.Dispatch<
    React.SetStateAction<{ x: number; y: number; id: string } | null>
  >
  items: Item[]
  setItems: React.Dispatch<React.SetStateAction<Item[]>>
  showToast: (msg: string) => void
}

export function useMessageMenu({
  msgMenu,
  setMsgMenu,
  items,
  setItems,
  showToast,
}: UseMessageMenuParams) {
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

  // Any click or Escape dismisses the message context menu.
  useMenuDismiss(msgMenu, setMsgMenu)

  return { togglePin, copyMessage }
}
