import { useEffect, useRef } from 'react'

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
  onKeyDown?: (event: React.KeyboardEvent) => void
  onContextMenu?: (event: React.MouseEvent<HTMLTextAreaElement>) => void
  onPaste?: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  className?: string
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
}

/**
 * Plain textarea composer with auto-resize. Shift+Enter inserts a literal
 * newline; plain Enter is handled by the parent (usually to send the prompt).
 */
export function Composer({
  value,
  onChange,
  placeholder,
  disabled = false,
  onKeyDown,
  onContextMenu,
  onPaste,
  className = '',
  inputRef,
}: ComposerProps): React.JSX.Element {
  const internalRef = useRef<HTMLTextAreaElement>(null)
  const ta = inputRef || internalRef

  // Auto-resize the textarea to fit its content.
  useEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = el.scrollHeight + 'px'
  }, [value, ta])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    onChange(e.target.value)
  }

  return (
    <textarea
      ref={ta as React.RefObject<HTMLTextAreaElement>}
      value={value}
      onChange={handleChange}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      onPaste={onPaste}
      placeholder={placeholder}
      disabled={disabled}
      rows={1}
      className={`flex-1 resize-none overflow-y-auto rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none placeholder:text-zinc-500 focus:border-zinc-500 disabled:opacity-50 ${className}`}
      style={{ maxHeight: '260px', minHeight: '52px' }}
    />
  )
}
