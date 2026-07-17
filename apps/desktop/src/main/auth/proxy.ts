/**
 * Local OAuth translating proxy.
 *
 * The Go agent (`internal/llm/llm.go`) speaks ONE wire format: OpenAI
 * chat-completions (`POST {base}/chat/completions`, SSE) with an
 * `Authorization: Bearer <token>` header. A Claude/Codex *subscription* OAuth
 * token does NOT authenticate any chat-completions endpoint — it only works on
 * the provider's NATIVE API (Anthropic `/v1/messages`, `anthropic-beta:
 * oauth-2025-04-20`). We don't own a server to bridge the two (codehamr.com is
 * not ours), so we run the bridge IN-PROCESS: a loopback HTTP server the agent
 * dials as an ordinary OpenAI endpoint, which translates each request to the
 * provider's native API using the live OAuth token and streams standard OpenAI
 * SSE back.
 *
 * Routing: the agent's base URL is `http://127.0.0.1:<port>/oauth/<provider>`.
 * Because that base carries a path, the Go client appends `/chat/completions`
 * and `/models` (see chatCompletionsURL / models:scan), so we serve
 * `/oauth/<provider>/chat/completions` and `/oauth/<provider>/models`.
 *
 * The token never touches disk: the agent's profile key is
 * `${CODEHAMR_OAUTH_<PROVIDER>}` which the Go client resolves from the injected
 * env and sends as the Bearer; this proxy reads it off the incoming
 * Authorization header (and, as a fallback, re-fetches a fresh one from the
 * OAuthManager). Bound to 127.0.0.1 only.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import type { ProviderId } from './OAuth'

/** Anthropic REQUIRES this exact first system block for OAuth (Claude Code identity). */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
const ANTHROPIC_VERSION = '2023-06-01'
const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'
const ANTHROPIC_API = process.env.CODEHAMR_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages'

/** Context windows advertised back to the agent via X-Context-Window. */
const CONTEXT_WINDOW: Record<ProviderId, number> = {
  claude: 200000,
  codex: 200000,
}

/** OpenAI chat-completions request shape (only the fields we translate). */
interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  stream?: boolean
  max_tokens?: number
  reasoning_effort?: string
}
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: OpenAIToolCall[]
}
interface OpenAIContentPart {
  type: string
  text?: string
  image_url?: { url: string }
}
interface OpenAIToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
}
interface OpenAITool {
  type: string
  function: { name: string; description?: string; parameters?: unknown }
}

// --- OpenAI request -> Anthropic Messages request ------------------------

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}
type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }

/** System text from OpenAI system messages (Anthropic takes system separately). */
function collectSystem(messages: OpenAIMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : partsToText(m.content)))
    .filter(Boolean)
    .join('\n\n')
}

function partsToText(content: string | OpenAIContentPart[] | null): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
}

/** Parse a data: URL into Anthropic's base64 image source. */
function dataUrlToImage(url: string): AnthropicBlock | null {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url)
  if (!m) return null
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }
}

/** Convert the OpenAI message list into Anthropic's messages array. */
function toAnthropicMessages(messages: OpenAIMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  const push = (role: 'user' | 'assistant', block: AnthropicBlock): void => {
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(block)
    else out.push({ role, content: [block] })
  }

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      // OpenAI tool result -> Anthropic tool_result block, which must live in a
      // USER message keyed by the originating tool_use id.
      push('user', {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: partsToText(m.content),
      })
      continue
    }
    if (m.role === 'assistant') {
      const text = partsToText(m.content)
      if (text) push('assistant', { type: 'text', text })
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {}
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          input = {}
        }
        push('assistant', { type: 'tool_use', id: tc.id, name: tc.function.name, input })
      }
      continue
    }
    // user
    if (typeof m.content === 'string') {
      push('user', { type: 'text', text: m.content })
    } else if (m.content) {
      for (const part of m.content) {
        if (part.type === 'text') push('user', { type: 'text', text: part.text ?? '' })
        else if (part.type === 'image_url' && part.image_url) {
          const img = dataUrlToImage(part.image_url.url)
          if (img) push('user', img)
        }
      }
    }
  }
  return out
}

/** OpenAI tools -> Anthropic tools. */
function toAnthropicTools(tools: OpenAITool[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }))
}

/** Build the Anthropic /v1/messages request body from the OpenAI request. */
function buildAnthropicBody(req: OpenAIChatRequest): Record<string, unknown> {
  const userSystem = collectSystem(req.messages)
  // The Claude Code identity MUST be the first system block for OAuth; the
  // agent's own system prompt follows as a second block.
  const system: { type: 'text'; text: string }[] = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }]
  if (userSystem) system.push({ type: 'text', text: userSystem })

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.max_tokens && req.max_tokens > 0 ? req.max_tokens : 8192,
    system,
    messages: toAnthropicMessages(req.messages),
    stream: true,
  }
  const tools = toAnthropicTools(req.tools)
  if (tools) body.tools = tools
  return body
}

// --- Anthropic SSE -> OpenAI SSE -----------------------------------------

/**
 * Translate Anthropic's Messages streaming events into OpenAI chat-completions
 * SSE chunks, writing each `data: {...}\n\n` frame to `write`. Anthropic streams
 * named events (message_start, content_block_start/delta/stop, message_delta,
 * message_stop); we map:
 *   - text_delta            -> choices[0].delta.content
 *   - thinking_delta        -> choices[0].delta.reasoning
 *   - tool_use start        -> delta.tool_calls[n] with id+name (empty args)
 *   - input_json_delta      -> delta.tool_calls[n].function.arguments (fragment)
 *   - message_delta usage   -> final usage chunk
 * The Go reader keys tool-call fragments on `index`, so each content block's
 * index becomes the tool_calls[].index. Returns a stateful line handler.
 */
function makeAnthropicToOpenAI(model: string, write: (frame: string) => void): (line: string) => void {
  const id = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  // Anthropic content-block index -> OpenAI tool_calls index (only tool_use
  // blocks get a tool slot; text/thinking blocks don't).
  let toolSlot = -1
  const toolIndexForBlock = new Map<number, number>()
  let promptTokens = 0
  let completionTokens = 0

  const chunk = (delta: Record<string, unknown>): void => {
    write(
      'data: ' +
        JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        }) +
        '\n\n',
    )
  }

  let currentEvent = ''
  return (line: string): void => {
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
      return
    }
    if (!line.startsWith('data:')) return
    const raw = line.slice(5).trim()
    if (!raw) return
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(raw)
    } catch {
      return
    }
    const type = (ev.type as string) || currentEvent

    if (type === 'message_start') {
      const usage = (ev.message as { usage?: { input_tokens?: number } })?.usage
      if (usage?.input_tokens) promptTokens = usage.input_tokens
      return
    }
    if (type === 'content_block_start') {
      const index = ev.index as number
      const block = ev.content_block as { type: string; id?: string; name?: string }
      if (block?.type === 'tool_use') {
        toolSlot += 1
        toolIndexForBlock.set(index, toolSlot)
        chunk({
          tool_calls: [
            {
              index: toolSlot,
              id: block.id ?? '',
              type: 'function',
              function: { name: block.name ?? '', arguments: '' },
            },
          ],
        })
      }
      return
    }
    if (type === 'content_block_delta') {
      const index = ev.index as number
      const d = ev.delta as { type: string; text?: string; thinking?: string; partial_json?: string }
      if (d.type === 'text_delta' && d.text) chunk({ content: d.text })
      else if (d.type === 'thinking_delta' && d.thinking) chunk({ reasoning: d.thinking })
      else if (d.type === 'input_json_delta' && d.partial_json !== undefined) {
        const slot = toolIndexForBlock.get(index)
        if (slot !== undefined) {
          chunk({
            tool_calls: [{ index: slot, function: { arguments: d.partial_json } }],
          })
        }
      }
      return
    }
    if (type === 'message_delta') {
      const usage = (ev.usage as { output_tokens?: number }) || undefined
      if (usage?.output_tokens) completionTokens = usage.output_tokens
      return
    }
    if (type === 'message_stop') {
      // Final usage chunk, then [DONE].
      write(
        'data: ' +
          JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
          }) +
          '\n\n',
      )
      write('data: [DONE]\n\n')
      return
    }
    if (type === 'error') {
      const message = (ev.error as { message?: string })?.message ?? 'anthropic stream error'
      write('data: ' + JSON.stringify({ error: { message } }) + '\n\n')
    }
  }
}

// --- the loopback server -------------------------------------------------

/** Model ids advertised on /models per provider. */
const MODELS: Record<ProviderId, string[]> = {
  claude: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
  codex: ['gpt-5-codex'],
}

/** Read the whole request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Pull the bearer token off the incoming Authorization header. */
function bearerFrom(req: IncomingMessage): string {
  const h = req.headers['authorization']
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7)
  return ''
}

/**
 * How the proxy gets a live access token: the agent sends one as Bearer
 * (resolved from the injected env), but that's only refreshed on agent restart.
 * We prefer a freshly-refreshed token from the manager and fall back to the
 * header, so a mid-session expiry still works without restarting the agent.
 */
export type TokenProvider = (provider: ProviderId) => Promise<string | null>

export class OAuthProxy {
  private server: Server | null = null
  private _port = 0
  constructor(private readonly getToken: TokenProvider) {}

  get port(): number {
    return this._port
  }

  /** Base URL an agent profile should use for `provider`. */
  baseUrl(provider: ProviderId): string {
    return `http://127.0.0.1:${this._port}/oauth/${provider}`
  }

  async start(): Promise<number> {
    if (this.server) return this._port
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    this._port = (this.server!.address() as AddressInfo).port
    return this._port
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this._port = 0
  }

  private parseRoute(url: string): { provider: ProviderId; tail: string } | null {
    const m = /^\/oauth\/(claude|codex)\/(.*)$/.exec(url.split('?')[0])
    if (!m) return null
    return { provider: m[1] as ProviderId, tail: m[2] }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = this.parseRoute(req.url ?? '')
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    const { provider, tail } = route
    if (provider === 'codex') {
      res.writeHead(501, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'codex subscription proxy not implemented yet' } }))
      return
    }
    try {
      if (tail === 'models') return this.serveModels(provider, res)
      if (tail === 'chat/completions') return await this.serveChat(provider, req, res)
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: (e as Error).message } }))
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `unknown route: ${tail}` } }))
  }

  private serveModels(provider: ProviderId, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Context-Window': String(CONTEXT_WINDOW[provider]),
    })
    res.end(
      JSON.stringify({
        object: 'list',
        data: MODELS[provider].map((id) => ({ id, object: 'model', owned_by: provider })),
      }),
    )
  }

  private async serveChat(
    provider: ProviderId,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // Live token: prefer a freshly-refreshed one, fall back to the agent's Bearer.
    const token = (await this.getToken(provider)) || bearerFrom(req)
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `${provider} is not linked` } }))
      return
    }
    const bodyText = await readBody(req)
    let openaiReq: OpenAIChatRequest
    try {
      openaiReq = JSON.parse(bodyText) as OpenAIChatRequest
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
      return
    }

    const upstream = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_OAUTH_BETA,
      },
      body: JSON.stringify(buildAnthropicBody(openaiReq)),
    })

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '')
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          error: { message: `anthropic ${upstream.status}: ${detail.slice(0, 500)}` },
        }),
      )
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Context-Window': String(CONTEXT_WINDOW[provider]),
    })

    const onLine = makeAnthropicToOpenAI(openaiReq.model, (frame) => res.write(frame))
    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (line) onLine(line)
        }
      }
      if (buf.trim()) onLine(buf.trim())
    } catch (e) {
      res.write('data: ' + JSON.stringify({ error: { message: (e as Error).message } }) + '\n\n')
    }
    res.end()
  }
}
