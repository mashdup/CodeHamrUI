# OAuth Implementation Notes

Confirmed OAuth 2.0 (Authorization Code + PKCE/S256) parameters for linking
Claude (Anthropic) and Codex/ChatGPT (OpenAI) subscriptions. These are the
public installed-app client IDs and endpoints used by the official Claude Code
and Codex CLIs — verified against their source, NOT guessed. Only public client
IDs are recorded here; there are no secrets.

## Anthropic (Claude)

- **Authorize URL**: `https://claude.ai/oauth/authorize`
- **Token URL**: `https://console.anthropic.com/v1/oauth/token`
- **Client ID**: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (public, used by Claude Code)
- **Scopes**: `org:create_api_key user:profile user:inference`
- **Redirect URI (loopback)**: `http://localhost:<port>/callback`
- **Redirect URI (paste-code fallback)**: `https://console.anthropic.com/oauth/code/callback`
- **PKCE**: required (S256)
- **Token exchange body**: JSON (`content-type: application/json`) with
  `grant_type`, `code`, `state`, `client_id`, `redirect_uri`, `code_verifier`.
- **Refresh**: JSON body `{ grant_type: 'refresh_token', refresh_token, client_id }`.
- **Token usage**: `Authorization: Bearer <access_token>` on the Messages API
  (`/v1/messages`), plus the `anthropic-beta` header for the subscription flow.
  (Backend transport is Phase 2 — not implemented here.)

## OpenAI (Codex / ChatGPT)

- **Issuer**: `https://auth.openai.com`
- **Authorize URL**: `https://auth.openai.com/oauth/authorize`
- **Token URL**: `https://auth.openai.com/oauth/token`
- **Client ID**: `app_EMoamEEZ73f0CkXaXp7hrann` (public, used by the Codex CLI)
- **Scopes**: `openid profile email offline_access api.connectors.read api.connectors.invoke`
- **Redirect URI (loopback)**: `http://localhost:<port>/callback`
  (the Codex CLI itself uses `http://localhost:1455/auth/callback`)
- **PKCE**: required (S256)
- **Token exchange body**: form-urlencoded
  (`content-type: application/x-www-form-urlencoded`) with `grant_type`, `code`,
  `redirect_uri`, `client_id`, `code_verifier`.
- **Refresh**: form-urlencoded `grant_type=refresh_token&refresh_token=...&client_id=...`.
- **Token usage**: Bearer against the ChatGPT backend (`chatgpt.com/backend-api`).
  (Backend transport is Phase 2 — not implemented here.)

## Implementation details

- **PKCE**: `code_verifier` = base64url(32 random bytes); `code_challenge` =
  base64url(SHA-256(verifier)); `code_challenge_method=S256`.
- **CSRF**: generate a random `state`, pass it on the authorize URL, and reject
  the callback if the returned `state` doesn't match.
- **Loopback server**: bind `127.0.0.1:<ephemeral port>` only for the duration
  of one login; capture `code` + `state` on `/callback`, show a close-me page,
  then shut down.
- **Storage**: encrypt tokens with Electron `safeStorage` under
  `app.getPath('userData')`; fall back to a `0o600` plaintext JSON file when
  `safeStorage` is unavailable. Never write tokens to `.codehamr/` or logs.

## Divergence between the two providers (matters for the code)

- Anthropic token endpoint takes a **JSON** body; OpenAI takes **form-urlencoded**.
- The two have different client IDs, scopes, and token hosts.

Because of the JSON-vs-form difference and per-provider client IDs/scopes, the
token exchange and refresh are parameterised per provider in `OAuth.ts`.
