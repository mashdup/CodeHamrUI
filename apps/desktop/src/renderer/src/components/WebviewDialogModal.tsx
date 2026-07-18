import { useEffect, useRef, useState } from 'react'

export interface WebviewDialogRequest {
  id: number
  type: 'alert' | 'confirm' | 'prompt'
  message: string
  default: string
  url: string
}

function hostname(u: string): string {
  try {
    return new URL(u).hostname || u
  } catch {
    return u || 'page'
  }
}

/**
 * WebviewDialogModal: a custom in-app replacement for window.alert / confirm /
 * prompt, fired from <webview> guest pages in the live-preview browser. The
 * main process forwards each sendSync('webview:dialog') request to the host
 * renderer, which shows this modal. While it's open the guest's JS is frozen
 * (sendSync blocks); resolving dismisses the modal and calls
 * replyWebviewDialog(id, value), which lets the main process set
 * event.returnValue and unblock the guest with the correct synchronous return.
 */
export function WebviewDialogModal({
  req,
  onReply,
}: {
  req: WebviewDialogRequest
  onReply: (id: number, value: unknown) => void
}): React.JSX.Element {
  const [promptValue, setPromptValue] = useState(req.default)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (req.type === 'prompt') {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [req.id, req.type])

  const dismiss = (value: unknown): void => {
    onReply(req.id, value)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (req.type === 'prompt') dismiss(promptValue)
      else if (req.type === 'confirm') dismiss(true)
      else dismiss(null) // alert
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (req.type === 'confirm') dismiss(false)
      else if (req.type === 'prompt') dismiss(null)
      else dismiss(null) // alert
    }
  }

  const isPrompt = req.type === 'prompt'
  const isConfirm = req.type === 'confirm'

  const title =
    req.type === 'alert' ? 'Alert' : req.type === 'confirm' ? 'Confirm' : 'Prompt'

  // Enter in the input, Esc everywhere, Tab contained. Modal-level handler
  // covers the buttons too.
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={() => {
        // Click outside = cancel (same as Esc), but only on the backdrop itself
        if (req.type === 'confirm') dismiss(false)
        else if (req.type === 'prompt') dismiss(null)
        else dismiss(null)
      }}
    >
      <div
        className="w-[440px] max-w-[90vw] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
          <DialogIcon type={req.type} />
          <span className="text-sm font-medium text-zinc-200">{title}</span>
          <span className="ml-auto truncate text-xs text-zinc-500" title={req.url}>
            {hostname(req.url)}
          </span>
        </div>

        <div className="px-4 py-4">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm text-zinc-300">
            {req.message}
          </pre>

          {isPrompt && (
            <input
              ref={inputRef}
              autoFocus
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={onKeyDown}
              className="mt-3 w-full rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-zinc-500"
            />
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 px-4 py-3">
          {(isPrompt || isConfirm) && (
            <button
              onClick={() => dismiss(isConfirm ? false : null)}
              className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              Cancel
            </button>
          )}
          {req.type === 'alert' && (
            <button
              onClick={() => dismiss(null)}
              className="rounded bg-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-100 hover:bg-zinc-600"
            >
              OK
            </button>
          )}
          {isConfirm && (
            <button
              onClick={() => dismiss(true)}
              className="rounded bg-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-100 hover:bg-zinc-600"
            >
              OK
            </button>
          )}
          {isPrompt && (
            <button
              onClick={() => dismiss(promptValue)}
              className="rounded bg-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-100 hover:bg-zinc-600"
            >
              OK
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function DialogIcon({ type }: { type: string }): React.JSX.Element {
  const cls = 'h-4 w-4 shrink-0 text-zinc-400'
  if (type === 'alert') {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="13" />
        <circle cx="12" cy="16.5" r="0.5" fill="currentColor" />
      </svg>
    )
  }
  if (type === 'confirm') {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="10" />
        <path d="M9 9l6 6M15 9l-6 6" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M21 11.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7" />
      <path d="M8 7h8M8 11h5" />
      <circle cx="17.5" cy="17.5" r="2.5" />
      <path d="M17.5 15v.5M17.5 19.5v0" />
    </svg>
  )
}
