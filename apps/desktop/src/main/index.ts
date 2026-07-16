import { app, BrowserWindow, ipcMain, dialog, clipboard } from 'electron'
import { join, resolve, sep, relative, isAbsolute } from 'node:path'
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
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import electronUpdater from 'electron-updater'
import { Command, ConfigFile } from '@codehamr-ui/protocol'
import { AgentSession } from './agent/AgentSession'
import { OAuthManager, type ProviderId } from './auth/OAuth'
import { fixShellPath } from './shellPath'

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
  let gitTimer: NodeJS.Timeout | null = null
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
        if (segs[0] === '.git') {
          // Index/HEAD/refs churn (commit, checkout, add) doesn't touch any
          // tracked file's own directory, so it'd never trigger a tree reload
          // or a git-status refresh otherwise — the change indicators and
          // diff badges would go stale after every commit. Ping a dedicated,
          // debounced git:changed signal instead of the tree-reload one.
          if (gitTimer) clearTimeout(gitTimer)
          gitTimer = setTimeout(() => {
            win?.webContents.send('git:changed', { cwd })
          }, 300)
          return
        }
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

/**
 * Absolute path to the bundled POSIX shell for the bash tool (Windows only),
 * so a packaged app doesn't require Git for Windows. busybox-w32 shipped as
 * sh.exe; fetched into apps/desktop/build/shell by `npm run fetch:busybox` and
 * packaged to resources/shell by electron-builder. Returns null when absent
 * (e.g. dev without a fetch, or non-Windows) — the agent then falls back to
 * Git Bash on PATH.
 */
function resolveShell(): string | null {
  if (process.platform !== 'win32') return null
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'shell', 'sh.exe')]
    : [join(app.getAppPath(), 'build', 'shell', 'sh.exe')]
  for (const p of candidates) if (existsSync(p)) return p
  return null
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
 * OAuth subscription linking (Claude / Codex). Tokens live encrypted under
 * userData via this manager — never in the project's .codehamr/. See
 * src/main/auth/OAuth.ts and OAUTH_PLAN.md.
 */
const oauth = new OAuthManager()

function isProviderId(v: unknown): v is ProviderId {
  return v === 'claude' || v === 'codex'
}

/**
 * Permission mode per workspace, kept in userData rather than the project's
 * .codehamr/ — trusting a folder is a decision about *your* machine, and it
 * must not ride along when a repo is shared or committed.
 */
const modesPath = (): string => join(app.getPath('userData'), 'modes.json')

/**
 * Appearance settings (theme, zoom) persisted to userData so they survive
 * dev restarts where localStorage may be cleared. Loaded synchronously at
 * startup to apply before first paint.
 */
interface AppearanceStore {
  theme?: { name: string; custom?: { bg: string; accent: string } }
  zoom?: number
}
const appearancePath = (): string => join(app.getPath('userData'), 'appearance.json')

function readAppearance(): AppearanceStore {
  try {
    return JSON.parse(readFileSync(appearancePath(), 'utf8')) as AppearanceStore
  } catch {
    return {}
  }
}

function writeAppearance(store: AppearanceStore): void {
  writeFileSync(appearancePath(), JSON.stringify(store, null, 2), 'utf8')
}

/**
 * Project memory lives OUT of the repo, in the same persistent per-project
 * store the agent's Go core uses (config.MemoryPath): the OS user-config dir
 * (app.getPath('appData') === Go's os.UserConfigDir on all three platforms),
 * under codehamr/memory/, keyed by a SHA-256 of the project's absolute path so
 * two checkouts never collide and the filename leaks nothing. This function
 * MUST stay byte-identical to the Go derivation or the desktop would edit a
 * different file than the agent reads - path.resolve matches filepath.Abs+Clean
 * for the clean workspace paths the dialog yields, and the hash/slice mirror
 * hex.EncodeToString(sum[:16]) (16 bytes = 32 hex chars).
 */
const memoryPath = (cwd: string): string => {
  const abs = resolve(cwd)
  const hash = createHash('sha256').update(abs).digest('hex').slice(0, 32)
  return join(app.getPath('appData'), 'codehamr', 'memory', `${hash}.md`)
}

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

/** A per-line git change marker for the file viewer's gutter. `added` and
 *  `modified` mark existing lines (1-based, in the working-tree file);
 *  `removedBefore` lists line numbers that have a deletion immediately above
 *  them (shown as a wedge between rows, like an editor gutter). */
export interface GitLineChanges {
  added: number[]
  modified: number[]
  removedBefore: number[]
}

/**
 * Per-line change status of one file vs HEAD, for the preview gutter (à la an
 * editor's change bar). Parses `git diff HEAD -U0` hunk headers: a hunk with no
 * old lines is an addition, no new lines is a deletion, otherwise a
 * modification. An untracked (new, non-ignored) file marks every line added.
 * Returns null when it's not a repo, git is missing, or the file is unchanged /
 * outside the repo — the UI then shows a plain gutter.
 */
async function gitFileChanges(cwd: string, abs: string): Promise<GitLineChanges | null> {
  const rel = relative(cwd, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null // outside the repo
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
  // Untracked new file: every line is an addition.
  const tracked = await run(['ls-files', '--error-unmatch', '--', rel])
  if (tracked === null) {
    const others = await run(['ls-files', '--others', '--exclude-standard', '--', rel])
    if (others && others.trim()) {
      try {
        const buf = await readFile(abs)
        if (buf.subarray(0, 8192).includes(0)) return null // binary
        const n = countLines(buf.toString('utf8'))
        return { added: Array.from({ length: n }, (_, i) => i + 1), modified: [], removedBefore: [] }
      } catch {
        return null
      }
    }
    return null // not a repo / git missing / ignored
  }
  const out = await run(['diff', 'HEAD', '-U0', '--no-color', '--', rel])
  if (out === null || out.trim() === '') return null // unchanged (or no diff)
  const added: number[] = []
  const modified: number[] = []
  const removedBefore: number[] = []
  for (const line of out.split('\n')) {
    // "@@ -oldStart,oldCount +newStart,newCount @@"; counts default to 1.
    const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (!m) continue
    const oldCount = m[1] === undefined ? 1 : Number(m[1])
    const newStart = Number(m[2])
    const newCount = m[3] === undefined ? 1 : Number(m[3])
    if (newCount === 0) {
      // Pure deletion: mark the line the removed block sat before.
      removedBefore.push(newStart + 1)
    } else if (oldCount === 0) {
      for (let i = 0; i < newCount; i++) added.push(newStart + i)
    } else {
      for (let i = 0; i < newCount; i++) modified.push(newStart + i)
    }
  }
  if (!added.length && !modified.length && !removedBefore.length) return null
  return { added, modified, removedBefore }
}

/**
 * Full unified diff of one file vs HEAD, for the preview's "Diff" view. Uses
 * `git diff HEAD` (3 lines of context) for a tracked file; for an untracked
 * (new, non-ignored) file synthesizes an all-added diff against /dev/null so
 * new files show something too. Returns null when it's not a repo, git is
 * missing, the file is unchanged, binary, or outside the repo — the UI then
 * keeps the diff toggle hidden.
 */
async function gitFileDiff(cwd: string, abs: string): Promise<string | null> {
  const rel = relative(cwd, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null // outside the repo
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
  const tracked = await run(['ls-files', '--error-unmatch', '--', rel])
  if (tracked === null) {
    // Untracked new file: show an all-added diff, but only if git considers it
    // a candidate (respects .gitignore) and it's real text.
    const others = await run(['ls-files', '--others', '--exclude-standard', '--', rel])
    if (!others || !others.trim()) return null // ignored / not a repo / git missing
    try {
      const buf = await readFile(abs)
      if (buf.subarray(0, 8192).includes(0)) return null // binary
      const text = buf.toString('utf8')
      const lines = text.length ? text.replace(/\n$/, '').split('\n') : []
      const body = lines.map((l) => `+${l}`).join('\n')
      const noNewline = text.length && !text.endsWith('\n') ? '\n\\ No newline at end of file' : ''
      return (
        `diff --git a/${rel} b/${rel}\n` +
        `new file\n` +
        `--- /dev/null\n` +
        `+++ b/${rel}\n` +
        `@@ -0,0 +1,${lines.length} @@\n` +
        body +
        noNewline
      )
    } catch {
      return null
    }
  }
  const out = await run(['diff', 'HEAD', '--no-color', '--', rel])
  if (out === null || out.trim() === '') return null // unchanged
  return out
}

/** Working-tree git status for the file tree: absolute paths of changed files,
 *  split by kind so the UI can tint them. `modified` covers tracked edits and
 *  deletions; `added` covers staged new files; `untracked` covers new,
 *  non-ignored files. */
export interface GitStatus {
  modified: string[]
  added: string[]
  untracked: string[]
}

/**
 * Working-tree changes vs the index/HEAD for the whole workspace, feeding the
 * file browser's change indicators (like an editor's source-control coloring).
 * Uses `git status --porcelain=v1 -z -uall`: NUL-delimited (safe for any path),
 * untracked directories expanded to individual files. Porcelain paths are
 * relative to the repo TOPLEVEL (not cwd), so they're resolved against it and
 * returned absolute. Returns null when it's not a repo / git is missing (the UI
 * then shows a plain tree).
 */
async function gitStatus(cwd: string): Promise<GitStatus | null> {
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
  // Repo root as a path RELATIVE to cwd (`--show-cdup`), not the absolute
  // `--show-toplevel` — the latter resolves symlinks (/tmp → /private/tmp on
  // macOS), which would no longer prefix-match the tree's cwd-rooted paths.
  const cdup = await run(['rev-parse', '--show-cdup'])
  if (cdup === null) return null // not a repo / git missing
  const rootDir = resolve(cwd, cdup.trim())
  const out = await run(['status', '--porcelain=v1', '-z', '-uall', '--no-renames'])
  if (out === null) return null
  const modified: string[] = []
  const added: string[] = []
  const untracked: string[] = []
  // Records are NUL-separated: "XY <path>". X=index status, Y=worktree status.
  for (const rec of out.split('\0')) {
    if (rec.length < 4) continue
    const x = rec[0]
    const y = rec[1]
    const rel = rec.slice(3)
    if (!rel) continue
    const abs = join(rootDir, rel)
    if (x === '?' || y === '?') untracked.push(abs)
    else if (x === 'A') added.push(abs)
    else modified.push(abs) // M, D, R, C, and any index/worktree edit
  }
  if (!modified.length && !added.length && !untracked.length) return null
  return { modified, added, untracked }
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

/**
 * Project summary for the empty-chat screen: a one-shot bundle of the git
 * facts worth surfacing (branch, last commit, tracked file count, working-tree
 * change counts, diffstat). Everything is best-effort and null when the repo or
 * git isn't available, so the UI can degrade gracefully (non-git folders just
 * show fewer cards).
 */
export interface ProjectStats {
  isGitRepo: boolean
  branch: string | null
  headSha: string | null
  headSubject: string | null
  headAuthorName: string | null
  headAuthorDate: string | null // ISO 8601
  headRelative: string | null // "2 days ago"
  trackedFiles: number | null
  /** Working-tree change counts (modified, staged-new, untracked). */
  modified: number
  added: number
  untracked: number
  diffAdded: number
  diffRemoved: number
}

async function gitHeadInfo(
  cwd: string,
): Promise<{
  sha: string | null
  subject: string | null
  authorName: string | null
  authorDate: string | null
  relative: string | null
}> {
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
        windowsHide: true,
        timeout: 5000,
      })
      return stdout
    } catch {
      return null
    }
  }
  const sha = (await run(['rev-parse', '--short', 'HEAD']))?.trim() ?? null
  if (!sha) return { sha: null, subject: null, authorName: null, authorDate: null, relative: null }
  // %s subject, %an author name, %aI ISO date, %cr relative ("2 days ago").
  const fmt = await run(['log', '-1', '--format=%s%x1f%an%x1f%aI%x1f%cr', 'HEAD'])
  if (fmt === null) return { sha, subject: null, authorName: null, authorDate: null, relative: null }
  const [subject, authorName, authorDate, relative] = fmt.split('\x1f')
  return {
    sha,
    subject: subject?.trim() || null,
    authorName: authorName?.trim() || null,
    authorDate: authorDate?.trim() || null,
    relative: relative?.trim() || null,
  }
}

async function projectStats(cwd: string): Promise<ProjectStats> {
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
  // A folder is a git repo if `git rev-parse --git-dir` resolves inside cwd.
  // We run this first so non-git folders short-circuit before the heavier
  // queries below (all of which would just return null anyway).
  const gitDir = await run(['rev-parse', '--git-dir'])
  const isGitRepo = gitDir !== null && gitDir.trim() !== ''
  if (!isGitRepo) {
    return {
      isGitRepo: false,
      branch: null,
      headSha: null,
      headSubject: null,
      headAuthorName: null,
      headAuthorDate: null,
      headRelative: null,
      trackedFiles: null,
      modified: 0,
      added: 0,
      untracked: 0,
      diffAdded: 0,
      diffRemoved: 0,
    }
  }
  const branch = (await run(['branch', '--show-current']))?.trim() ?? null
  const trackedOut = await run(['ls-files'])
  const trackedFiles = trackedOut === null ? null : trackedOut.split('\n').filter(Boolean).length
  const head = await gitHeadInfo(cwd)
  const diff = await gitDiffStat(cwd)
  const status = await gitStatus(cwd)
  return {
    isGitRepo: true,
    branch: branch && branch !== '' ? branch : head.sha, // detached → show sha
    headSha: head.sha,
    headSubject: head.subject,
    headAuthorName: head.authorName,
    headAuthorDate: head.authorDate,
    headRelative: head.relative,
    trackedFiles,
    modified: status?.modified.length ?? 0,
    added: status?.added.length ?? 0,
    untracked: status?.untracked.length ?? 0,
    diffAdded: diff?.added ?? 0,
    diffRemoved: diff?.removed ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Session checkpoints: git stash-based snapshots before each agent turn.
// Stashes are separate from commit history, keeping `git log` clean.
// ---------------------------------------------------------------------------

export interface Checkpoint {
  ref: string // stash@{N}
  timestamp: number // unix ms
  sessionId: string
  filesChanged: number
}

async function gitCreateCheckpoint(
  cwd: string,
  sessionId: string,
): Promise<string | null> {
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
  // Check if there are any changes to stash.
  const status = await run(['status', '--porcelain'])
  if (status === null) return null // not a repo / git missing
  if (status === '') return null // no changes

  const timestamp = Date.now()
  const message = `checkpoint:${sessionId}:${timestamp}`
  // `git stash push` resets the working tree to HEAD as a side effect —
  // exactly the "my files vanished" bug this is meant to protect against.
  // Instead we stage everything (index-only, doesn't touch files on disk),
  // snapshot that state into a stash commit with `stash create`/`store`
  // (neither touches the index or working tree), then `git reset` to
  // unstage again — `reset` without --hard only rewinds the index, so the
  // working tree is left completely untouched throughout.
  const staged = await run(['add', '-A'])
  if (staged === null) return null
  const commit = await run(['stash', 'create', message])
  await run(['reset'])
  if (commit === null || commit === '') return null // nothing to snapshot
  const stored = await run(['stash', 'store', '-m', message, commit])
  if (stored === null) return null
  return 'stash@{0}'
}

async function gitListCheckpoints(
  cwd: string,
  sessionId: string,
): Promise<Checkpoint[]> {
  const run = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
        windowsHide: true,
        timeout: 5000,
      })
      return stdout
    } catch {
      return null
    }
  }
  const out = await run(['stash', 'list', '--format=%gD|%s|%aI'])
  if (out === null) return []

  const checkpoints: Checkpoint[] = []
  const prefix = `checkpoint:${sessionId}:`

  for (const line of out.split('\n').filter(Boolean)) {
    const parts = line.split('|')
    if (parts.length < 3) continue

    const ref = parts[0]
    const subject = parts[1]
    // git prefixes the message we passed with "On <branch>: " (or
    // "WIP on <branch>: "), so the checkpoint prefix appears mid-string —
    // startsWith never matched, silently hiding every checkpoint.
    const prefixIdx = subject.indexOf(prefix)
    if (prefixIdx === -1) continue

    const timestamp = Number(subject.slice(prefixIdx + prefix.length))
    if (isNaN(timestamp)) continue

    const numstat = await run(['stash', 'show', '--numstat', ref])
    const filesChanged = numstat ? numstat.split('\n').filter(Boolean).length : 0

    checkpoints.push({ ref, timestamp, sessionId, filesChanged })
  }

  return checkpoints.sort((a, b) => b.timestamp - a.timestamp)
}

async function gitRevertToCheckpoint(cwd: string, stashRef: string): Promise<boolean> {
  const run = async (args: string[]): Promise<boolean> => {
    try {
      await execFileP('git', ['-C', cwd, ...args], {
        windowsHide: true,
        timeout: 10000,
      })
      return true
    } catch {
      return false
    }
  }

  const applied = await run(['stash', 'apply', stashRef])
  if (!applied) return false

  const match = /stash@\{(\d+)\}/.exec(stashRef)
  if (!match) return true

  const targetIndex = Number(match[1])
  for (let i = targetIndex - 1; i >= 0; i--) {
    await run(['stash', 'drop', `stash@{${i}}`])
  }
  return true
}

async function gitCheckpointDiff(cwd: string, stashRef: string): Promise<string | null> {
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
  return await run(['stash', 'show', '-p', stashRef])
}

const CONFIG_HEADER =
  '# codehamr configuration — edited via Anvil\n' +
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
  ipcMain.handle('git:filechanges', async (_evt, cwd: string, abs: string) =>
    gitFileChanges(cwd, abs),
  )
  ipcMain.handle('git:filediff', async (_evt, cwd: string, abs: string) =>
    gitFileDiff(cwd, abs),
  )
  ipcMain.handle('git:status', async (_evt, cwd: string) => gitStatus(cwd))
  ipcMain.handle('git:branch', async (_evt, cwd: string) => gitBranch(cwd))
  // One-shot project summary for the empty-chat screen (branch, last commit,
  // tracked file count, working-tree change counts, diffstat).
  ipcMain.handle('project:stats', async (_evt, cwd: string) => projectStats(cwd))
  /** Initialize a git repo in cwd (git init + a baseline commit of an empty
   *  tree so HEAD exists and downstream git operations are well-defined). */
  ipcMain.handle('git:init', async (_evt, cwd: string): Promise<boolean> => {
    try {
      await execFileP('git', ['-C', cwd, 'init'], { windowsHide: true, timeout: 10000 })
      // Commit an empty tree so there's a valid HEAD; harmless if there's
      // nothing staged yet. --allow-empty keeps it from failing on a fresh dir.
      await execFileP(
        'git',
        ['-C', cwd, 'commit', '--allow-empty', '-m', 'Initial commit'],
        { windowsHide: true, timeout: 10000 },
      )
      return true
    } catch (e) {
      console.error('[git:init] failed', cwd, e)
      return false
    }
  })

  // Session checkpoints: git stash-based snapshots before each agent turn.
  ipcMain.handle(
    'checkpoint:create',
    async (_evt, cwd: string, sessionId: string) => gitCreateCheckpoint(cwd, sessionId),
  )
  ipcMain.handle(
    'checkpoint:list',
    async (_evt, cwd: string, sessionId: string) => gitListCheckpoints(cwd, sessionId),
  )
  ipcMain.handle(
    'checkpoint:revert',
    async (_evt, cwd: string, stashRef: string) => gitRevertToCheckpoint(cwd, stashRef),
  )
  ipcMain.handle(
    'checkpoint:diff',
    async (_evt, cwd: string, stashRef: string) => gitCheckpointDiff(cwd, stashRef),
  )

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

  // -------------------------------------------------------------------------
  // OAuth subscription linking (Phase 1: token acquisition only).
  // -------------------------------------------------------------------------
  ipcMain.handle('auth:start', async (_evt, provider: unknown) => {
    if (!isProviderId(provider)) throw new Error(`unknown provider: ${String(provider)}`)
    await oauth.start(provider)
    return { ok: true }
  })
  ipcMain.handle('auth:status', async () => oauth.status())
  ipcMain.handle('auth:logout', async (_evt, provider: unknown) => {
    if (!isProviderId(provider)) throw new Error(`unknown provider: ${String(provider)}`)
    await oauth.logout(provider)
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
      shellPath: resolveShell(),
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

  // -------------------------------------------------------------------------
  // Project memory: view / edit / download / load the out-of-repo, per-project
  // memory file the agent grows via its `remember` tool and reads into every
  // new chat's system prompt. All four actions go through memoryPath so the
  // desktop and the Go agent always touch the same file.
  // -------------------------------------------------------------------------

  // Read the current memory (empty string when the project has none yet).
  ipcMain.handle('memory:read', async (_evt, cwd: string) => {
    try {
      return { content: await readFile(memoryPath(cwd), 'utf8'), path: memoryPath(cwd) }
    } catch {
      return { content: '', path: memoryPath(cwd) }
    }
  })

  // Overwrite memory with user-edited text (the "load your own" and inline-edit
  // paths both land here). Temp+rename so a crash mid-write can't corrupt it,
  // mirroring the Go core's AppendMemory. An empty body removes the file, so
  // "clear memory" leaves no stale bytes to load next chat.
  ipcMain.handle('memory:write', async (_evt, cwd: string, content: unknown) => {
    if (typeof content !== 'string') throw new Error('memory content must be a string')
    const path = memoryPath(cwd)
    if (content === '') {
      await rm(path, { force: true })
      return
    }
    mkdirSync(join(app.getPath('appData'), 'codehamr', 'memory'), { recursive: true })
    const tmp = path + '.tmp'
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  })

  // Download: copy the current memory to a user-chosen file via the save
  // dialog. Returns the chosen path (or null if cancelled) so the UI can toast.
  ipcMain.handle('memory:export', async (_evt, cwd: string) => {
    if (!win) return null
    let content = ''
    try {
      content = await readFile(memoryPath(cwd), 'utf8')
    } catch {
      /* no memory yet: export an empty file so the action never silently no-ops */
    }
    const result = await dialog.showSaveDialog(win, {
      title: 'Export project memory',
      defaultPath: `codehamr-memory-${cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'project'}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, content, 'utf8')
    return result.filePath
  })

  // Load your own: pick a Markdown/text file and return its contents for the UI
  // to stage in the editor (the user reviews, then Saves via memory:write).
  ipcMain.handle('memory:import', async (_evt) => {
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: 'Load a memory file',
      properties: ['openFile'],
      filters: [{ name: 'Markdown / text', extensions: ['md', 'txt', 'markdown'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return await readFile(result.filePaths[0], 'utf8')
  })

  // Undo a just-saved fact: remove the newest memory line whose text matches
  // `fact` (the agent writes each as "- <YYYY-MM-DD> <fact>"). Trailing match on
  // the fact text tolerates the datestamp prefix without the renderer needing to
  // know the on-disk format. Removing only the LAST match keeps an earlier,
  // deliberately-kept duplicate intact. Returns true when a line was removed.
  ipcMain.handle('memory:forget', async (_evt, cwd: string, fact: unknown) => {
    if (typeof fact !== 'string' || fact.trim() === '') return false
    const path = memoryPath(cwd)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return false // nothing stored: nothing to undo
    }
    const target = fact.trim()
    const lines = raw.split('\n')
    let removed = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      // Match a bullet line ending in the fact text, ignoring the "- <date> "
      // prefix and any surrounding whitespace.
      if (lines[i].trim().replace(/^-\s*(\d{4}-\d{2}-\d{2}\s+)?/, '') === target) {
        removed = i
        break
      }
    }
    if (removed < 0) return false
    lines.splice(removed, 1)
    const next = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    if (next === '') {
      await rm(path, { force: true })
      return true
    }
    const tmp = path + '.tmp'
    await writeFile(tmp, next + '\n', 'utf8')
    await rename(tmp, path)
    return true
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

  // Appearance (theme, zoom) persists to userData so it survives dev restarts.
  ipcMain.handle('appearance:load', async () => readAppearance())

  ipcMain.handle('appearance:save', async (_evt, patch: AppearanceStore) => {
    const current = readAppearance()
    const merged = { ...current, ...patch }
    writeAppearance(merged)
  })

  // Scan an OpenAI-compatible endpoint's model list (GET /v1/models). Runs in
  // main to avoid the renderer's CSP and CORS. Ollama serves this too.
  ipcMain.handle('models:scan', async (_evt, url: string, key: string) => {
    const base = String(url).trim().replace(/\/+$/, '')
    if (!base) throw new Error('enter an endpoint URL first')
    // Mirror the agent's endpoint rule: a base with its own path (a provider
    // rooted at e.g. /api/paas/v4) gets /models appended; a bare host gets the
    // conventional /v1/models.
    let hasPath = false
    try {
      hasPath = new URL(base).pathname.replace(/\/+$/, '') !== ''
    } catch {
      /* unparseable URL — treat as a bare host */
    }
    const modelsUrl = `${base}${hasPath ? '' : '/v1'}/models`
    // Expand a whole-key ${VAR} reference against the env, matching the agent.
    const trimmedKey = String(key).trim()
    const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmedKey)
    const resolvedKey = m ? (process.env[m[1]] ?? '') : trimmedKey
    let res: Response
    try {
      res = await fetch(modelsUrl, {
        headers: resolvedKey ? { Authorization: `Bearer ${resolvedKey}` } : {},
        signal: AbortSignal.timeout(10_000),
      })
    } catch (e) {
      throw new Error(`could not reach ${base} (${(e as Error).message})`)
    }
    if (!res.ok) {
      throw new Error(`${modelsUrl} returned ${res.status} ${res.statusText}`)
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

  // Periodically check for updates every 6 hours
  setInterval(() => {
    void autoUpdater.checkForUpdates()
  }, 6 * 60 * 60 * 1000)
}

app.whenReady().then(() => {
  fixShellPath()
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
