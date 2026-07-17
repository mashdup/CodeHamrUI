# OAuth Implementation Notes

Confirmed OAuth 2.0 (Authorization Code + PKCE/S256) parameters for linking
Claude (Anthropic) and Codex/ChatGPT (OpenAI) subscriptions. These are the
public installed-app client IDs and endpoints used by the official Claude Code
and Codex CLIs — verified against their source, NOT guessed. Only public client
IDs are recorded here; there are no secrets.

## Anthropic (Claude)

- **Authorize URL**: `https://claude.ai/oauth/authorize`
- **Token URL**: `https://platform.claude.com/v1/oauth/token` (Anthropic
  MIGRATED OAuth off `console.anthropic.com` — the old
  `console.anthropic.com/v1/oauth/token` now returns **404**, which silently
  broke linking. Confirmed live: `platform.claude.com/v1/oauth/token` returns a
  proper `invalid_grant` OAuth error for a bad code.)
- **Client ID**: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (public, used by Claude Code)
- **Scopes**: `org:create_api_key user:profile user:inference`
- **Redirect URI**: Anthropic's public client (`9d1c250a-…`) does NOT have a
  loopback redirect registered — a loopback `redirect_uri` makes the authorize
  submit 400 "Invalid request format". Use the fixed hosted redirect
  `https://platform.claude.com/oauth/code/callback`, which DISPLAYS the code
  as `code#state` for the user to copy back into the app (manual paste flow).
  (Also migrated off `console.anthropic.com`.)
- **PKCE**: required (S256)
- **Token exchange body**: JSON (`content-type: application/json`) with
  `grant_type`, `code`, `state`, `client_id`, `redirect_uri`, `code_verifier`.
  The `state` field is REQUIRED by Anthropic's token endpoint (OpenAI's is not).
- **Authorize URL**: must include `code=true` in addition to the standard PKCE
  params. Without it the consent page renders but its submit POSTs
  `400 Invalid request format` (the authorize endpoint at
  `claude.ai/v1/oauth/<id>/authorize`).
- **Refresh**: JSON body `{ grant_type: 'refresh_token', refresh_token, client_id }`.
- **Token endpoint User-Agent**: send `claude-cli/<ver> (external, sdk-cli)`,
  NOT `User-Agent: anthropic`. The endpoint **429 rate-limits** the literal
  `anthropic` UA but accepts the Claude CLI's own UA string (confirmed live).
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
- **CSRF / state**: Anthropic's Claude Code flow requires `state` to EQUAL the
  `code_verifier` (a base64url-without-padding of 32 random bytes), NOT an
  independent random value. A mismatched/independent `state` 400s the authorize
  submit as "Invalid request format". The token exchange echoes that same state.
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
