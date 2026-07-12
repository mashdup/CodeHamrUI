import { app, BrowserWindow, ipcMain, dialog, clipboard } from 'electron'
import { join, resolve, sep } from 'node:path'
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  readFileSync,
  writeFileSync,
  watch,
  type WriteStream,
  type FSWatcher,
} from 'node:fs'
import { readFile, writeFile, readdir, stat, rename, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import electronUpdater from 'electron-updater'
import { Command, ConfigFile } from '@codehamr-ui/protocol'
import { AgentSession } from './agent/AgentSession'

const { autoUpdater } = electronUpdater

let win: BrowserWindow | null = null

/**
 * One agent per open workspace tab, keyed by the workspace path. Every event
 * forwarded to the renderer is tagged with that cwd so each tab folds only
 * its own stream.
 */
interface WorkspaceSession {
  session: AgentSession
  log: WriteStream | null
}
const sessions = new Map<string, WorkspaceSession>()

// Filesystem watchers keep each open workspace's file tree live: agent bash
// commands (mkdir, git clone, npm install, build output) and external edits
// don't emit file_diff, so without this the tree only caught write/edit_file.
// Keyed by workspace and independent of the agent's restart cycle — the tree
// outlives any single agent process.
const watchers = new Map<string, FSWatcher>()

// Directory names whose churn must never trigger a refresh: .codehamr writes
// session/transcript/log constantly (a refresh loop waiting to happen), and
// the rest are high-volume noise the tree omits anyway.
const watchIgnore = new Set([
  '.codehamr',
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'out',
  'release',
  'target',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
])

function startWatcher(cwd: string): void {
  if (watchers.has(cwd)) return // survives agent restarts; start once per tab
  let timer: NodeJS.Timeout | null = null
  // Absolute parent directories of changed entries, accumulated across the
  // debounce window. The renderer reloads ONLY these (if loaded), never the
  // whole tree — the difference between a targeted refresh and a storm of
  // hundreds of listDir calls when node_modules is expanded.
  const changed = new Set<string>()
  try {
    // recursive is native on Windows and macOS (our targets); on Linux it's
    // unsupported and throws — caught below, leaving the tree manual-refresh.
    const w = watch(cwd, { recursive: true, persistent: false }, (_evt, filename) => {
      let parent = cwd
      if (filename) {
        const segs = String(filename).split(/[\\/]/)
        if (segs.some((s) => watchIgnore.has(s))) return
        segs.pop() // drop the entry name, keep its directory
        parent = segs.length ? join(cwd, ...segs) : cwd
      }
      if (changed.size < 200) changed.add(parent)
      // Coalesce bursts (npm install fires thousands of events) into one ping.
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const dirs = [...changed]
        changed.clear()
        win?.webContents.send('fs:changed', { cwd, dirs })
      }, 300)
    })
    w.on('error', (e) => console.error('[watch]', cwd, e.message))
    watchers.set(cwd, w)
  } catch (e) {
    console.error('[watch] could not watch', cwd, (e as Error).message)
  }
}

function stopWatcher(cwd: string): void {
  watchers.get(cwd)?.close()
  watchers.delete(cwd)
}

function stopSession(cwd: string): void {
  const ws = sessions.get(cwd)
  if (!ws) return
  ws.session.stop()
  ws.log?.end()
  sessions.delete(cwd)
}

/**
 * Persist everything the agent says outside the protocol (stderr, stray
 * stdout) to .codehamr/harness.log in the workspace. A Go runtime meta-crash
 * floods stderr far past what the transcript UI keeps readable; the full
 * trace on disk is what makes the post-mortem possible.
 */
function openCrashLog(cwd: string): WriteStream | null {
  try {
    const dir = join(cwd, '.codehamr')
    mkdirSync(dir, { recursive: true })
    const log = createWriteStream(join(dir, 'harness.log'), { flags: 'w' })
    log.write(`# codehamr-ui agent session ${new Date().toISOString()}\n`)
    return log
  } catch {
    return null // logging must never block a session from starting
  }
}

/**
 * Resolve the codehamr binary, in trust order: the copy bundled with the
 * packaged app (pinned build, ships in resources/agent/), the fork's local
 * dev build, then PATH as a last resort.
 */
function resolveBinary(): string {
  const exe = process.platform === 'win32' ? 'codehamr.exe' : 'codehamr'
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'agent', exe)
    if (existsSync(bundled)) return bundled
  }
  // Repo layout: <root>/codehamr/dist/<exe> when built via `npm run agent:build`.
  const local = join(app.getAppPath(), '..', '..', 'codehamr', 'dist', exe)
  if (existsSync(local)) return local
  return exe // rely on PATH
}

// ---------------------------------------------------------------------------
// Config presets: named endpoint configs stored app-globally (userData), so
// one saved setup follows the user across every project. The one marked
// default seeds .codehamr/config.yaml in brand-new project folders.
// ---------------------------------------------------------------------------

interface PresetStore {
  defaultPreset?: string
  presets: Record<string, ConfigFile>
}

const presetsPath = (): string => join(app.getPath('userData'), 'presets.json')

/**
 * Permission mode per workspace, kept in userData rather than the project's
 * .codehamr/ — trusting a folder is a decision about *your* machine, and it
 * must not ride along when a repo is shared or committed.
 */
const modesPath = (): string => join(app.getPath('userData'), 'modes.json')

function readModes(): Record<string, 'ask' | 'auto'> {
  try {
    const raw = JSON.parse(readFileSync(modesPath(), 'utf8')) as Record<string, unknown>
    const out: Record<string, 'ask' | 'auto'> = {}
    for (const [k, v] of Object.entries(raw)) {
      if (v === 'ask' || v === 'auto') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

function readPresets(): PresetStore {
  try {
    const raw = JSON.parse(readFileSync(presetsPath(), 'utf8')) as {
      defaultPreset?: unknown
      presets?: Record<string, unknown>
    }
    const presets: Record<string, ConfigFile> = {}
    for (const [name, value] of Object.entries(raw.presets ?? {})) {
      const parsed = ConfigFile.safeParse(value)
      if (parsed.success) presets[name] = parsed.data
    }
    const def = typeof raw.defaultPreset === 'string' && presets[raw.defaultPreset]
      ? raw.defaultPreset
      : undefined
    return { defaultPreset: def, presets }
  } catch {
    return { presets: {} }
  }
}

function writePresets(store: PresetStore): void {
  writeFileSync(presetsPath(), JSON.stringify(store, null, 2), 'utf8')
}

const execFileP = promisify(execFile)

const countLines = (s: string): number => {
  if (s === '') return 0
  const n = (s.match(/\n/g) ?? []).length
  return s.endsWith('\n') ? n : n + 1
}

/**
 * Working-tree diff stat, to mirror what git tools (and Claude Code) show:
 * tracked changes vs HEAD from `git diff --numstat`, PLUS every line of each
 * untracked (new, non-ignored) file counted as an addition — a plain
 * `git diff` omits those. Falls back to unstaged-only for a repo with no
 * commits yet. Returns null on any failure (not a repo, git missing) so the UI
 * hides the badge.
 */
async function gitDiffStat(cwd: string): Promise<{ added: number; removed: number } | null> {
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024,
      })
      return stdout
    } catch {
      return null
    }
  }
  const out = (await run(['diff', 'HEAD', '--numstat'])) ?? (await run(['diff', '--numstat']))
  if (out === null) return null
  let added = 0
  let removed = 0
  for (const line of out.split('\n')) {
    // "<added>\t<removed>\t<path>"; binary files show "-\t-\t" and are skipped.
    const m = /^(\d+)\t(\d+)\t/.exec(line)
    if (m) {
      added += Number(m[1])
      removed += Number(m[2])
    }
  }
  // Untracked new files: each line is an addition. --exclude-standard respects
  // .gitignore, so node_modules/build output stay out.
  const untracked = await run(['ls-files', '--others', '--exclude-standard'])
  if (untracked) {
    for (const rel of untracked.split('\n').filter(Boolean).slice(0, 5000)) {
      try {
        const abs = join(cwd, rel)
        const info = await stat(abs)
        if (info.size > 10 * 1024 * 1024) continue // skip huge blobs
        const buf = await readFile(abs)
        if (buf.subarray(0, 8192).includes(0)) continue // binary
        added += countLines(buf.toString('utf8'))
      } catch {
        /* unreadable file: skip */
      }
    }
  }
  return { added, removed }
}

/**
 * Current git branch for the workspace, for the header indicator. Returns the
 * branch name, or the short commit SHA when HEAD is detached, or null when it's
 * not a git repo / git is missing (the UI then hides the indicator).
 */
async function gitBranch(cwd: string): Promise<string | null> {
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
        windowsHide: true,
        timeout: 5000,
      })
      return stdout.trim()
    } catch {
      return null
    }
  }
  const branch = await run(['branch', '--show-current'])
  if (branch === null) return null // not a repo / git missing
  if (branch !== '') return branch
  // Detached HEAD (empty branch name): show the short commit instead.
  const sha = await run(['rev-parse', '--short', 'HEAD'])
  return sha || null
}

const CONFIG_HEADER =
  '# codehamr configuration — edited via CodeAnvil\n' +
  '# key: ${MY_KEY} expands the env var at runtime, keeping secrets off disk.\n\n'

async function writeConfigFile(cwd: string, cfg: ConfigFile): Promise<void> {
  const dir = join(cwd, '.codehamr')
  mkdirSync(dir, { recursive: true })
  await writeFile(join(dir, 'config.yaml'), CONFIG_HEADER + stringifyYaml(cfg), 'utf8')
}

// ---------------------------------------------------------------------------
// Chat history: one chat = the live pair (.codehamr/session.json for the
// agent's memory + transcript.json for the UI view); archived chats keep
// their pair under .codehamr/chats/<id>/. Switching swaps the live pair and
// restarts the agent, which reads session.json at boot — the Go side needs
// no knowledge of any of this.
// ---------------------------------------------------------------------------

const LIVE_CHAT_FILES = ['session.json', 'transcript.json']

const chatsDir = (cwd: string): string => join(cwd, '.codehamr', 'chats')
const chatMetaPath = (cwd: string): string => join(chatsDir(cwd), 'meta.json')

function readChatMeta(cwd: string): { current: string } {
  try {
    const raw = JSON.parse(readFileSync(chatMetaPath(cwd), 'utf8')) as { current?: unknown }
    if (typeof raw.current === 'string' && raw.current) return { current: raw.current }
  } catch {
    // fall through: first use, or corrupt meta — mint a fresh id either way
  }
  return { current: `chat-${Date.now()}` }
}

function writeChatMeta(cwd: string, meta: { current: string }): void {
  mkdirSync(chatsDir(cwd), { recursive: true })
  writeFileSync(chatMetaPath(cwd), JSON.stringify(meta), 'utf8')
}

/** Move the live pair into chats/<id>/ (missing files are fine). */
async function archiveLiveChat(cwd: string, id: string): Promise<void> {
  const dir = join(chatsDir(cwd), id)
  mkdirSync(dir, { recursive: true })
  for (const f of LIVE_CHAT_FILES) {
    const src = join(cwd, '.codehamr', f)
    if (existsSync(src)) await rename(src, join(dir, f))
  }
}

/** Move chats/<id>/'s pair into the live slot and remove the archive dir. */
async function restoreChat(cwd: string, id: string): Promise<void> {
  const dir = join(chatsDir(cwd), id)
  for (const f of LIVE_CHAT_FILES) {
    const src = join(dir, f)
    if (existsSync(src)) await rename(src, join(cwd, '.codehamr', f))
  }
  await rm(dir, { recursive: true, force: true })
}

/** First user message of a transcript file → list title. */
async function chatTitle(transcriptPath: string): Promise<string> {
  try {
    const items = JSON.parse(await readFile(transcriptPath, 'utf8')) as {
      kind?: string
      text?: string
    }[]
    const firstUser = items.find((it) => it.kind === 'user' && it.text)
    if (firstUser?.text) return firstUser.text.slice(0, 60)
  } catch {
    // unreadable/empty transcript: fall through
  }
  return 'untitled chat'
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    autoHideMenuBar: true,
    // Frameless-with-native-controls: the renderer's own header IS the title
    // bar (see App.tsx). 'hidden' drops the OS title bar on both platforms;
    // macOS keeps its traffic lights, Windows draws min/max/close as an overlay
    // tinted to match the header so there's no second, duplicate app title.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 14 } } // vertically centered in the 40px bar
      : {}),
    ...(process.platform === 'win32'
      ? {
          titleBarOverlay: {
            color: '#09090b', // zinc-950 — matches body / header background
            symbolColor: '#a1a1aa', // zinc-400
            height: 40,
          },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Live-preview browser pane (<webview> in the renderer). webviews get
      // Chromium defaults: no node integration, isolated session.
      webviewTag: true,
    },
  })
  win.on('ready-to-show', () => win?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function wireIpc(): void {
  // Working-tree diff stat (git diff --numstat vs HEAD): totals of added and
  // removed lines. Returns null when it's not a git repo or git is missing, so
  // the UI can hide the badge.
  ipcMain.handle('git:diffstat', async (_evt, cwd: string) => gitDiffStat(cwd))
  ipcMain.handle('git:branch', async (_evt, cwd: string) => gitBranch(cwd))

  // System clipboard access for the composer's right-click menu. Routed
  // through main because the sandboxed preload can't import the clipboard
  // module directly, and navigator.clipboard is unreliable without focus.
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.handle('clipboard:write', (_evt, text: string) => {
    clipboard.writeText(String(text))
  })

  // Re-tint the native Windows caption buttons to match the current theme.
  // No-op on macOS (traffic lights aren't a colored overlay).
  ipcMain.handle('titlebar:overlay', (_evt, color: string, symbolColor: string) => {
    if (process.platform !== 'win32' || !win) return
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: 40 })
    } catch {
      /* overlay unavailable on this window */
    }
  })

  ipcMain.handle('workspace:pick', async () => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Open project folder',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('agent:start', async (_evt, cwd: string) => {
    stopSession(cwd)
    const log = openCrashLog(cwd)
    // Brand-new project: seed config.yaml from the default preset (if any)
    // before the agent bootstraps, so a fresh folder starts with the user's
    // endpoints instead of the stock template.
    let seededFrom: string | null = null
    if (!existsSync(join(cwd, '.codehamr', 'config.yaml'))) {
      const store = readPresets()
      const def = store.defaultPreset ? store.presets[store.defaultPreset] : undefined
      if (def) {
        await writeConfigFile(cwd, def)
        seededFrom = store.defaultPreset!
      }
    }
    const session = new AgentSession({
      binaryPath: resolveBinary(),
      cwd,
      onEvent: (event) => win?.webContents.send('agent:event', { cwd, event }),
      onNoise: (line) => {
        // Mirror to the dev terminal too: a Go panic's stack trace lands on
        // stderr and this is the easiest place to read it in full.
        console.error(`[codehamr ${cwd}]`, line)
        log?.write(line + '\n')
        win?.webContents.send('agent:noise', { cwd, line })
      },
      onExit: (code, signal) => {
        log?.write(`# agent exited code=${code} signal=${signal}\n`)
        win?.webContents.send('agent:exit', { cwd, code, signal })
      },
    })
    sessions.set(cwd, { session, log })
    startWatcher(cwd) // idempotent — persists across the agent's restarts
    session.start()
    return { running: session.running, seededFrom }
  })

  ipcMain.handle('agent:send', async (_evt, cwd: string, raw: unknown) => {
    // Never trust the renderer: validate against the protocol schema before
    // the command reaches the child's stdin.
    const cmd = Command.parse(raw)
    sessions.get(cwd)?.session.send(cmd)
  })

  ipcMain.handle('agent:stop', async (_evt, cwd: string) => {
    stopSession(cwd)
    stopWatcher(cwd) // tab closed for good; not just an agent restart
  })

  // UI transcript persistence: the renderer's rich view (tool cards, diffs)
  // lives beside the agent's own session.json. Opaque to main — the renderer
  // owns the shape.
  ipcMain.handle('transcript:read', async (_evt, cwd: string) => {
    try {
      return JSON.parse(await readFile(join(cwd, '.codehamr', 'transcript.json'), 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('transcript:write', async (_evt, cwd: string, items: unknown) => {
    const dir = join(cwd, '.codehamr')
    mkdirSync(dir, { recursive: true })
    await writeFile(join(dir, 'transcript.json'), JSON.stringify(items), 'utf8')
  })

  ipcMain.handle('config:read', async (_evt, cwd: string) => {
    try {
      const text = await readFile(join(cwd, '.codehamr', 'config.yaml'), 'utf8')
      const parsed = ConfigFile.safeParse(parseYaml(text))
      return parsed.success ? parsed.data : null
    } catch {
      return null // no config yet: the agent writes one on first start
    }
  })

  ipcMain.handle('config:write', async (_evt, cwd: string, raw: unknown) => {
    // Validate before touching disk: the agent's strict decoder bricks the
    // next start on a malformed file, so nothing unvetted may reach it.
    const cfg = ConfigFile.parse(raw)
    if (!cfg.models[cfg.active]) {
      throw new Error(`active profile "${cfg.active}" does not exist`)
    }
    await writeConfigFile(cwd, cfg)
  })

  // -------------------------------------------------------------------------
  // Workspace explorer: read-only filesystem access, always rooted to the
  // open workspace. The renderer is our code, but the boundary is enforced
  // here anyway — contextIsolation means treating it as semi-trusted.
  // -------------------------------------------------------------------------

  /** Throws unless p resolves inside root. Returns the resolved path. */
  const insideWorkspace = (root: string, p: string): string => {
    const abs = resolve(root, p)
    const normRoot = resolve(root)
    if (abs !== normRoot && !abs.startsWith(normRoot + sep)) {
      throw new Error('path escapes the workspace')
    }
    return abs
  }

  ipcMain.handle('fs:list', async (_evt, root: string, dir: string) => {
    const abs = insideWorkspace(root, dir)
    const entries = await readdir(abs, { withFileTypes: true })
    return entries
      .map((e) => ({ name: e.name, path: join(abs, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
  })

  ipcMain.handle('fs:read', async (_evt, root: string, file: string) => {
    const abs = insideWorkspace(root, file)
    const info = await stat(abs)
    const CAP = 512 * 1024
    if (info.size > CAP * 4) return { kind: 'too-large', size: info.size }
    const buf = await readFile(abs)
    // NUL in the head = binary; the viewer is for text.
    if (buf.subarray(0, 8192).includes(0)) return { kind: 'binary', size: info.size }
    const truncated = buf.length > CAP
    return {
      kind: 'text',
      content: buf.subarray(0, CAP).toString('utf8'),
      truncated,
      size: info.size,
    }
  })

  // Rich file preview: classify by extension, return text for code/markdown
  // and base64 for the binary formats the renderer knows how to display
  // (images, PDF, docx). Unknown binaries get kind 'binary' (no preview).
  const IMAGE_EXTS: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    avif: 'image/avif',
  }
  const MD_EXTS = new Set(['md', 'markdown', 'mdx'])

  // Decode a file to text, handling the common non-UTF-8 cases rather than
  // rendering U+FFFD. Returns null for genuine binary. BOM detection runs
  // first: UTF-16 text is full of NUL bytes and would otherwise trip the
  // binary heuristic below.
  const decodeText = (buf: Buffer): string | null => {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
      return buf.subarray(3).toString('utf8')
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
      return new TextDecoder('utf-16le').decode(buf.subarray(2))
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff)
      return new TextDecoder('utf-16be').decode(buf.subarray(2))
    if (buf.subarray(0, 8192).includes(0)) return null // no BOM + NUL = binary
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      // Invalid UTF-8 → legacy Windows-1252, the usual source of a lone
      // en-dash or smart-quote showing up as U+FFFD ("Engineer – Mobile").
      return new TextDecoder('windows-1252').decode(buf)
    }
  }

  ipcMain.handle('preview:read', async (_evt, root: string, file: string) => {
    const abs = insideWorkspace(root, file)
    const info = await stat(abs)
    const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase()
    const TEXT_CAP = 512 * 1024
    const BIN_CAP = 30 * 1024 * 1024 // PDFs/docx can be chunky; base64 over IPC

    if (IMAGE_EXTS[ext]) {
      if (info.size > BIN_CAP) return { kind: 'too-large', size: info.size }
      return {
        kind: 'image',
        mime: IMAGE_EXTS[ext],
        dataB64: (await readFile(abs)).toString('base64'),
      }
    }
    if (ext === 'pdf' || ext === 'docx') {
      if (info.size > BIN_CAP) return { kind: 'too-large', size: info.size }
      return { kind: ext, dataB64: (await readFile(abs)).toString('base64') }
    }

    // Everything else: try as text.
    if (info.size > TEXT_CAP * 8) return { kind: 'too-large', size: info.size }
    const decoded = decodeText(await readFile(abs))
    if (decoded === null) return { kind: 'binary', size: info.size }
    const truncated = decoded.length > TEXT_CAP
    let content = truncated ? decoded.slice(0, TEXT_CAP) : decoded
    if (MD_EXTS.has(ext)) return { kind: 'markdown', content, truncated, size: info.size }
    // Pretty-print JSON so minified files are actually readable. Skipped when
    // truncated (the tail is cut, so it won't parse).
    if (ext === 'json' && !truncated) {
      try {
        content = JSON.stringify(JSON.parse(content), null, 2)
      } catch {
        /* not valid JSON — show it raw */
      }
    }
    return { kind: 'text', content, truncated, size: info.size }
  })

  // -------------------------------------------------------------------------
  // Chat history
  // -------------------------------------------------------------------------

  ipcMain.handle('chats:list', async (_evt, cwd: string) => {
    const meta = readChatMeta(cwd)
    const out: { id: string; title: string; updatedAt: number; current: boolean }[] = []
    // Current chat: live transcript.
    const livePath = join(cwd, '.codehamr', 'transcript.json')
    out.push({
      id: meta.current,
      title: await chatTitle(livePath),
      updatedAt: existsSync(livePath) ? (await stat(livePath)).mtimeMs : Date.now(),
      current: true,
    })
    // Archived chats.
    try {
      for (const e of await readdir(chatsDir(cwd), { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const t = join(chatsDir(cwd), e.name, 'transcript.json')
        out.push({
          id: e.name,
          title: await chatTitle(t),
          updatedAt: existsSync(t) ? (await stat(t)).mtimeMs : 0,
          current: false,
        })
      }
    } catch {
      // no chats dir yet
    }
    return out.sort((a, b) => Number(b.current) - Number(a.current) || b.updatedAt - a.updatedAt)
  })

  ipcMain.handle('chats:new', async (_evt, cwd: string) => {
    stopSession(cwd)
    const meta = readChatMeta(cwd)
    await archiveLiveChat(cwd, meta.current)
    const fresh = `chat-${Date.now()}`
    writeChatMeta(cwd, { current: fresh })
    return fresh
  })

  ipcMain.handle('chats:switch', async (_evt, cwd: string, id: string) => {
    stopSession(cwd)
    const meta = readChatMeta(cwd)
    if (id === meta.current) return
    await archiveLiveChat(cwd, meta.current)
    await restoreChat(cwd, id)
    writeChatMeta(cwd, { current: id })
  })

  ipcMain.handle('chats:delete', async (_evt, cwd: string, id: string) => {
    const meta = readChatMeta(cwd)
    if (id === meta.current) throw new Error('cannot delete the active chat')
    await rm(join(chatsDir(cwd), id), { recursive: true, force: true })
  })

  ipcMain.handle('mode:get', async (_evt, cwd: string) => readModes()[cwd] ?? 'ask')

  ipcMain.handle('mode:set', async (_evt, cwd: string, mode: 'ask' | 'auto') => {
    if (mode !== 'ask' && mode !== 'auto') throw new Error(`unknown mode: ${mode}`)
    const modes = readModes()
    modes[cwd] = mode
    writeFileSync(modesPath(), JSON.stringify(modes, null, 2), 'utf8')
  })

  // Scan an OpenAI-compatible endpoint's model list (GET /v1/models). Runs in
  // main to avoid the renderer's CSP and CORS. Ollama serves this too.
  ipcMain.handle('models:scan', async (_evt, url: string, key: string) => {
    const base = String(url).trim().replace(/\/+$/, '')
    if (!base) throw new Error('enter an endpoint URL first')
    // Expand a whole-key ${VAR} reference against the env, matching the agent.
    const trimmedKey = String(key).trim()
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmedKey)
    const resolvedKey = m ? (process.env[m[1]] ?? '') : trimmedKey
    let res: Response
    try {
      res = await fetch(`${base}/v1/models`, {
        headers: resolvedKey ? { Authorization: `Bearer ${resolvedKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      })
    } catch (e) {
      throw new Error(`could not reach ${base} (${(e as Error).message})`)
    }
    if (!res.ok) {
      throw new Error(`${base}/v1/models returned ${res.status} ${res.statusText}`)
    }
    const json = (await res.json()) as { data?: { id?: string }[] }
    const ids = Array.isArray(json.data)
      ? json.data.map((d) => d.id).filter((id): id is string => !!id)
      : []
    return ids.sort()
  })

  ipcMain.handle('presets:list', async () => {
    const store = readPresets()
    return { defaultPreset: store.defaultPreset ?? null, presets: store.presets }
  })

  ipcMain.handle(
    'presets:save',
    async (_evt, name: string, raw: unknown, setDefault: boolean) => {
      const trimmed = String(name).trim()
      if (!trimmed) throw new Error('preset name is required')
      const cfg = ConfigFile.parse(raw)
      const store = readPresets()
      store.presets[trimmed] = cfg
      if (setDefault) store.defaultPreset = trimmed
      writePresets(store)
    },
  )

  ipcMain.handle('presets:delete', async (_evt, name: string) => {
    const store = readPresets()
    delete store.presets[name]
    if (store.defaultPreset === name) store.defaultPreset = undefined
    writePresets(store)
  })

  ipcMain.handle('presets:setDefault', async (_evt, name: string | null) => {
    const store = readPresets()
    store.defaultPreset = name !== null && store.presets[name] ? name : undefined
    writePresets(store)
  })
}

/**
 * Auto-update from GitHub Releases (the electron-builder publish config is
 * baked into the app). Download silently; apply only when the user opts in
 * from the banner — never restart an app that has live agent sessions.
 * Dev builds skip entirely.
 */
function wireAutoUpdate(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.on('update-downloaded', (info) => {
    win?.webContents.send('app:update-ready', info.version)
  })
  autoUpdater.on('error', (err) => {
    // Non-fatal by definition: the running app is fine, only the check failed.
    console.error('[updater]', err.message)
  })
  ipcMain.handle('app:install-update', async () => {
    for (const cwd of [...sessions.keys()]) stopSession(cwd)
    autoUpdater.quitAndInstall()
  })
  void autoUpdater.checkForUpdates()
}

app.whenReady().then(() => {
  wireIpc()
  wireAutoUpdate()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const cwd of [...sessions.keys()]) stopSession(cwd)
  for (const cwd of [...watchers.keys()]) stopWatcher(cwd)
  if (process.platform !== 'darwin') app.quit()
})
