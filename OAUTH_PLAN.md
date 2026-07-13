# Handoff Plan: OAuth subscription linking for CodeHamr

Audience: an implementing LLM/dev working in this repo. Read `AGENTS.md` and
`PLAN.md` first for house rules. Toolchains live in `/opt/homebrew/bin` — prefix
shell commands with `export PATH="/opt/homebrew/bin:$PATH"`.

---

## STATUS (paused) — updated end of Phase 1

**Phase 0 — DONE.** Real OAuth constants for both providers confirmed against
the official Claude Code / Codex CLI sources (not guessed) and written to
`docs/oauth-notes.md`.

**Phase 1 (token acquisition) — DONE, and currently hidden in the UI.**
- `apps/desktop/src/main/auth/OAuth.ts` — `OAuthManager`: PKCE (S256), random
  `state` verified on callback (CSRF), ephemeral `127.0.0.1` loopback listener,
  `shell.openExternal`, per-provider token exchange (Anthropic = JSON body,
  OpenAI = form-urlencoded), lazy refresh (60s skew), and token storage
  encrypted via Electron `safeStorage` under `userData` with a `0o600` plaintext
  fallback. Provider IDs are `claude` / `codex`. Never writes to `.codehamr/`;
  never logs token values.
- `apps/desktop/src/main/index.ts` — `auth:start` / `auth:status` /
  `auth:logout` IPC handlers + a `ProviderId` guard; imports `shell` via the
  OAuth module.
- `apps/desktop/src/preload/index.ts` — `authStart` / `authStatus` /
  `authLogout` bridge (typed through `CodeHamrApi`, so `index.d.ts` needs no
  change).
- `apps/desktop/src/renderer/src/Settings.tsx` — `AccountsSection` (Claude/Codex
  rows, Link/Unlink, Linked/Not-linked status). **Gated behind
  `const SHOW_ACCOUNTS = false`** so the tab is hidden while paused — the
  component and all main/preload wiring stay intact; flip that flag to `true` to
  bring the tab back.

**Why the UI is hidden:** Phase 2 (routing turns through a linked subscription)
is unstarted, so a visible "Link" button would acquire a token that does nothing
useful yet. Hidden until backend transport lands.

**Verified:** `tsc --noEmit` (main/preload + renderer) clean; `npm run build`
(electron-vite) clean; the provider-independent OAuth logic (PKCE S256 shape,
JSON-vs-form encoding, loopback callback capture, state-mismatch rejection)
exercised under Node and passing.
**Not verified (needs a real desktop run):** the full Electron flow —
`app.whenReady()` doesn't resolve headless here, so the browser round-trip,
on-disk `safeStorage` persistence across restart, and live-provider refresh
still need a manual `npm run dev` pass once resumed.

**Phase 2 — NOT STARTED. Blocked on a human decision:** route subscription
traffic through the `codehamr.com` proxy (Option A, preferred) or add
per-provider Go adapters (Option B). See "Phase 2" below. **To resume:** answer
the routing question, set `SHOW_ACCOUNTS = true`, then do the manual
link/restart/refresh verification for both providers before wiring transport.

---

## Goal

Let a user link **both** a **Claude** (Anthropic) and a **Codex/ChatGPT**
(OpenAI) subscription via OAuth from the desktop app, instead of pasting a raw
API key into `.codehamr/config.yaml`. After linking, the agent should be able to
run turns backed by either subscription. Both providers are first-class and in
scope for the first cut — neither is deferred.

Precedent: this is the same subscription-OAuth model Xcode's coding assistant
uses to link Claude/ChatGPT accounts, so the approach is sanctioned by the
providers for agentic coding clients — treat the flows as supported, not a
workaround. (Still follow each provider's documented OAuth parameters exactly;
"sanctioned" is not "guess the endpoints.")

## The one hard constraint — read this before writing any code

The Go agent's LLM client (`codehamr/internal/llm/llm.go`) speaks **exactly one
wire format**: OpenAI chat-completions (`POST $BaseURL/v1/chat/completions`, SSE)
with an optional `Authorization: Bearer <token>` header (`Client.Token`, set from
`Profile.ResolvedKey()`). This is a deliberate design rule — see the package doc
comment in `llm.go` and `AGENTS.md` ("LLM endpoints must be OpenAI-compatible").

OAuth subscriptions do **not** fit that format cleanly:

- **Claude subscription** → Anthropic Messages API (`/v1/messages`), different
  request/response schema, needs `anthropic-beta` header + short-lived OAuth
  access token (PKCE flow). NOT chat-completions.
- **Codex/ChatGPT subscription** → OpenAI Responses API against
  `chatgpt.com/backend-api`, again not chat-completions, and gated on a
  ChatGPT-account OAuth token.

Consequence: OAuth work splits into **two independent problems**, and this plan
keeps them separate so neither blocks the other:

1. **Token acquisition** (Electron/main + UI): run the OAuth flow, get a token,
   store it, refresh it. This is self-contained and shippable on its own.
2. **Backend transport** (Go agent): actually send turns to Anthropic/OpenAI
   subscription endpoints. This requires either a translating proxy OR new Go
   provider adapters — it is the larger, riskier half.

Decision required from the human before phase 2: **do we route subscription
traffic through the existing `codehamr.com` hamrpass proxy (server does the
format translation, client stays OpenAI-only — strongly preferred, matches the
existing architecture in `internal/cloud`), or do we add per-provider adapters
inside the Go client (breaks the "one code path" rule)?** Phase 1 is safe to
build regardless of that answer.

---

## Phase 0 — Spike / confirm the flows (no product code) — ✅ DONE

Confirm the exact OAuth parameters before building UI around them; these change
and must not be guessed.

- Anthropic OAuth: authorize URL, token URL, client_id, scopes, PKCE
  (S256), redirect URI style (loopback `http://localhost:<port>/callback` vs a
  `claude://`-style custom scheme + paste-code fallback), token lifetime +
  refresh grant. Confirm what header combo an OAuth access token needs on
  `/v1/messages`.
- OpenAI/ChatGPT OAuth: same set for the `auth.openai.com` PKCE flow and the
  `chatgpt.com/backend-api` endpoint.

Deliverable: a short `docs/oauth-notes.md` with the concrete constants for
**both** providers (both are required — neither is deferred). Do NOT hardcode
secrets; public client_ids for installed apps are fine, anything confidential is
not. Where Xcode-style clients are known to use a specific public client_id /
redirect for these installed-app flows, prefer matching that documented shape.

---

## Phase 1 — Token acquisition (Electron main + preload + UI) — ✅ DONE (UI hidden behind `SHOW_ACCOUNTS`)

Self-contained; ends with a valid token stored and visible as "Linked" in
Settings. Does not yet change how turns are sent.

### 1a. Main process: OAuth orchestrator
File: `apps/desktop/src/main/index.ts` (all IPC handlers live here; follow the
existing `ipcMain.handle('config:read', ...)` etc. patterns near line 837).

Add a new module `apps/desktop/src/main/auth/OAuth.ts` and wire its handlers in
`index.ts`. Build large files with heredoc appends, not one write.

- **Loopback listener**: start a short-lived `node:http` server on an ephemeral
  `127.0.0.1` port only for the duration of a login. Route `/callback`, capture
  `code` + `state`, respond with a tiny "you can close this tab" HTML page, then
  close the server. Bind to `127.0.0.1` explicitly (never `0.0.0.0`).
- **PKCE**: generate `code_verifier`/`code_challenge` (S256) and a random
  `state` with `node:crypto`. Verify `state` on the callback; reject mismatch.
- **Open browser**: `shell.openExternal(authorizeUrl)` (import `shell` from
  `electron` — currently only `app, BrowserWindow, ipcMain, dialog, clipboard`
  are imported at line 1).
- **Token exchange**: POST the `code` + `code_verifier` to the provider token
  URL; receive access/refresh tokens + expiry.
- **Refresh**: helper that exchanges the refresh token when the access token is
  near expiry; called lazily before a token is handed out.

IPC handlers to add (mirror existing naming):
- `auth:start`  `(provider: 'claude' | 'codex') => Promise<{ ok: boolean }>` —
  runs the whole flow, resolves when linked or rejects on error/timeout (~2 min).
- `auth:status` `() => Promise<{ claude: boolean; codex: boolean }>` — which
  providers currently have a valid (or refreshable) token.
- `auth:logout` `(provider) => Promise<void>` — delete stored tokens.

### 1b. Token storage — do NOT put OAuth tokens in config.yaml
`.codehamr/config.yaml` lives in the user's project and its `key` field is meant
for `${ENV}` refs or literal keys (see `Profile.ResolvedKey` in
`codehamr/internal/config/config.go`). OAuth access/refresh tokens are
short-lived per-user secrets and must not be committed or scoped per-project.

Store them OUT of the repo, keyed per user, mirroring how project memory is kept
outside the repo (`memoryRoot()` uses `os.UserConfigDir`). Options, pick one:
- `safeStorage` (Electron) encrypted blob under `app.getPath('userData')`
  — preferred; OS keychain-backed on mac/Win.
- Plain JSON under `userData` with `0o600` as a fallback when `safeStorage`
  is unavailable.

Add helpers in the OAuth module; never log token values (see house rule on
secrets — probe with presence checks, don't `console.log` them).

### 1c. Preload bridge
Files: `apps/desktop/src/preload/index.ts` and `apps/desktop/src/preload/index.d.ts`.
Expose the three IPC calls on `window.codehamr` exactly like the existing
`readConfig`/`scanModels` wrappers (thin `ipcRenderer.invoke` passthroughs) and
add their TS signatures to the `.d.ts` / the `window.codehamr` type.

### 1d. Settings UI — "Accounts" section
File: `apps/desktop/src/renderer/src/Settings.tsx` (803 lines; the config editor
+ preset UI). Add a new section alongside the existing profile editor:
- Two rows (Claude, Codex), each showing Linked/Not linked from `auth:status`.
- "Link" button → `window.codehamr.authStart(provider)`, show a "waiting for
  browser authorization…" state while pending, then refresh status.
- "Unlink" button → `auth:logout`.
- Match existing zinc/tailwind styling and the `Field`/section patterns already
  in the file.

**Phase 1 verification** (must actually run, not just compile):
- `export PATH="/opt/homebrew/bin:$PATH"; npm run build` (electron-vite) — no TS
  errors in main/preload/renderer.
- `npm run dev`, click Link, confirm the browser opens, complete the flow
  against a real provider (or a stub OAuth server), confirm the loopback catches
  the code and the UI flips to "Linked".
- Restart the app; confirm status persists (storage works) and refresh kicks in
  after the access token would have expired.
- Confirm no token value is ever written to `.codehamr/config.yaml` or to logs
  (`grep` the config + any log for a token prefix should return nothing).
- Do the full link/restart/refresh cycle for **both** Claude and Codex — a flow
  that works for one provider but not the other is not Phase-1 complete.

---

## Phase 2 — Backend transport (the real blocker; needs the routing decision) — ⏸ NOT STARTED

Only start after the human answers the proxy-vs-adapter question above.

**Who implements this:** Phase 2 is handled by Claude, not the local LLM. Phases
0–1 are the local-LLM handoff; the backend-transport work (proxy wiring or Go
provider adapters, plus the config/AgentSession token plumbing) is deliberately
reserved for Claude because it touches the Go agent's core send path and the
"one code path" invariant in `llm.go`, where a subtle regression is costly. The
local LLM should stop at the end of Phase 1 (a verified "Linked" state) and hand
back for Phase 2.

### Option A (preferred): route through the codehamr.com proxy
Keeps the Go client OpenAI-only. The server accepts the subscription OAuth token,
translates chat-completions ⇄ the provider's native API, and streams standard
OpenAI SSE back. Client-side work is then small:
- On successful link, create/update an OpenAI-shaped profile in config.yaml
  whose `url` is the proxy and whose `key` is a *reference* the agent resolves at
  send time to the current (possibly just-refreshed) OAuth token — NOT the raw
  token baked onto disk. Likely a new indirection so main injects the live token
  into the spawned agent's environment (`AgentSession.ts` spawns the child; pass
  the token via env, then `key: ${THAT_ENV_VAR}` which `ResolvedKey` already
  expands). This keeps secrets off disk exactly like the existing `${VAR}` path.
- Server-side proxy changes are out of scope for this repo/handoff — flag them as
  a dependency on the codehamr.com backend team.

### Option B: Go provider adapters (only if A is rejected)
Adds real risk and violates the "one code path" rule in `llm.go`; treat as last
resort. Would introduce an adapter interface in `codehamr/internal/llm` that maps
`chatRequest`/`streamChunk` to Anthropic Messages / OpenAI Responses, selected by
a new profile field. Large surface, needs Go tests in `internal/llm` and careful
handling of tool-call and reasoning deltas per provider. Rebuild with
`npm run agent:build` (GOEXPERIMENT=nogreenteagc) and `go test ./...` in
`codehamr/`.

**Phase 2 verification:** run an actual turn end-to-end in `npm run dev` against
the linked subscription; confirm streaming, tool calls, and token refresh mid-
session all work; `go test ./...` green if any Go changed.

---

## Files touched (quick map)
- `apps/desktop/src/main/auth/OAuth.ts` — NEW: PKCE flow, loopback, storage, refresh.
- `apps/desktop/src/main/index.ts` — register `auth:*` handlers; import `shell`.
- `apps/desktop/src/main/agent/AgentSession.ts` — (phase 2A) inject live token via env.
- `apps/desktop/src/preload/index.ts` + `index.d.ts` — bridge `auth:*`.
- `apps/desktop/src/renderer/src/Settings.tsx` — Accounts section.
- `codehamr/internal/config/config.go` — (phase 2A) only if a new profile/ref shape is needed.
- `codehamr/internal/llm/llm.go` — (phase 2B ONLY) adapters; avoid if possible.
- `docs/oauth-notes.md` — NEW: confirmed per-provider OAuth constants.

## Ordering / milestones
1. ✅ Phase 0 spike → notes doc.
2. ✅ Phase 1 (main + preload + UI + storage) → "linked account" state built;
   UI hidden behind `SHOW_ACCOUNTS = false` while paused. Compile/build/logic
   verified; full desktop run still pending (see STATUS).
3. ⏸ Human decides routing (A vs B). **← resume here.**
4. ⏸ Phase 2 → turns actually run on the subscription. **Implemented by Claude**
   (not the local LLM), since it touches the Go agent's core send path.

## Guardrails
- Never write OAuth tokens to `.codehamr/` or to logs. Off-repo, `0o600`/keychain.
- Bind loopback to `127.0.0.1` only; verify `state` and PKCE.
- Don't rebrand `.codehamr`/`codehamr` to Anvil (see AGENTS.md).
- Verify by running the app, not just by `tsc`/`go build`.
