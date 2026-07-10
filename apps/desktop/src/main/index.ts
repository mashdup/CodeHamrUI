import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, createWriteStream, type WriteStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Command, ConfigFile } from '@codehamr-ui/protocol'
import { AgentSession } from './agent/AgentSession'

let win: BrowserWindow | null = null
let session: AgentSession | null = null
let crashLog: WriteStream | null = null

/**
 * Persist everything the agent says outside the protocol (stderr, stray
 * stdout) to .codehamr/harness.log in the workspace. A Go runtime meta-crash
 * floods stderr far past what the transcript UI keeps readable; the full
 * trace on disk is what makes the post-mortem possible.
 */
function openCrashLog(cwd: string): void {
  crashLog?.end()
  try {
    const dir = join(cwd, '.codehamr')
    mkdirSync(dir, { recursive: true })
    crashLog = createWriteStream(join(dir, 'harness.log'), { flags: 'w' })
    crashLog.write(`# codehamr-ui agent session ${new Date().toISOString()}\n`)
  } catch {
    crashLog = null // logging must never block a session from starting
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
    session?.stop()
    openCrashLog(cwd)
    session = new AgentSession({
      binaryPath: resolveBinary(),
      cwd,
      onEvent: (event) => win?.webContents.send('agent:event', event),
      onNoise: (line) => {
        // Mirror to the dev terminal too: a Go panic's stack trace lands on
        // stderr and this is the easiest place to read it in full.
        console.error('[codehamr]', line)
        crashLog?.write(line + '\n')
        win?.webContents.send('agent:noise', line)
      },
      onExit: (code, signal) => {
        crashLog?.write(`# agent exited code=${code} signal=${signal}\n`)
        win?.webContents.send('agent:exit', { code, signal })
      },
    })
    session.start()
    return session.running
  })

  ipcMain.handle('agent:send', async (_evt, raw: unknown) => {
    // Never trust the renderer: validate against the protocol schema before
    // the command reaches the child's stdin.
    const cmd = Command.parse(raw)
    session?.send(cmd)
  })

  ipcMain.handle('agent:stop', async () => {
    session?.stop()
    session = null
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
    const header =
      '# codehamr configuration — edited via CodeHamr UI\n' +
      '# key: ${MY_KEY} expands the env var at runtime, keeping secrets off disk.\n\n'
    await writeFile(
      join(cwd, '.codehamr', 'config.yaml'),
      header + stringifyYaml(cfg),
      'utf8',
    )
  })
}

app.whenReady().then(() => {
  wireIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  session?.stop()
  if (process.platform !== 'darwin') app.quit()
})
