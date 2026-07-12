# AGENTS.md

Guidance for AI coding agents working in this repo. Read this first.

## What this is

**CodeAnvil** is a cross-platform (Windows + macOS) Electron desktop coding
harness. It drives **CodeHamr**, a terminal coding agent (a forked Go tool),
over a line-delimited JSON (NDJSON) protocol on the agent's stdin/stdout.

The desktop app is the GUI; CodeHamr is the brain. They talk only through a
narrow, versioned wire protocol — the renderer has no idea the agent is Go.

## Naming (important)

- **User-facing brand is "CodeAnvil"** (hammer + anvil). Use it in UI copy,
  release notes, and anything a user sees.
- **The underlying agent is "CodeHamr"** — a separate project we don't rename.
  Keep every internal `codehamr` identifier as-is: the agent binary, the
  `window.codehamr` preload bridge, the `@codehamr-ui/*` package scope, and the
  `.codehamr/` config dir. Do **not** rebrand these to CodeAnvil. (The GitHub
  repo itself was renamed to `mashdup/CodeAnvil`; the internal identifiers above
  did not change.)

## Repo layout

```
CodeAnvil/                      ← this repo (github.com/mashdup/CodeAnvil, npm workspaces)
├── apps/desktop/               ← @codehamr-ui/desktop — the Electron app
│   └── src/{main,preload,renderer}   ← electron-vite: 3 build targets
├── packages/protocol/          ← @codehamr-ui/protocol — shared TS wire types (zod)
├── codehamr/                   ← GIT SUBMODULE: the Go agent fork
│   └── internal/protocol/protocol.go   ← the Go side of the wire protocol
└── scripts/build-agent.mjs     ← builds the Go binary → codehamr/dist/
```

`codehamr/` is a **git submodule** pointing at `github.com/mashdup/codehamr`
(our fork). Changes to the agent are commits in that submodule, not this repo.

## Key files

Renderer — `apps/desktop/src/renderer/src/`:
- `Workspace.tsx` — **the big one** (~2500 lines): chat transcript, composer,
  tool cards, diffs, preview split, slash palette. The transcript `Item` /
  `ToolStatus` / `Phase` types live at the top; most UI work lands here.
- `App.tsx` — top level: workspace tabs, custom title bar, platform detection.
- `Settings.tsx` — the `config.yaml` editor + `AppearanceModal` (theme picker).
- `themes.ts` — theme engine (`SCHEMES`, `applyTheme`).
- `FilePreview.tsx` / `FileTree.tsx` — file viewer / tree.
- `BrowserPane.tsx` — live `<webview>` browser pane.
- `syntax.ts` — highlight.js wrapper. `styles.css` — global styles + the two
  fixed code/diff palettes.

Main / preload — `apps/desktop/src/`:
- `main/index.ts` — all IPC handlers (spawn, config, git diff-stat, clipboard,
  model scan, presets, chats, window).
- `main/agent/AgentSession.ts` — spawns `codehamr --json`; the NDJSON bridge.
- `preload/index.ts` — the `window.codehamr` bridge (contextBridge).

Agent — `codehamr/internal/`:
- `protocol/protocol.go` — the NDJSON driver (Runner, turn loop, tool dispatch).
- `llm/llm.go` — the only LLM client (OpenAI chat-completions).
- `tools/` — bash / read_file / write_file / edit_file. `config/config.go` —
  the `.codehamr/config.yaml` schema + bootstrap.

## The protocol is the contract (most important invariant)

The wire protocol is defined in **two files that must stay in lockstep**:

- **TS side:** `packages/protocol/src/index.ts` (zod schemas; source of truth
  the renderer + main import).
- **Go side:** `codehamr/internal/protocol/protocol.go` (structs the agent
  emits/parses).

Rules:
- Adding or changing a command/event means editing **both** files to match, and
  bumping `PROTOCOL_VERSION` (TS) / `V` (Go) together if the shape changes.
- The main process **validates every outbound command** with `Command.parse()`
  before writing to the child's stdin (`apps/desktop/src/main/index.ts`). If a
  command type isn't in the TS `Command` union, it is rejected and never reaches
  the agent — and if the renderer set `busy` first, the UI hangs. So a new
  command needs the TS schema, the Go handler, **and** a running main process
  that has the new schema (see "Dev restarts").
- Events that don't match the TS `AgentEvent` union are silently dropped by
  `parseAgentLine`, so a shape mismatch looks like "nothing happened."

Commands: `prompt`, `approve`, `cancel`, `set_model`, `get_models`, `clear`,
`compact`, `set_mode`. Events: `ready`, `cleared`, `compacted`, `mode`,
`assistant_delta`, `reasoning_delta`, `assistant_done`, `tool_call`,
`tool_result`, `file_diff`, `preview`, `turn_done`, `models`, `error`, `log`.

## Data flow

```
renderer (React)  ──Command──▶  main (IPC, validates)  ──▶  AgentSession
                                                              spawns `codehamr --json`
renderer  ◀──AgentEvent──  main (parseAgentLine)  ◀──stdout NDJSON──  codehamr
```

`apps/desktop/src/main/agent/AgentSession.ts` owns the child process + the
NDJSON bridge. The whole renderer speaks only `AgentEvent`/`Command`; swapping
the backend would mean writing one adapter that presents this interface.

## Agent tools & approvals

The agent exposes four real tools plus two harness-only ones:
- `bash`, `read_file`, `write_file`, `edit_file` — real side effects.
- `preview_file`, `preview_url` — harness-only. They emit a `preview` event the
  GUI turns into an open file/browser panel; no shell, no approval, nothing
  returned to the model. Defined in `protocol.go`; the standalone TUI never sees
  them.

Permission modes (`set_mode`): **ask** gates every side-effecting tool behind the
harness's allow/deny handshake — a `tool_call` with `needsApproval:true`, answered
by an `approve` command keyed on `callId`. **auto** runs them unattended.
`read_file` is always allowed; a session-scoped allow skips the gate for later
calls of the same tool.

## Persistence & config

Per-workspace state lives in `.codehamr/`:
- `config.yaml` — model profiles (below); strict schema.
- `session.json` — the **agent's** conversation history (what's sent to the
  model). This is what `/compact` rewrites.
- `transcript.json` — the **renderer's** rich transcript (tool cards, diffs).
  Distinct from `session.json`, so compacting the agent's memory doesn't erase
  the visible chat.
- `chats/` — archived per-project chat sessions; `history` — prompt recall.

App-global state (config presets, per-workspace permission mode, window state)
lives in Electron's `userData`, not the project.

`config.yaml` shape:
```yaml
active: local                 # which profile to use
models:
  local:
    llm: gemma                 # model id sent as `model` on the wire
    url: https://…             # OpenAI-compatible base, WITHOUT /v1
    key: ${MY_KEY}             # ${VAR} expands from env; keeps secrets off disk
    context_size: 32768        # optional; the server X-Context-Window wins
logging: false                 # optional
```
Unknown top-level keys make the agent refuse to start. Settings-panel edits and
`models:scan` (GET `<url>/v1/models`) write/populate this file.

## Tests & CI

- **Go tests** live in the submodule: `cd codehamr && go test ./...` (protocol,
  tools, config, llm, ctx, diff, tree). `.github/workflows/ci.yml` runs `go vet`
  + full tests on Linux and protocol/tools tests on Windows for every push to
  `main` and every PR.
- There is **no JS/TS test or lint suite** — `npm run typecheck` and
  `npm run build` are the gate for the desktop app.

## Commands

Run from the repo root:

- `npm run typecheck` — typecheck all workspaces. **Always run before finishing.**
- `npm run build` — build protocol + desktop (production bundle; the real
  arbiter that catches issues dev HMR can hide).
- `npm run dev` — launch the Electron app in dev (electron-vite).
- `npm run agent:build` — build the Go agent → `codehamr/dist/codehamr.exe`
  (sets `GOEXPERIMENT=nogreenteagc`). Run after editing anything under `codehamr/`.
- `npm run dist:win` / `dist:mac` — full installer builds (agent + app).

## Dev workflow gotchas

- **Hot reload only covers renderer code.** Changes to the **main process**,
  **preload**, the **protocol package** (main imports it), or the **Go binary**
  require a **full app restart** (`Ctrl+C` the dev server + relaunch), not HMR.
  Many "it didn't work" reports trace to skipping this.
- After editing the Go agent, run `npm run agent:build` **and** restart, or the
  app keeps spawning the old binary.
- If dev gets wedged (stale HMR, "Failed to reload", weird React errors), stop
  all dev/electron processes, delete `apps/desktop/node_modules/.vite`, and
  restart clean.

## Conventions & pitfalls

- **React 19 + Rules of Hooks.** Hooks (`useState`, etc.) go **only** at the top
  level of a component body — never at module scope, in a plain helper, or after
  an early return. A stray module-scope `useState` throws "Invalid hook call" and
  blanks the entire app while still passing `tsc`. `Workspace.tsx` is large
  (~2500 lines) and holds most of the UI + all transcript types at the top; edit
  it carefully and re-run typecheck.
- **Tailwind v4** compiles utilities to `var(--color-*)`, which is what powers
  runtime theming — overriding CSS custom properties on `<html>` (see
  `renderer/src/themes.ts`) re-themes everything with zero component changes.
- **Code and diff surfaces are deliberately NOT themed.** They use a fixed pair
  of palettes (`--code-*` / `--diff-*` on `:root` vs `:root[data-light]` in
  `styles.css`) — dark-on-dark for dark themes, light-on-light for light themes —
  so syntax and diffs stay readable regardless of the user's accent/surface tint.
  Don't swap these for themed `zinc`/`emerald` classes.
- **LLM endpoints must be OpenAI-compatible and serve `/v1/chat/completions`.**
  The Go client (`codehamr/internal/llm/llm.go`) hardcodes `<url>/v1/chat/
  completions`; the config `url` is the base *before* `/v1`. Providers that use a
  different path (e.g. Z.ai's `/api/paas/v4`) 404 and need a gateway (OpenRouter)
  or a client change.
- **Windows/Go runtime.** The agent is built with `GOEXPERIMENT=nogreenteagc`
  and spawned with `GODEBUG=asyncpreemptoff=1` to avoid a Go GC/unwind crash on
  recent Windows kernels. Keep both when touching the spawn path or build script.
- Config lives in `.codehamr/config.yaml` per workspace (strict schema; unknown
  top-level keys make the agent refuse to start). The GUI edits it directly.

## Release process (two repos)

Releases are cut from `main` and triggered by pushing a `v*` tag. Because the
Go agent is a submodule that CI checks out from GitHub, **the submodule commit
must be pushed before the parent tag** or CI can't find the pinned SHA.

Order:
1. Commit agent changes **inside** `codehamr/`, then `git push` the submodule to
   its fork (`origin main`).
2. In the parent repo, stage the updated submodule pointer + app changes and commit.
3. Bump the version in `apps/desktop/package.json` (this is the release version;
   tags track it), commit as `Release vX.Y.Z`.
4. `git tag vX.Y.Z` and push `main` + the tag.

The `.github/workflows/release.yml` workflow builds Windows (NSIS) then macOS
(`needs: windows`, so both attach to **one** draft) and creates a **draft**
GitHub Release. Review and publish it from the Releases page.

## Before you finish

- Run `npm run typecheck` (and `npm run build` for non-trivial changes).
- For runtime behavior, restart the dev app per the rules above and actually
  exercise the change — typecheck alone won't catch a Rules-of-Hooks blank
  screen or a protocol shape mismatch.
- If you touched the protocol, confirm both the TS and Go sides match.
