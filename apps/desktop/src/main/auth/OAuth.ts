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
import { app, safeStorage, shell, BrowserWindow } from 'electron'
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
  /**
   * How the auth code comes back:
   *  - 'loopback': ephemeral 127.0.0.1 listener catches the redirect (OpenAI).
   *  - 'paste': the provider only allows a fixed hosted redirect that DISPLAYS
   *    the code for the user to copy back (Anthropic — its public client has no
   *    loopback redirect registered, so a loopback authorize submit 400s
   *    "Invalid request format"). pasteRedirectUri is the registered redirect.
   */
  redirectMode: 'loopback' | 'paste'
  /** Required when redirectMode === 'paste': the provider's fixed redirect. */
  pasteRedirectUri?: string
  /**
   * Extra query params appended to the authorize URL. Anthropic's flow
   * requires `code=true`; without it the consent page renders but its submit
   * POSTs 400 "Invalid request format".
   */
  authorizeExtra?: Record<string, string>
  /**
   * Whether the token exchange (and refresh) must echo the `state` value.
   * Anthropic's token endpoint requires it; OpenAI's does not.
   */
  sendStateInExchange?: boolean
  /** Extra headers on the token endpoint (Anthropic wants User-Agent: anthropic). */
  tokenHeaders?: Record<string, string>
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
    redirectMode: 'paste',
    pasteRedirectUri: 'https://console.anthropic.com/oauth/code/callback',
    authorizeExtra: { code: 'true' },
    sendStateInExchange: true,
    tokenHeaders: { 'User-Agent': 'anthropic' },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
    bodyEncoding: 'form',
    redirectMode: 'loopback',
  },
}

/**
 * Phase 2 (Option A) — how a linked subscription maps onto an OpenAI-shaped
 * config.yaml profile that routes through the codehamr.com proxy.
 *
 * The proxy translates chat-completions ⇄ the provider's native API server-
 * side, so the Go client stays OpenAI-only (the "one code path" rule in
 * llm.go). Each provider gets its own proxy sub-path so the server can route by
 * URL, and the profile's `key` is a `${ENV}` reference — the live OAuth access
 * token is injected into the agent's environment at spawn time (see
 * AgentSession / index.ts agent:start), so the token never lands on disk. The
 * matching env var name is the single source of truth here.
 *
 * Server-side proxy routes are a dependency on the codehamr.com backend, out of
 * scope for this repo.
 */
export interface SubscriptionProfile {
  /** config.yaml profile key created/updated on link. */
  profileName: string
  /** Env var that carries the live access token; referenced as `${envVar}`. */
  envVar: string
  /** Proxy base URL; the Go client appends `/v1/chat/completions`. */
  url: string
  /** Default model id for the profile (user-editable afterward). */
  model: string
}

export const SUBSCRIPTION: Record<ProviderId, SubscriptionProfile> = {
  claude: {
    profileName: 'claude',
    envVar: 'CODEHAMR_OAUTH_CLAUDE',
    url: 'https://codehamr.com/oauth/claude',
    model: 'claude-sonnet-4-5',
  },
  codex: {
    profileName: 'codex',
    envVar: 'CODEHAMR_OAUTH_CODEX',
    url: 'https://codehamr.com/oauth/codex',
    model: 'gpt-5-codex',
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

  /**
   * Optional accessor for the app's main window, used as the parent of the
   * in-app auth BrowserWindow so it's modal-ish and returns focus on close.
   * Injected from index.ts (the manager is constructed before the window
   * exists, so this is a lazy getter, not a constructor arg).
   */
  getParentWindow?: () => BrowserWindow | null

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
   * In-flight paste-mode login state, keyed by provider. The authorize URL is
   * opened in the browser; the provider's hosted redirect DISPLAYS the code for
   * the user to copy, and finishPaste() completes the exchange. Verifier/state
   * are held here (never sent to the renderer) between start and finish.
   */
  private pending: Partial<
    Record<ProviderId, { verifier: string; state: string; redirectUri: string }>
  > = {}

  /**
   * Begin a login. Loopback providers (OpenAI) run the whole flow here and
   * resolve when linked. Paste providers (Anthropic — no loopback redirect is
   * registered for its public client) first try an in-app auth window that
   * auto-captures the code from the callback navigation; if that isn't possible
   * (no parent window, or the provider blocks embedded login) they fall back to
   * opening the system browser and resolving with `{ needsCode: true }`, after
   * which the caller collects the displayed code and calls finishPaste().
   */
  async start(providerId: ProviderId): Promise<{ needsCode: boolean; fellBack?: boolean; reason?: string }> {
    const provider = PROVIDERS[providerId]
    if (!provider) throw new Error(`unknown provider: ${providerId}`)

    const { verifier, challenge } = this.pkce()
    // Anthropic's Claude Code flow requires state === code_verifier (not an
    // independent random value); a mismatched state 400s the authorize submit
    // as "Invalid request format". OpenAI is indifferent, so use it there too.
    const state = verifier

    if (provider.redirectMode === 'paste') {
      const redirectUri = provider.pasteRedirectUri!
      const authorizeUrl = this.authorizeUrl(provider, challenge, state, redirectUri)
      // Preferred: in-app window that auto-returns the code. Only bail to paste
      // when there's no window to parent it (headless/tests). A user-closed or
      // provider-blocked window rejects, which surfaces to the UI.
      const parent = this.getParentWindow?.() ?? null
      if (parent) {
        let captured: string
        try {
          captured = await this.awaitInAppCode(provider, authorizeUrl, redirectUri, parent)
        } catch (e) {
          // The in-app window itself failed (user closed it, provider blocked
          // embedded login, timeout). Fall back to the system browser + manual
          // paste so linking is still possible.
          console.error(`[oauth ${providerId}] in-app window failed:`, (e as Error).message)
          this.pending[providerId] = { verifier, state, redirectUri }
          void shell.openExternal(authorizeUrl)
          return { needsCode: true, fellBack: true, reason: (e as Error).message }
        }
        // We captured a code. The exchange is the same regardless of how the
        // code arrived, so a failure here is NOT a reason to fall back to paste
        // (it'd fail identically) — surface it so the real cause shows.
        const [code, stateFromCode] = captured.split('#')
        const tokens = await this.exchange(
          provider,
          code,
          verifier,
          redirectUri,
          stateFromCode || state,
        )
        await this.persist(providerId, tokens)
        return { needsCode: false }
      }
      // No parent window (headless/tests): straight to paste.
      console.error(`[oauth ${providerId}] no parent window; using paste flow`)
      this.pending[providerId] = { verifier, state, redirectUri }
      void shell.openExternal(authorizeUrl)
      return { needsCode: true }
    }

    const { code, redirectUri } = await this.awaitCallback(provider, challenge, state)
    const tokens = await this.exchange(provider, code, verifier, redirectUri, state)
    await this.persist(providerId, tokens)
    return { needsCode: false }
  }

  /**
   * Open an in-app BrowserWindow at the authorize URL and resolve with the auth
   * code once the provider navigates to its fixed callback URL. The code +
   * state ride in the callback query string, so we intercept the navigation,
   * read them, and close the window — no paste, focus returns to the app.
   *
   * A dedicated, partitioned session (no persistence) keeps this login isolated
   * from the app's cookies. Rejects if the user closes the window or on a ~2min
   * timeout. NEVER logs the code.
   */
  private awaitInAppCode(
    provider: ProviderConfig,
    authorizeUrl: string,
    redirectUri: string,
    parent: BrowserWindow,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const authWin = new BrowserWindow({
        parent,
        // Not modal: modal trapped the window with no way to cancel. Parented +
        // closable so the user can always back out; we also auto-close on
        // success.
        modal: false,
        width: 520,
        height: 720,
        title: `Sign in — ${provider.label}`,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          partition: `oauth-${provider.id}-${Date.now()}`, // isolated, ephemeral
        },
      })

      const timer = setTimeout(
        () => done(new Error('timed out waiting for authorization')),
        300_000, // 5 min: a full sign-in (email, password, 2FA) can be slow
      )
      let poll: ReturnType<typeof setInterval> | null = null

      const done = (error: Error | null, code?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (poll) clearInterval(poll)
        // Remove the close handler first so programmatic close isn't read as
        // a user cancel, then destroy the window.
        authWin.removeListener('closed', onUserClose)
        if (!authWin.isDestroyed()) authWin.destroy()
        if (error) reject(error)
        else resolve(code!)
      }

      // The callback can arrive two ways: (1) a real navigation to the redirect
      // URL with ?code=&state= in the query, or (2) claude.ai's SPA rendering
      // the code#state string into an on-page field WITHOUT navigating (what we
      // actually observed). Cover both: check navigations AND poll the DOM.
      const inspectUrl = (targetUrl: string): void => {
        if (!targetUrl.startsWith(redirectUri)) return
        try {
          const u = new URL(targetUrl)
          const err = u.searchParams.get('error')
          if (err) return done(new Error(`authorization denied: ${err}`))
          const code = u.searchParams.get('code')
          const state = u.searchParams.get('state')
          if (code) done(null, state ? `${code}#${state}` : code)
        } catch {
          /* not the URL we're waiting for */
        }
      }

      // Extract a `code#state` token from the page: URL query first, then any
      // input/textarea whose value looks like one. Runs in the page's own
      // origin, so cross-origin is fine. Returns null until the code appears.
      const scrape = `(() => {
        try {
          const p = new URLSearchParams(location.search);
          const c = p.get('code');
          if (c) return p.get('state') ? c + '#' + p.get('state') : c;
          const re = /^[A-Za-z0-9_-]{16,}#[A-Za-z0-9_-]{8,}$/;
          for (const el of document.querySelectorAll('input,textarea')) {
            const v = (el.value || '').trim();
            if (re.test(v)) return v;
          }
        } catch (e) {}
        return null;
      })()`

      const tryScrape = (): void => {
        if (settled || authWin.isDestroyed()) return
        authWin.webContents
          .executeJavaScript(scrape, true)
          .then((val: unknown) => {
            if (typeof val === 'string' && val) done(null, val)
          })
          .catch(() => {
            /* page navigating / not ready */
          })
      }

      const onUserClose = (): void => done(new Error('sign-in window was closed'))

      authWin.webContents.on('will-redirect', (_e, targetUrl) => inspectUrl(targetUrl))
      authWin.webContents.on('did-navigate', (_e, targetUrl) => {
        inspectUrl(targetUrl)
        tryScrape()
      })
      authWin.webContents.on('did-navigate-in-page', (_e, targetUrl) => {
        inspectUrl(targetUrl)
        tryScrape()
      })
      authWin.webContents.on('did-finish-load', () => tryScrape())
      authWin.on('closed', onUserClose)
      // Belt-and-braces: the code field can appear a moment after load with no
      // navigation event, so poll too.
      poll = setInterval(tryScrape, 700)

      void authWin.loadURL(authorizeUrl)
    })
  }

  /**
   * Complete a paste-mode login with the code the user copied from the
   * provider's redirect page. Anthropic shows `code#state`; we accept either
   * that combined form or a bare code (falling back to the state we generated).
   * Throws if there's no pending login or the exchange fails.
   */
  async finishPaste(providerId: ProviderId, pasted: string): Promise<void> {
    const provider = PROVIDERS[providerId]
    const pend = this.pending[providerId]
    if (!provider || !pend) throw new Error('no pending authorization; click Link again')
    const trimmed = pasted.trim()
    if (!trimmed) throw new Error('paste the code from the browser')
    // Anthropic's callback page yields `code#state`; split on '#'.
    const [code, stateFromCode] = trimmed.split('#')
    const state = stateFromCode || pend.state
    if (!code) throw new Error('invalid code')
    const tokens = await this.exchange(provider, code, pend.verifier, pend.redirectUri, state)
    // Only clear the pending login once the exchange actually succeeded, so a
    // failed Submit surfaces the real error and can be retried without
    // redoing the browser step (deleting on failure masked it as "no pending").
    await this.persist(providerId, tokens)
    delete this.pending[providerId]
  }

  /** Build the authorize URL with PKCE + per-provider extras. */
  private authorizeUrl(
    provider: ProviderConfig,
    challenge: string,
    state: string,
    redirectUri: string,
  ): string {
    const authorize = new URL(provider.authorizeUrl)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', provider.clientId)
    authorize.searchParams.set('redirect_uri', redirectUri)
    authorize.searchParams.set('scope', provider.scope)
    authorize.searchParams.set('code_challenge', challenge)
    authorize.searchParams.set('code_challenge_method', 'S256')
    authorize.searchParams.set('state', state)
    for (const [k, v] of Object.entries(provider.authorizeExtra ?? {})) {
      authorize.searchParams.set(k, v)
    }
    return authorize.toString()
  }

  private async persist(providerId: ProviderId, tokens: StoredTokens): Promise<void> {
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
        void shell.openExternal(this.authorizeUrl(provider, challenge, state, redirectUri))
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
    state: string,
  ): Promise<StoredTokens> {
    const { body, contentType } = this.encodeBody(provider, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: provider.clientId,
      code_verifier: verifier,
      ...(provider.sendStateInExchange ? { state } : {}),
    })
    const res = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType, ...(provider.tokenHeaders ?? {}) },
      body,
    })
    if (!res.ok) {
      // An OAuth error body is `{error, error_description}` — no token in it, so
      // it's safe (and necessary) to surface for diagnosis. Cap the length and
      // strip newlines so a stray HTML error page can't flood the UI.
      const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)
      throw new Error(`token exchange failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`)
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
      headers: { 'Content-Type': contentType, ...(provider.tokenHeaders ?? {}) },
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

  /**
   * Build the environment overrides for a freshly-spawned agent: for every
   * linked provider, `{ [envVar]: <live access token> }` (refreshing any token
   * within 60s of expiry first). Consumed by AgentSession so the profile's
   * `key: ${CODEHAMR_OAUTH_*}` reference resolves to the current token at
   * dial-out — the token stays in process memory, never on disk. Providers
   * that aren't linked are simply absent.
   */
  async subscriptionEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {}
    for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
      const token = await this.getValidAccessToken(id)
      if (token) env[SUBSCRIPTION[id].envVar] = token
    }
    return env
  }
}
