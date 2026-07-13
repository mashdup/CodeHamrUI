/**
 * CodeHamr UI wire protocol, v1.
 *
 * NDJSON over the agent child process's stdin/stdout — one JSON object per
 * line. This file is the single source of truth on the TS side and mirrors
 * the Go structs in the fork's `internal/protocol` package; keep the two in
 * lockstep and bump `PROTOCOL_VERSION` together.
 */
import { z } from 'zod'

export const PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// Client → agent (stdin)
// ---------------------------------------------------------------------------

export const ImageAttachment = z.object({
  mime: z.string(), // e.g. "image/png"
  dataB64: z.string(),
})
export type ImageAttachment = z.infer<typeof ImageAttachment>

export const PromptCommand = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('prompt'),
  text: z.string(),
  images: z.array(ImageAttachment).optional(),
})

export const ApproveCommand = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('approve'),
  callId: z.string(),
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session']).optional(),
})

export const CancelCommand = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('cancel'),
})

export const SetModelCommand = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('set_model'),
  name: z.string(),
})

export const GetModelsCommand = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('get_models'),
})

export const ClearCommand = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('clear'),
})

/** Summarize the conversation into a single message to reclaim context. */
export const CompactCommand = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('compact'),
})

/** ask = gate every side-effecting tool; auto = run them unattended. */
export const PermissionMode = z.enum(['ask', 'auto'])
export type PermissionMode = z.infer<typeof PermissionMode>

export const SetModeCommand = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('set_mode'),
  mode: PermissionMode,
})

/** The user's answer to an `ask_user` event: a chosen option index, or -1 with
 *  a typed `custom` answer. There is no cancel — the user always answers. */
export const AskUserResponseCommand = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('ask_user_response'),
  callId: z.string(),
  selection: z.number().int(),
  custom: z.string().optional(),
})

export const Command = z.discriminatedUnion('type', [
  PromptCommand,
  ApproveCommand,
  CancelCommand,
  SetModelCommand,
  GetModelsCommand,
  ClearCommand,
  CompactCommand,
  SetModeCommand,
  AskUserResponseCommand,
])
export type Command = z.infer<typeof Command>

// ---------------------------------------------------------------------------
// Agent → client (stdout)
// ---------------------------------------------------------------------------

export const ModelProfile = z.object({
  name: z.string(),
  llm: z.string(),
  url: z.string(),
  contextSize: z.number().int().nonnegative(),
})
export type ModelProfile = z.infer<typeof ModelProfile>

export const ReadyEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('ready'),
  version: z.string(), // codehamr binary version
  activeModel: z.string(),
  models: z.array(ModelProfile),
  /** Messages restored from .codehamr/session.json; absent when fresh. */
  historyLen: z.number().int().nonnegative().optional(),
  mode: PermissionMode.optional(),
})

export const ClearedEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('cleared'),
})

/** Emitted after a `compact` command: the agent's history was replaced by a
 *  summary. text is the summary, historyLen the new message count, message a
 *  human-readable note (e.g. "compacted 42 messages into a summary"). */
export const CompactedEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('compacted'),
  text: z.string().optional(),
  historyLen: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
})

export const ModeEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('mode'),
  mode: PermissionMode,
})

export const AssistantDeltaEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('assistant_delta'),
  text: z.string(),
})

export const ReasoningDeltaEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('reasoning_delta'),
  text: z.string(),
})

export const AssistantDoneEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('assistant_done'),
})

// Live, incremental bash output: emitted as chunks arrive from a running
// command so the UI can stream stdout/stderr into the tool card before the
// command finishes. Coalesced by the agent to avoid a per-write IPC flood.
// UI-only — the model still receives just the final (capped) tool_result.
export const ToolOutputDeltaEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('tool_output_delta'),
  callId: z.string(),
  text: z.string(),
})
export type ToolOutputDeltaEvent = z.infer<typeof ToolOutputDeltaEvent>

export const ToolCallEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('tool_call'),
  callId: z.string(),
  // Permissive by design: any non-empty tool name renders as a card. A strict
  // enum here means every new tool the binary adds degrades to a raw-JSON noise
  // line until this list is hand-edited — the renderer already has generic
  // summary/color fallbacks (see toolSummary / toolColorClass) for names it
  // doesn't specifically know.
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  needsApproval: z.boolean(),
})
export type ToolCallEvent = z.infer<typeof ToolCallEvent>

export const ToolResultEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('tool_result'),
  callId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  // Set when a bash command's shell exited but a backgrounded child
  // (`cmd &`, `nohup`) is still running past the turn. Renderer badges it.
  background: z.boolean().optional(),
  truncated: z.boolean().optional(),
})

export const FileDiffEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('file_diff'),
  callId: z.string(),
  path: z.string(),
  unifiedDiff: z.string(),
})

/** Agent asked the harness to show something: a workspace file in the
 *  preview panel (path) or a URL in the live browser panel (url). */
export const PreviewEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('preview'),
  path: z.string().optional(),
  url: z.string().optional(),
})

/** Agent is asking the user to pick from a short list (max 5). The renderer
 *  shows the options as buttons above the composer; the user clicks one or
 *  types a custom answer, replied via an `ask_user_response` command carrying
 *  the same callId. */
export const AskUserEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('ask_user'),
  callId: z.string(),
  prompt: z.string(),
  options: z.array(z.string()).min(1).max(5),
})
export type AskUserEvent = z.infer<typeof AskUserEvent>

export const TurnDoneEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('turn_done'),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
      // Effective context window the agent packed against this turn (server
      // header, config context_size, or fallback). Denominator for the
      // context meter; absent on older agents.
      contextWindow: z.number().int().nonnegative().optional(),
    })
    .optional(),
})

export const ModelsEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('models'),
  activeModel: z.string(),
  models: z.array(ModelProfile),
})

export const ErrorEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('error'),
  message: z.string(),
  fatal: z.boolean(),
})

export const LogEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
})

export const AgentEvent = z.discriminatedUnion('type', [
  ReadyEvent,
  ClearedEvent,
  CompactedEvent,
  ModeEvent,
  AssistantDeltaEvent,
  ReasoningDeltaEvent,
  AssistantDoneEvent,
  ToolCallEvent,
  ToolOutputDeltaEvent,
  ToolResultEvent,
  FileDiffEvent,
  PreviewEvent,
  AskUserEvent,
  TurnDoneEvent,
  ModelsEvent,
  ErrorEvent,
  LogEvent,
])
export type AgentEvent = z.infer<typeof AgentEvent>

/**
 * Parse one NDJSON line from the agent. Returns null for lines that are not
 * valid protocol events (blank lines, stray prints) so the bridge can log and
 * skip them instead of crashing the stream.
 */
export function parseAgentLine(line: string): AgentEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  const result = AgentEvent.safeParse(raw)
  return result.success ? result.data : null
}

/** Serialize a command for the agent's stdin (newline-terminated). */
export function encodeCommand(cmd: Command): string {
  return JSON.stringify(cmd) + '\n'
}

// ---------------------------------------------------------------------------
// .codehamr/config.yaml shape (mirrors the Go config package's strict schema:
// unknown top-level keys make the agent refuse to start, so the editor must
// only ever write these).
// ---------------------------------------------------------------------------

export const ConfigProfile = z.object({
  llm: z.string().min(1),
  url: z.string().min(1),
  key: z.string().default(''),
  // Omitted (not 0) for server-managed profiles like hamrpass — the agent
  // coerces a missing value; a bogus one degrades packing.
  context_size: z.number().int().positive().optional(),
})
export type ConfigProfile = z.infer<typeof ConfigProfile>

export const ConfigFile = z.object({
  active: z.string().min(1),
  models: z.record(z.string(), ConfigProfile),
  logging: z.boolean().optional(),
})
export type ConfigFile = z.infer<typeof ConfigFile>

