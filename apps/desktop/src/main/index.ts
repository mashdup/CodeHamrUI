import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join, resolve, sep } from 'node:path'
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  readFileSync,
  writeFileSync,
  type WriteStream,
} from 'node:fs'
import { readFile, writeFile, readdir, stat, rename, rm } from 'node:fs/promises'
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

const CONFIG_HEADER =
  '# codehamr configuration — edited via CodeHamr UI\n' +
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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
  if (process.platform !== 'darwin') app.quit()
})
