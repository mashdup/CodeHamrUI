# CodeHamr UI — Architecture & Implementation Plan

> A cross-platform desktop coding harness (Electron) that drives the **CodeHamr**
> agent underneath — visual chat, inline diffs, image drops, and a graphical
> config/model manager. Think "Claude Desktop / Cursor experience" on top of the
> minimal `codehamr` Go agent.

Status: **Phase 1 (M0–M6) complete · Phase 2 started at P1 (CI + releases)** · Updated: 2026-07-10

**Locked decisions:** target **Windows + macOS**; started at **M2** (skipped
the M1 spike); fork lives at `git@github.com:mashdup/codehamr.git`, wired in
as the `codehamr/` git submodule. The fork stays a plain fork — no upstreaming
planned; pull upstream `main` manually when needed.

**Working today** (all E2E-tested against a mock OpenAI endpoint plus live
runs): chat with streaming + markdown, reasoning ("thinking") display, status
bar with phase/elapsed/cancel, gated tool cards with allow / always-allow /
deny, inline colored diffs for file edits, model switcher, graphical config
editor, session persistence (agent + transcript), image drop/paste with
multimodal wire format, crash logging to `.codehamr/harness.log`.

**Fork delta** (mashdup/codehamr `main`, 5 commits ahead of upstream at the
time of writing): `--json` protocol mode (`internal/protocol/`), Windows
POSIX-shell resolution, session persistence + `clear`, multimodal images +
turn-teardown race fix, first-round-failure history rollback.

---

## 1. Vision & scope

CodeHamr is a minimal terminal coding agent (Go, Charm Bubbletea TUI). It chats,
calls tools (`bash`, `read_file`, `write_file`, `edit_file`), and is driven by a
single `.codehamr/config.yaml`. It is deliberately small: *"no router, no
sub-agents, no skill system, no MCP."*

This project wraps that agent in a desktop GUI that adds what a terminal can't do
well:

- **Structured chat** — assistant messages, tool calls, and results as
  first-class UI elements rather than scrollback text.
- **Inline diffs** — `edit_file`/`write_file` rendered in a real diff viewer with
  approve/reject before apply.
- **Image drops** — paste/drag images into the conversation (capability-gated on
  the active model being multimodal).
- **Visual config & model management** — the graphical version of editing
  `config.yaml` and `/models`.
- **Multiple project workspaces & session history.**

Non-goals (initially): plugins/MCP, multi-agent orchestration, a web-hosted
version, mobile.

---

## 2. The core constraint that shapes everything

CodeHamr today exposes **only a human-facing terminal stream** — no API, no
headless mode, no JSON output. A rich GUI needs **structured events** (this is a
message; this is a tool call; this is a diff). So the heart of this project is a
small **fork of CodeHamr that adds a headless JSON/stdio protocol**, reusing the
existing agent core unchanged.

Findings that make this viable:

| Fact | Implication |
|------|-------------|
| **MIT licensed** | Fork/modify/redistribute freely; upstreaming a PR is welcome-friendly. |
| **Go 1.26**, module `github.com/codehamr/codehamr` | Standard Go toolchain; single static binary output. |
| TUI (`internal/tui/`) is **separate** from agent core | We add a new front-end driver next to the TUI; core logic untouched. |
| Core packages: `internal/llm`, `internal/tools`, `internal/ctx`, `internal/config` | The JSON driver reuses these directly. |
| `cmd/codehamr/main.go` + `reexec_{unix,windows}.go` | Entry point already branches per-OS; a `--json` flag slots in here. |

---

## 3. High-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Renderer  (React + Vite + TypeScript + Tailwind)   │
│  • Chat transcript (messages, tool cards, streaming)         │
│  • Monaco diff viewer + approve/reject                       │
│  • File tree · image drop zone · model switcher · settings   │
└───────────────▲───────────────────────────┬─────────────────┘
                │ typed IPC (contextBridge)  │
┌───────────────┴───────────────────────────▼─────────────────┐
│  Electron Main  (Node/TypeScript)                            │
│  • Process manager: spawn/kill `codehamr --json`             │
│  • Protocol bridge: NDJSON <-> typed events (zod-validated)  │
│  • Workspace + config.yaml read/write · file system access   │
└───────────────▲───────────────────────────┬─────────────────┘
                │  stdout (NDJSON events)    │ stdin (NDJSON cmds)
┌───────────────┴───────────────────────────▼─────────────────┐
│  CodeHamr fork  —  `codehamr --json`                         │
│  new internal/protocol driver  ──uses──►  internal/llm       │
│  (emits events, reads commands)           internal/tools     │
│                                           internal/ctx       │
│  internal/tui  (unchanged, default mode)  internal/config    │
└─────────────────────────────────────────────────────────────┘
```

Two processes, one clean contract (the protocol). The Electron side is identical
regardless of how the agent core evolves upstream.

---

## 4. The protocol (the linchpin — design first)

Newline-delimited JSON (NDJSON) over the child process's stdin/stdout. One JSON
object per line. Validated with **zod** on the TS side; plain structs on the Go
side. Version the schema from day one (`"v": 1`).

### Client → agent (stdin)

| Type | Payload | Purpose |
|------|---------|---------|
| `prompt` | `{ text, images?: [{mime, dataB64}] }` | User turn; images only sent if model is multimodal. |
| `approve` | `{ callId, decision: "allow"\|"deny", scope?: "once"\|"session" }` | Respond to a gated tool call. |
| `cancel` | `{}` | Interrupt the current turn. |
| `set_model` | `{ name }` | Equivalent of `/models <name>`. |
| `get_models` | `{}` | Equivalent of `/models`. |

### Agent → client (stdout)

| Type | Payload | Purpose |
|------|---------|---------|
| `ready` | `{ version, activeModel, models[] }` | Handshake on start. |
| `assistant_delta` | `{ text }` | Streaming assistant text chunk. |
| `assistant_done` | `{}` | End of assistant text for this step. |
| `tool_call` | `{ callId, name, args, needsApproval }` | Agent wants to run a tool. |
| `tool_result` | `{ callId, ok, output, truncated? }` | Tool finished. |
| `file_diff` | `{ callId, path, unifiedDiff, before?, after? }` | Structured diff for edit/write. |
| `turn_done` | `{ usage? }` | Turn complete; ready for next prompt. |
| `error` | `{ message, fatal }` | Recoverable or fatal error. |
| `log` | `{ level, message }` | Debug/telemetry passthrough. |

Design notes:
- **Tool approval** is the key safety UX: this agent runs `bash`. `needsApproval`
  lets the GUI show a clear allow/deny gate. A "session allow" scope keeps flow
  fast once trusted.
- Diffs are emitted **before** apply when possible, so the UI can offer
  reject-before-write. Fallback: emit after with `before`/`after` and support
  revert.
- Keep it stream-first: everything is incremental so the UI never blocks.

---

## 5. CodeHamr fork changes (Go side)

Keep changes **additive and isolated** so the diff is small and upstreamable.

1. **`cmd/codehamr/main.go`** — add a `--json` (or `codehamr serve`) flag. When
   set, dispatch to the new protocol driver instead of `internal/tui`. Default
   behaviour (interactive TUI) is untouched.
2. **New `internal/protocol/` package** — the headless driver:
   - Reads NDJSON commands from stdin.
   - Runs the same agent loop using `internal/llm`, `internal/ctx`,
     `internal/config`, `internal/tools`.
   - Emits NDJSON events to stdout.
3. **Tool-approval hook** — introduce a small interface the tools call before
   executing side effects (`bash`, `write_file`, `edit_file`). TUI supplies a
   pass-through/prompt implementation; protocol driver supplies an
   emit-`tool_call`-and-await-`approve` implementation. (If the core doesn't
   already have such a seam, this is the one slightly invasive change — scope it
   carefully in M2.)
4. **Diff emission** — reuse whatever `internal/tools/edit.go` computes; surface
   the unified diff to the driver.
5. **Multimodal message construction** — extend the LLM request builder to attach
   image content parts when the active model is a vision model and the endpoint is
   OpenAI-compatible. Text-only path stays default.

Deliverable: a `codehamr` binary that behaves identically in normal use and
speaks the protocol under `--json`. Plan to open an upstream PR for the protocol
mode so we're not maintaining a hard fork indefinitely.

### Seam map (verified against the real source)

The reusable core needs **no changes**; only the orchestration loop (currently
living in the Bubbletea model) is reimplemented headlessly:

| Concern | Real symbol | Reuse strategy |
|---------|-------------|----------------|
| Bootstrap config | `config.Bootstrap(cwd)`, `cfg.ActiveProfile()`, `cfg.ActiveURL()`, `p.ResolvedKey()` | Call verbatim (mirrors `cmd/codehamr/main.go`). |
| LLM streaming | `llm.New(url, model, key)` → `client.Chat(ctx, msgs, tools) <-chan Event` | Consume as-is. `EventContent`→`assistant_delta`, `EventReasoning`→`reasoning`, `EventToolCall`/`EventDone`→drive the loop, `EventError`→`error`. |
| Message packing | `ctx.Pack(history, budget)` | Call verbatim each turn. |
| Tool schemas | `tools.BashSchema()` / `ReadFileSchema()` / `WriteFileSchema()` / `EditFileSchema()` | Same 4 tools the TUI registers (`model.go:686` `buildTools`). |
| Tool execution | `tools.Execute(ctx, call) chmctx.Message` | **Single choke point** — wrap it with the approval gate; no change to the tool files themselves. |
| Orchestration loop | `tui.Model.Update` + `dispatchNextTool` (`model.go:612`, `:1049`) | **Reimplement headlessly** in `internal/protocol/` — the only new logic. |

Headless turn loop (pseudocode for `internal/protocol`):

```
history += {role: user, content: prompt, images?}
for {
    msgs := ctx.Pack(history, budget)
    for ev := range client.Chat(turnCtx, msgs, buildTools()) {
        switch ev.Kind {
        case EventContent:   emit assistant_delta{ev.Content}
        case EventReasoning: emit reasoning{ev.Content}        // optional
        case EventDone:      history = append(history, *ev.Final); final = ev.Final
        case EventError:     emit error{ev.Err}; return
        }
    }
    if len(final.ToolCalls) == 0 { emit turn_done; return }
    for _, call := range final.ToolCalls {
        emit tool_call{call, needsApproval}
        if needsApproval && awaitApprove(call) == deny { history += denyResult; continue }
        result := tools.Execute(turnCtx, call)   // <- gated choke point
        history = append(history, result)
        emit tool_result{call.ID, result} (+ file_diff for edit/write)
    }
}
```

This confirms the fork change is: **add `internal/protocol/` + a `--json` branch
in `main.go`; touch nothing else** (until images in M5, which extend
`toWire`/`wireMessage` in `internal/llm`).

---

## 6. Electron app (TypeScript side)

**Main process**
- `ProcessManager` — spawn/kill `codehamr --json` per workspace, restart on
  crash, surface exit codes.
- `ProtocolBridge` — line-split stdout, zod-parse each event, forward typed events
  to the renderer; serialize renderer commands to stdin.
- `WorkspaceService` — pick project folder, locate/create `.codehamr/config.yaml`,
  read/write config, list models.
- `BinaryResolver` — find the user's installed `codehamr`, or use a bundled one
  (see §8 packaging).

**Renderer (React)**
- `ChatView` — transcript of messages / tool cards / diffs; streaming text.
- `ToolCard` — collapsible bash/read/write/edit with status + approval buttons.
- `DiffView` — Monaco diff editor; approve/reject.
- `FileTree` + optional Monaco file viewer.
- `ImageDropZone` — drag/paste, capability-gated by active model.
- `ModelSwitcher` — dropdown backed by `get_models`/`set_model`.
- `SettingsPanel` — the graphical `config.yaml` editor (the original "setup UI"
  idea, now a first-class settings screen: mode picker, per-model fields,
  validation, live YAML preview).

**IPC** — a single typed, contextIsolated bridge (no `nodeIntegration` in the
renderer). All protocol events/commands flow through it.

---

## 7. Milestones

| # | Milestone | Outcome | Rough effort |
|---|-----------|---------|--------------|
| **M0** | Foundations | ✅ **Done** — fork submoduled + builds (Go 1.26.5), npm-workspaces monorepo scaffolded, repo initialised. | ~1–2 days |
| **M1** | PTY spike | **Skipped by decision** — went straight to M2. | — |
| **M2** | Protocol v0 *(backbone)* | ✅ **Done & proven live** — `codehamr --json` streams deltas, gates tool calls behind approve/deny, executes, loops rounds, emits `turn_done`+usage. Windows bash-shell fix landed (`bash_windows.go` resolves Git Bash; upstream hardcodes `/bin/sh`). Hardened by live use: turn-teardown race fixed (busy released before terminal emit), first-round-failure rollback prevents session poisoning, panics surface as fatal error events. | ~1 week |
| **M3** | Rich rendering | ✅ **Done** — inline colored diffs (custom renderer, not Monaco — lighter), markdown messages, streaming, cancel, status bar with phase+elapsed, reasoning display, session-scope approvals. | ~1 week |
| **M4** | Config & sessions | ✅ **Done** — settings modal (profiles CRUD, active picker, env-var keys, validated both sides, save-restarts agent) + session persistence: agent history in `.codehamr/session.json`, UI transcript in `transcript.json`, resume notice on ready, New chat = protocol `clear`. Multi-workspace deferred (reopen works; tabs are a nice-to-have). | ~1 week |
| **M5** | Image drop | ✅ **Done** — drag/drop + paste with thumbnails, user-bubble previews, OpenAI vision content-parts on the wire (text-only messages stay plain strings), conservative image token costing in Pack. Gating is optimistic: attach always allowed; a vision-less endpoint's rejection (e.g. llama.cpp "mmproj" 500) auto-degrades — images stripped from the wire with a warn notice, turn retried, attachments kept in history for a later vision model. | ~2–3 days |
| **M6** | Packaging | ✅ **Windows done, macOS config ready** — `npm run dist:win` produces a signed-metadata NSIS installer (`apps/desktop/release/CodeHamr UI Setup 0.1.0.exe`, ~97MB) with the `nogreenteagc` agent bundled at `resources/agent/` (resolveBinary prefers it when packaged); generated hammer app icon; `dist:mac` config present — run on a Mac to produce the dmg. *Deferred: real code signing (needs certs), auto-update (needs publish infra), multi-workspace tabs, vision-model live test.* | ~1 week |

M1 and M2 can overlap; M1 is intentionally disposable once M2 lands.

### Phase 2 (post-roadmap)

| # | Milestone | Outcome | Status |
|---|-----------|---------|--------|
| **P1** | CI + releases | ✅ **Done** — CI green on first push (linux full Go suite, windows protocol+tools, app typecheck+build). `v0.1.0` tag built the NSIS installer **and the first-ever macOS dmg (arm64)** on hosted runners and published both to a draft GitHub Release. Release ritual: bump `apps/desktop/package.json` version → push matching `v*` tag → publish the draft from the Releases page. | ✅ done |
| **P2** | Live validation *(user-owned)* | ✅ Confirmed working live 2026-07-10 (vision path included, after the endpoint-fallback + hint fixes). | ✅ done |
| **P3** | Workspace explorer | ✅ **Done** — toggleable lazy file tree (Files button), emerald dots on agent-edited files, tree auto-refreshes on `file_diff`, read-only viewer pane (size-capped, binary-aware), diff headers click-through to the viewer. Workspace-rooted fs IPC with path-escape guard. | ✅ done |
| **P4** | Multi-workspace tabs | ✅ **Done** — tab bar in the header, one agent process per open project (main keeps a session map keyed by workspace; all events cwd-tagged). Inactive tabs stay mounted: transcripts, streams, and in-flight turns keep running in the background. Closing a tab stops its agent; reopening an open folder just activates its tab. | ✅ done |
| **P5** | UX polish | ✅ **Done** — type-ahead prompt queueing (chips above the input, auto-dispatch on turn end, Cancel discards the queue), Ctrl+F transcript search (filter view + match count), shortcuts: Ctrl+F search, Ctrl+B file tree, Ctrl+, settings, Esc closes search/viewer, Ctrl+O open project. | ✅ done |
| **P6** | Signing + auto-update | Code-signing cert (Windows SmartScreen / macOS notarization), electron-updater fed by the P1 GitHub Releases. Costs money; needs no code groundwork beyond P1. | pending |

macOS note: release dmg targets **arm64 only** for now — the agent binary is
built on the runner for its host arch; an x64 (Intel) dmg needs a second Go
cross-build wired into extraResources, deferred until someone asks.

---

## 8. Key risks & decisions

- **Bundle vs. resolve the Go binary.** Bundling gives a one-click install but
  ties the app to a codehamr version; resolving the user's binary keeps them in
  sync but adds a setup step. *Recommendation: bundle a pinned build, allow an
  override path in settings.*
- **Fork drift.** Mitigate by upstreaming the `--json` protocol as a PR and
  keeping fork changes additive/isolated.
- **Windows process control.** `reexec_windows.go` hints at re-exec behaviour;
  validate early in M1 that spawning + stdin/stdout piping works cleanly on
  Windows (this is your primary platform).
- **Go runtime GC crash on Windows 26xxx kernels** *(hit live 2026-07-09)*:
  Go 1.26's default Green Tea GC can die with recursive `fatal error` /
  "traceback did not unwind completely" during GC stack scans
  ([golang/go#76614](https://github.com/golang/go/issues/76614)). Mitigated:
  the agent is built with `GOEXPERIMENT=nogreenteagc` (`npm run agent:build`)
  and spawned with `GODEBUG=asyncpreemptoff=1`. Full agent stderr now persists
  to `<workspace>/.codehamr/harness.log` for any future post-mortem.
- **Security model.** This agent runs `bash`. The approval UX is not optional
  polish — it's the core trust surface. Make gating clear and default-safe.
- **Image support is model-gated.** Local `qwen3`-style defaults may be
  text-only. Detect capability and disable/enable the drop zone accordingly;
  don't silently drop images.
- **Streaming from OpenAI-compatible endpoints.** Confirm `internal/llm` streams
  today; if not, streaming deltas may need a small core change.

---

## 9. Proposed monorepo layout

```
CodeHamrUI/
├─ apps/
│  └─ desktop/            # Electron app
│     ├─ src/main/        # main process (ProcessManager, ProtocolBridge, ...)
│     ├─ src/preload/     # contextBridge IPC
│     └─ src/renderer/    # React UI
├─ packages/
│  └─ protocol/           # shared TS types + zod schemas for the protocol
├─ codehamr/              # git submodule or vendored fork of the Go agent
├─ PLAN.md
└─ README.md
```

The `packages/protocol` schemas are the single source of truth on the TS side and
mirror the Go structs; keep them in lockstep and version them together.

---

## 10. Tech stack

- **Desktop:** Electron, Vite, React, TypeScript, Tailwind.
- **Editor/diff:** Monaco.
- **Protocol validation:** zod.
- **PTY (spike only):** node-pty + xterm.js.
- **Packaging:** electron-builder + auto-update.
- **Agent:** forked `codehamr` (Go 1.26), new `internal/protocol` driver.

---

## 11. Open questions

1. ~~**Primary OS target**~~ → **Decided: Windows + macOS together.**
2. **Binary distribution** — bundle a pinned codehamr build, or resolve the user's
   installed one? (Recommend bundle + override.) *Deferred to M6.*
3. **Upstream intent** — upstream the `--json` protocol, or keep a private fork?
   *Deferred; keeping changes additive so either stays open.*
4. **Branding/naming** — unofficial community app, or coordinating with the
   CodeHamr maintainers? *Deferred.*
5. ~~**First slice**~~ → **Decided: go straight to the M2 protocol backbone.**
```
