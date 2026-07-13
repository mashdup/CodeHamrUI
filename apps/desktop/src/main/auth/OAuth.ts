/**
 * OAuth subscription linking for Claude (Anthropic) and Codex/ChatGPT (OpenAI).
 *
 * Phase 1 only: acquire, store, and refresh an OAuth access token via the
 * Authorization Code + PKCE (S256) flow, so the user can "link" a subscription
 * instead of pasting an API key. This does NOT yet route agent turns through
 * the subscription — that's Phase 2 (see OAUTH_PLAN.md).
 *
 * Constants are the public installed-app client IDs / endpoints used by the
 * official Claude Code and Codex CLIs (see docs/oauth-notes.md), verified
 * against their source. No secrets live here.
 *
 * Tokens are user secrets and must never touch the project's .codehamr/ or any
 * log: they're persisted encrypted (Electron safeStorage) under userData, with
 * a 0o600 plaintext fallback only when safeStorage is unavailable.
 */
import { app, safeStorage, shell } from 'electron'
import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { AddressInfo } from 'node:net'
export type ProviderId = 'claude' | 'codex'

/** How a provider's token endpoint wants the exchange/refresh body encoded. */
type BodyEncoding = 'json' | 'form'

interface ProviderConfig {
  id: ProviderId
  label: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  scope: string
  bodyEncoding: BodyEncoding
}

/**
 * Verified public constants — see docs/oauth-notes.md. Anthropic's token
 * endpoint takes a JSON body; OpenAI's takes form-urlencoded, hence the
 * per-provider bodyEncoding.
 */
export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scope: 'org:create_api_key user:profile user:inference',
    bodyEncoding: 'json',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
    bodyEncoding: 'form',
  },
}

export interface StoredTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch ms when the access token expires, if the server told us. */
  expiresAt?: number
}

type TokenStore = Partial<Record<ProviderId, StoredTokens>>

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * OAuthManager owns token persistence and the login/refresh flows for both
 * providers. One instance is created in the main process.
 */
export class OAuthManager {
  private readonly storePath: string

  constructor() {
    this.storePath = join(app.getPath('userData'), 'oauth-tokens.enc')
  }

  // --- persistence --------------------------------------------------------

  private async load(): Promise<TokenStore> {
    if (!existsSync(this.storePath)) return {}
    try {
      const raw = await readFile(this.storePath)
      // First byte tags the format: 1 = safeStorage-encrypted, 0 = plaintext.
      const tag = raw[0]
      const body = raw.subarray(1)
      const json =
        tag === 1 && safeStorage.isEncryptionAvailable()
          ? safeStorage.decryptString(body)
          : body.toString('utf8')
      return JSON.parse(json) as TokenStore
    } catch {
      // Corrupt or unreadable store: treat as "nothing linked" rather than
      // wedging the app. The user can re-link.
      return {}
    }
  }

  private async save(store: TokenStore): Promise<void> {
    const json = JSON.stringify(store)
    if (safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(json)
      await writeFile(this.storePath, Buffer.concat([Buffer.from([1]), enc]), { mode: 0o600 })
    } else {
      // Fallback: plaintext under userData, locked to the user (0o600).
      await writeFile(
        this.storePath,
        Buffer.concat([Buffer.from([0]), Buffer.from(json, 'utf8')]),
        { mode: 0o600 },
      )
    }
    // writeFile's mode only applies on create; enforce it on an existing file.
    try {
      await chmod(this.storePath, 0o600)
    } catch {
      /* best effort (e.g. Windows) */
    }
  }

  // --- PKCE ----------------------------------------------------------------

  private pkce(): { verifier: string; challenge: string } {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    return { verifier, challenge }
  }

  // --- login flow ----------------------------------------------------------

  /**
   * Run the full browser OAuth flow for a provider: spin up a loopback
   * listener on an ephemeral 127.0.0.1 port, open the authorize URL, capture
   * the code (verifying state for CSRF), exchange it for tokens, and persist
   * them. Resolves once linked; rejects on mismatch, error, or ~2min timeout.
   */
  async start(providerId: ProviderId): Promise<void> {
    const provider = PROVIDERS[providerId]
    if (!provider) throw new Error(`unknown provider: ${providerId}`)

    const { verifier, challenge } = this.pkce()
    const state = base64url(randomBytes(16))

    const { code, redirectUri } = await this.awaitCallback(provider, challenge, state)
    const tokens = await this.exchange(provider, code, verifier, redirectUri)

    const store = await this.load()
    store[providerId] = tokens
    await this.save(store)
  }

  /**
   * Open a loopback server, launch the browser, and resolve with the auth
   * code once the provider redirects back. The server lives only for one
   * login and is always closed before resolving/rejecting.
   */
  private awaitCallback(
    provider: ProviderConfig,
    challenge: string,
    state: string,
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      let settled = false
      let redirectUri = ''
      const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        const params = url.searchParams
        const err = params.get('error')
        const code = params.get('code')
        const gotState = params.get('state')

        const finish = (ok: boolean, message: string): void => {
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            `<!doctype html><meta charset="utf-8"><title>${provider.label}</title>` +
              '<body style="font-family:system-ui,sans-serif;padding:3rem;text-align:center">' +
              `<h1>${message}</h1><p>You can close this tab and return to the app.</p></body>`,
          )
        }

        if (err) {
          finish(false, `Authorization failed: ${err}`)
          done(new Error(`authorization denied: ${err}`))
          return
        }
        if (!code || gotState !== state) {
          finish(false, 'Authorization failed.')
          done(new Error('missing code or state mismatch'))
          return
        }
        finish(true, `${provider.label} linked.`)
        done(null, code)
      })

      const timer = setTimeout(() => done(new Error('timed out waiting for authorization')), 120_000)

      const done = (error: Error | null, code?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        server.close()
        if (error) reject(error)
        else resolve({ code: code!, redirectUri })
      }

      server.on('error', (e) => done(e))
      // Ephemeral port on loopback only — never 0.0.0.0.
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo
        redirectUri = `http://127.0.0.1:${port}/callback`
        const authorize = new URL(provider.authorizeUrl)
        authorize.searchParams.set('response_type', 'code')
        authorize.searchParams.set('client_id', provider.clientId)
        authorize.searchParams.set('redirect_uri', redirectUri)
        authorize.searchParams.set('scope', provider.scope)
        authorize.searchParams.set('code_challenge', challenge)
        authorize.searchParams.set('code_challenge_method', 'S256')
        authorize.searchParams.set('state', state)
        void shell.openExternal(authorize.toString())
      })
    })
  }

  // --- token exchange / refresh -------------------------------------------

  private encodeBody(provider: ProviderConfig, fields: Record<string, string>): {
    body: string
    contentType: string
  } {
    if (provider.bodyEncoding === 'json') {
      return { body: JSON.stringify(fields), contentType: 'application/json' }
    }
    return {
      body: new URLSearchParams(fields).toString(),
      contentType: 'application/x-www-form-urlencoded',
    }
  }

  private parseTokens(json: Record<string, unknown>, prev?: StoredTokens): StoredTokens {
    const accessToken = String(json.access_token ?? '')
    if (!accessToken) throw new Error('token endpoint returned no access_token')
    const refreshToken =
      typeof json.refresh_token === 'string' ? json.refresh_token : prev?.refreshToken
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : undefined
    return {
      accessToken,
      refreshToken,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    }
  }

  private async exchange(
    provider: ProviderConfig,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<StoredTokens> {
    const { body, contentType } = this.encodeBody(provider, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: provider.clientId,
      code_verifier: verifier,
    })
    const res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    })
    if (!res.ok) {
      // Do not include the response body verbatim in case it echoes a token.
      throw new Error(`token exchange failed: HTTP ${res.status}`)
    }
    return this.parseTokens((await res.json()) as Record<string, unknown>)
  }

  private async refresh(provider: ProviderConfig, tokens: StoredTokens): Promise<StoredTokens> {
    if (!tokens.refreshToken) throw new Error('no refresh token')
    const { body, contentType } = this.encodeBody(provider, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: provider.clientId,
    })
    const res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    })
    if (!res.ok) throw new Error(`token refresh failed: HTTP ${res.status}`)
    return this.parseTokens((await res.json()) as Record<string, unknown>, tokens)
  }

  // --- public API used by IPC ---------------------------------------------

  /** Whether each provider currently has a stored (linkable) token. */
  async status(): Promise<Record<ProviderId, boolean>> {
    const store = await this.load()
    return {
      claude: !!store.claude?.accessToken,
      codex: !!store.codex?.accessToken,
    }
  }

  /** Delete a provider's stored tokens. */
  async logout(providerId: ProviderId): Promise<void> {
    const store = await this.load()
    delete store[providerId]
    await this.save(store)
  }

  /**
   * Return a currently-valid access token for a provider, refreshing it first
   * if it's within 60s of expiry. Returns null when the provider isn't linked.
   * (Consumed by Phase 2's send path; harmless to keep now.)
   */
  async getValidAccessToken(providerId: ProviderId): Promise<string | null> {
    const store = await this.load()
    const tokens = store[providerId]
    if (!tokens?.accessToken) return null
    const nearExpiry = tokens.expiresAt !== undefined && Date.now() + 60_000 >= tokens.expiresAt
    if (nearExpiry && tokens.refreshToken) {
      try {
        const next = await this.refresh(PROVIDERS[providerId], tokens)
        store[providerId] = next
        await this.save(store)
        return next.accessToken
      } catch {
        // Refresh failed: fall back to the (possibly stale) token rather than
        // hard-failing; the send path can surface a real auth error.
        return tokens.accessToken
      }
    }
    return tokens.accessToken
  }
}
