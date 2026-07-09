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

export const Command = z.discriminatedUnion('type', [
  PromptCommand,
  ApproveCommand,
  CancelCommand,
  SetModelCommand,
  GetModelsCommand,
  ClearCommand,
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
})

export const ClearedEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('cleared'),
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

export const ToolCallEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('tool_call'),
  callId: z.string(),
  name: z.enum(['bash', 'read_file', 'write_file', 'edit_file']),
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
  truncated: z.boolean().optional(),
})

export const FileDiffEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('file_diff'),
  callId: z.string(),
  path: z.string(),
  unifiedDiff: z.string(),
})

export const TurnDoneEvent = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('turn_done'),
  usage: z
    .object({
      promptTokens: z.number().int().nonnegative(),
      completionTokens: z.number().int().nonnegative(),
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
  AssistantDeltaEvent,
  ReasoningDeltaEvent,
  AssistantDoneEvent,
  ToolCallEvent,
  ToolResultEvent,
  FileDiffEvent,
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
