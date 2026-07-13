# Anvil

A desktop coding harness for [codehamr](https://codehamr.com) — drive the agent
visually: streaming markdown replies, a live "thinking" display, gated tool
approvals, inline diffs for every edit, a themeable UI, a built-in browser and
file preview, slash commands, and sessions that survive restarts.

This is an unofficial fork that brings a web-based UI over the original TUI
agent. It runs a [lightly patched fork](https://github.com/mashdup/codehamr) of
the agent (git submodule) that adds a headless `--json` NDJSON mode; the TUI and
agent core are upstream's, unchanged. Open source under the [MIT license](LICENSE).

## Features

**Chat & agent**

- **Streaming chat** — Markdown rendered in real time as the agent types.
- **Live "thinking" display** — reasoning and tool activity shown as it happens,
  so the app never looks hung while the model works.
- **Ask / Auto modes** — gate every bash/write/edit for approval, or let the
  agent run unattended.
- **Inline diffs** — the exact changes for every file edit, rendered in the tool
  card.
- **Grouped tool calls** — consecutive calls fold into one card you can expand.
- **Slash commands** — type `/` for a palette: `/compact` (summarize the
  conversation to reclaim the model's context on long sessions), `/model`,
  `/clear`, `/help`.
- **Pin, copy & search** — right-click a message to pin or copy it; a search
  modal filters your messages and jumps to the one you pick.
- **Attachments** — drag & drop or paste images (for vision models) and text
  files (inlined into the prompt); a right-click clipboard menu on the composer.
- **Project memory** — the agent accumulates durable facts about each project
  (build commands, where subsystems live, conventions, the tech stack) and loads
  them into every new chat, so it keeps learning the more you work. It saves
  facts proactively via a `remember` tool — each shown as a card with a one-click
  **Undo** — and memory is stored **outside your repo** (in the OS user-config
  dir, keyed per project) so it never litters the workspace or dirties git. A
  **Project memory** tab in Settings lets you view, edit, download, or load your
  own.

**Previews & workspace**

- **File explorer & viewer** — browse the project tree and preview text,
  markdown, images, PDF, and docx, with a word-wrap toggle. The open file
  **live-refreshes when it changes on disk** (agent writes or external edits).
- **Live browser** — a built-in Chromium pane for your dev server (localhost),
  with a landing page when nothing's loaded. The agent can open a file or a URL
  for you (e.g. show a running build). It relies on your dev server's own hot
  reload for updates.
- **Split preview** — the file viewer and browser stack with an adjustable
  divider; close one and the other fills the space.
- **Multi-workspace tabs** — a session per project, switched freely.
- **Per-project history** — archive, switch, and delete chats.
- **Git diff badge** — live `+added / −removed` line counts vs HEAD (including
  new untracked files).

**Appearance**

- **Themes** — several dark and light schemes, custom colors, and a UI-scale
  control for accessibility. Code and diff surfaces use a fixed palette so
  they stay readable under any theme.
- **Integrated title bar** — the native OS title bar is replaced by in-app
  window controls that follow the theme; side panels collapse responsively when
  the window gets narrow.

**Configuration & lifecycle**

- **Graphical config editor** — edit `.codehamr/config.yaml` via the Settings
  panel, and save named endpoint presets.
- **Persistent sessions** — close the app and come back to the same conversation.
- **Auto-update** — updates download in the background and install only when you
  click "Update — restart" (running agent sessions stop only then).

## Architecture

```
Electron renderer (React)  ── typed IPC ──  Electron main
                                                │  child-process stdio (NDJSON)
                                        codehamr --json  (Go)
```

No localhost servers anywhere: renderer↔main is Electron IPC, main↔agent is
stdin/stdout. The wire contract lives in `packages/protocol` (zod schemas),
mirrored by the fork's `internal/protocol` Go structs — keep the two in
lockstep. See [AGENTS.md](AGENTS.md) for the full contributor guide.

## Development

Prereqs: Node 22+, Go 1.26+, Git for Windows (the agent's bash tool needs a
POSIX shell on Windows).

```sh
git clone --recurse-submodules git@github.com:mashdup/CodeAnvil.git
cd CodeAnvil
npm install
npm run agent:build   # builds the fork (GOEXPERIMENT=nogreenteagc — see PLAN.md §8)
npm run dev           # launches the app with HMR
```

Open a project folder in the app; the agent bootstraps `.codehamr/config.yaml`
there (edit it via the ⚙ panel). Point a profile at local Ollama, any
OpenAI-compatible endpoint, or HamrPass. Image drop needs a vision model behind
the endpoint; on a text-only model the app degrades gracefully.

> Note: LLM endpoints must be OpenAI-compatible. A bare-host `url` gets
> `/v1/chat/completions` appended; a `url` with its own path (e.g.
> `https://api.z.ai/api/paas/v4`) is used as-is with `/chat/completions`, so
> custom cloud endpoints work without a gateway.

## Packaging & releases

```sh
npm run dist:win   # NSIS installer in apps/desktop/release/ (agent bundled)
npm run dist:mac   # run on a Mac; dmg config is ready
```

Tagging `v*` (matching `apps/desktop/package.json`'s version) makes CI build the
Windows installer and macOS dmg/zip. Both platforms build in parallel and a
single publisher job attaches everything to **one** draft GitHub Release — review
and publish it from the Releases page. Published releases feed the in-app
auto-updater: the app downloads updates in the background and shows an
"Update — restart" button (it never restarts on its own).

**Windows** ships unsigned for now (SmartScreen will warn on first run).

**macOS signing + notarization** activates automatically when these repo secrets
exist (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `MAC_CERT_P12` | base64 of a *Developer ID Application* certificate exported as .p12 (`base64 -i cert.p12`) |
| `MAC_CERT_PASSWORD` | the .p12 export password |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | generate at appleid.apple.com → App-Specific Passwords |
| `APPLE_TEAM_ID` | 10-char team id (developer.apple.com → Membership) |

Create the certificate at developer.apple.com → Certificates → *Developer ID
Application* (needs a CSR — Keychain Access on a Mac, or openssl anywhere).
Without the secrets, mac builds stay unsigned; macOS auto-update requires the
signed build.

## License

MIT — see [LICENSE](LICENSE). Anvil is open source; contributions welcome.
The bundled [codehamr](https://github.com/mashdup/codehamr) agent fork is also
MIT-licensed (see its own `LICENSE`).

## More

- [AGENTS.md](AGENTS.md) — contributor guide: architecture, the TS↔Go protocol
  contract, build/dev commands, and pitfalls.
- [PLAN.md](PLAN.md) — full architecture, protocol spec, and milestone log.
