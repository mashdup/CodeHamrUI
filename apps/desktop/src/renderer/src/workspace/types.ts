// ---------------------------------------------------------------------------
// Transcript model: the renderer's view of the conversation, built by folding
// protocol events. Kept deliberately flat — one array, discriminated items.
// ---------------------------------------------------------------------------

// Module-scoped so ids stay unique across every workspace tab.
let nextId = 0
export const uid = (): string => `i${nextId++}`

/** Reseat the id counter past restored ids so new items can't collide. */
export function reseatIds(items: { id: string }[]): void {
  for (const it of items) {
    const n = Number(String(it.id).slice(1))
    if (Number.isFinite(n) && n >= nextId) nextId = n + 1
  }
}

export type ToolStatus = 'pending_approval' | 'running' | 'done' | 'failed' | 'denied'

export type Item =
  | { kind: 'user'; id: string; text: string; images?: string[]; files?: string[]; pinned?: boolean } // data: URLs, file names
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; pinned?: boolean }
  | { kind: 'reasoning'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string // callId
      name: string
      args: Record<string, unknown>
      status: ToolStatus
      output?: string
      liveOutput?: string // incremental bash stdout/stderr while running
      background?: boolean // bash left a process running past the turn
      diff?: { path: string; unifiedDiff: string }
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' }

export type ToolItem = Extract<Item, { kind: 'tool' }>

/** A tool-approval decision callback, threaded down to the tool cards. */
export type Decide = (callId: string, decision: 'allow' | 'deny', scope?: 'session') => void

/**
 * Phase drives the live status bar. Local models can be silent for minutes
 * during prefill, and reasoning models think before answering — without this
 * the app looks hung exactly when the agent is working hardest.
 */
export type Phase = 'idle' | 'waiting' | 'thinking' | 'streaming' | 'tool'

/** Which preview panels are open, in stacking order (top → bottom). */
export type PreviewPanel = 'file' | 'browser'

/** Token usage of the last completed turn, for the status-bar readout. */
export type InferenceStats = {
  promptTokens: number
  completionTokens: number
  contextWindow?: number // effective window the agent packed against this turn
  durationMs?: number // wall-clock of the last response's generation, for tok/s
}

// Slash commands available from the composer. `arg` (when set) means the
// command takes an argument, so completing it inserts a trailing space instead
// of running immediately. Handlers live in runSlash inside the component.
export type SlashCmd = { name: string; desc: string; arg?: string }
export const SLASH_COMMANDS: SlashCmd[] = [
  { name: '/compact', desc: 'Summarize the conversation to reclaim context' },
  { name: '/model', desc: 'Switch model', arg: '<name>' },
  { name: '/clear', desc: 'Reset the conversation' },
  { name: '/help', desc: 'List slash commands' },
]

/**
 * Attachments are either images (sent as multimodal content parts, model
 * permitting) or text files (inlined into the prompt with their absolute
 * path, so the agent can go straight to read_file/edit_file on them).
 */
export type ImageAttachment = { kind: 'image'; mime: string; dataB64: string }
export type FileAttachment = {
  kind: 'file'
  name: string
  path: string // '' for pasted/synthetic files with no filesystem path
  text: string
  truncated: boolean
}
export type Attachment = ImageAttachment | FileAttachment

export const MAX_ATTACHMENTS = 6
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_FILE_BYTES = 2 * 1024 * 1024 // refuse to even read past this
export const MAX_INLINE_CHARS = 60_000 // ~15k tokens; the rest is a read_file away

/** An archived chat in a workspace's history list. */
export interface ChatEntry {
  id: string
  title: string
  updatedAt: number
  current: boolean
}
