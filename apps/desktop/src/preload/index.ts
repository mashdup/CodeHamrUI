import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron'
import type { AgentEvent, Command, ConfigFile, PermissionMode } from '@codehamr-ui/protocol'

const api = {
  /** Host platform, so the custom title bar can reserve space for the native
   *  window controls (mac traffic lights on the left, Windows caption buttons
   *  on the right). */
  platform: process.platform,
  /** UI scale (accessibility) — Electron zoom scales the whole renderer. */
  setZoom: (factor: number): Promise<void> => {
    webFrame.setZoomFactor(factor)
    return Promise.resolve()
  },
  /** Re-tint the Windows caption-button overlay to match the theme. */
  setTitleBarOverlay: (color: string, symbolColor: string): Promise<void> =>
    ipcRenderer.invoke('titlebar:overlay', color, symbolColor),
  /**
   * Absolute path of a dropped File. Electron removed the `File.path`
   * property in v32; webUtils is the supported replacement and must be
   * called from the preload.
   */
  getFilePath: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return '' // pasted/synthetic files have no filesystem path
    }
  },
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick'),
  readConfig: (cwd: string): Promise<ConfigFile | null> => ipcRenderer.invoke('config:read', cwd),
  writeConfig: (cwd: string, cfg: ConfigFile): Promise<void> =>
    ipcRenderer.invoke('config:write', cwd, cfg),
  listDir: (
    root: string,
    dir: string,
  ): Promise<{ name: string; path: string; isDir: boolean }[]> =>
    ipcRenderer.invoke('fs:list', root, dir),
  readTextFile: (
    root: string,
    file: string,
  ): Promise<
    | { kind: 'text'; content: string; truncated: boolean; size: number }
    | { kind: 'binary' | 'too-large'; size: number }
  > => ipcRenderer.invoke('fs:read', root, file),
  readPreview: (
    root: string,
    file: string,
  ): Promise<
    | { kind: 'text' | 'markdown'; content: string; truncated: boolean; size: number }
    | { kind: 'image'; mime: string; dataB64: string }
    | { kind: 'pdf' | 'docx'; dataB64: string }
    | { kind: 'binary' | 'too-large'; size: number }
  > => ipcRenderer.invoke('preview:read', root, file),
  scanModels: (url: string, key: string): Promise<string[]> =>
    ipcRenderer.invoke('models:scan', url, key),
  /** OAuth subscription linking (Claude / Codex). Phase 1: token acquisition. */
  authStart: (provider: 'claude' | 'codex'): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('auth:start', provider),
  authStatus: (): Promise<{ claude: boolean; codex: boolean }> =>
    ipcRenderer.invoke('auth:status'),
  authLogout: (provider: 'claude' | 'codex'): Promise<void> =>
    ipcRenderer.invoke('auth:logout', provider),
  gitDiffStat: (cwd: string): Promise<{ added: number; removed: number } | null> =>
    ipcRenderer.invoke('git:diffstat', cwd),
  gitBranch: (cwd: string): Promise<string | null> => ipcRenderer.invoke('git:branch', cwd),
  /** Per-line git change markers for the file viewer's gutter. */
  gitFileChanges: (
    cwd: string,
    abs: string,
  ): Promise<{ added: number[]; modified: number[]; removedBefore: number[] } | null> =>
    ipcRenderer.invoke('git:filechanges', cwd, abs),
  /** Full unified diff of one file vs HEAD, for the preview's Diff view. */
  gitFileDiff: (cwd: string, abs: string): Promise<string | null> =>
    ipcRenderer.invoke('git:filediff', cwd, abs),
  /** Working-tree git changes for the file tree's indicators. Absolute paths. */
  gitStatus: (
    cwd: string,
  ): Promise<{ modified: string[]; added: string[]; untracked: string[] } | null> =>
    ipcRenderer.invoke('git:status', cwd),
  /** Session checkpoints: git stash-based snapshots before each agent turn. */
  checkpointCreate: (cwd: string, sessionId: string): Promise<string | null> =>
    ipcRenderer.invoke('checkpoint:create', cwd, sessionId),
  checkpointList: (
    cwd: string,
    sessionId: string,
  ): Promise<{ ref: string; timestamp: number; sessionId: string; filesChanged: number }[]> =>
    ipcRenderer.invoke('checkpoint:list', cwd, sessionId),
  checkpointRevert: (cwd: string, stashRef: string): Promise<boolean> =>
    ipcRenderer.invoke('checkpoint:revert', cwd, stashRef),
  checkpointDiff: (cwd: string, stashRef: string): Promise<string | null> =>
    ipcRenderer.invoke('checkpoint:diff', cwd, stashRef),
  /** System clipboard, for the composer's right-click menu. */
  readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
  /** Open a URL in the user's default system browser. */
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('browser:openExternal', url),
  getMode: (cwd: string): Promise<PermissionMode> => ipcRenderer.invoke('mode:get', cwd),
  setMode: (cwd: string, mode: PermissionMode): Promise<void> =>
    ipcRenderer.invoke('mode:set', cwd, mode),
  loadAppearance: (): Promise<{ theme?: { name: string; custom?: { bg: string; accent: string } }; zoom?: number }> =>
    ipcRenderer.invoke('appearance:load'),
  saveAppearance: (patch: { theme?: { name: string; custom?: { bg: string; accent: string } }; zoom?: number }): Promise<void> =>
    ipcRenderer.invoke('appearance:save', patch),
  listPresets: (): Promise<{ defaultPreset: string | null; presets: Record<string, ConfigFile> }> =>
    ipcRenderer.invoke('presets:list'),
  savePreset: (name: string, cfg: ConfigFile, setDefault: boolean): Promise<void> =>
    ipcRenderer.invoke('presets:save', name, cfg, setDefault),
  deletePreset: (name: string): Promise<void> => ipcRenderer.invoke('presets:delete', name),
  setDefaultPreset: (name: string | null): Promise<void> =>
    ipcRenderer.invoke('presets:setDefault', name),
  readTranscript: (cwd: string): Promise<unknown> => ipcRenderer.invoke('transcript:read', cwd),
  listChats: (
    cwd: string,
  ): Promise<{ id: string; title: string; updatedAt: number; current: boolean }[]> =>
    ipcRenderer.invoke('chats:list', cwd),
  newChatSession: (cwd: string): Promise<string> => ipcRenderer.invoke('chats:new', cwd),
  switchChat: (cwd: string, id: string): Promise<void> =>
    ipcRenderer.invoke('chats:switch', cwd, id),
  deleteChat: (cwd: string, id: string): Promise<void> =>
    ipcRenderer.invoke('chats:delete', cwd, id),
  writeTranscript: (cwd: string, items: unknown): Promise<void> =>
    ipcRenderer.invoke('transcript:write', cwd, items),
  /** Project memory (out-of-repo, per-project): view, edit, download, load. */
  readMemory: (cwd: string): Promise<{ content: string; path: string }> =>
    ipcRenderer.invoke('memory:read', cwd),
  writeMemory: (cwd: string, content: string): Promise<void> =>
    ipcRenderer.invoke('memory:write', cwd, content),
  exportMemory: (cwd: string): Promise<string | null> =>
    ipcRenderer.invoke('memory:export', cwd),
  importMemory: (): Promise<string | null> => ipcRenderer.invoke('memory:import'),
  forgetMemory: (cwd: string, fact: string): Promise<boolean> =>
    ipcRenderer.invoke('memory:forget', cwd, fact),
  startAgent: (cwd: string): Promise<{ running: boolean; seededFrom: string | null }> =>
    ipcRenderer.invoke('agent:start', cwd),
  stopAgent: (cwd: string): Promise<void> => ipcRenderer.invoke('agent:stop', cwd),
  send: (cwd: string, cmd: Command): Promise<void> => ipcRenderer.invoke('agent:send', cwd, cmd),
  onEvent: (cb: (payload: { cwd: string; event: AgentEvent }) => void): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { cwd: string; event: AgentEvent },
    ): void => cb(payload)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  },
  onNoise: (cb: (payload: { cwd: string; line: string }) => void): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { cwd: string; line: string },
    ): void => cb(payload)
    ipcRenderer.on('agent:noise', handler)
    return () => ipcRenderer.removeListener('agent:noise', handler)
  },
  onFsChanged: (cb: (payload: { cwd: string; dirs: string[] }) => void): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      payload: { cwd: string; dirs: string[] },
    ): void => cb(payload)
    ipcRenderer.on('fs:changed', handler)
    return () => ipcRenderer.removeListener('fs:changed', handler)
  },
  /** Fires when the workspace's .git metadata changes (commit, checkout, add,
   *  external git operations) — signal to re-fetch git status/diff/gutter
   *  markers, since none of that necessarily touches a tracked file's mtime. */
  onGitChanged: (cb: (payload: { cwd: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: { cwd: string }): void => cb(payload)
    ipcRenderer.on('git:changed', handler)
    return () => ipcRenderer.removeListener('git:changed', handler)
  },
  onUpdateReady: (cb: (version: string) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, version: string): void => cb(version)
    ipcRenderer.on('app:update-ready', handler)
    return () => ipcRenderer.removeListener('app:update-ready', handler)
  },
  installUpdate: (): Promise<void> => ipcRenderer.invoke('app:install-update'),
  onExit: (
    cb: (info: { cwd: string; code: number | null; signal: string | null }) => void,
  ): (() => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      info: { cwd: string; code: number | null; signal: string | null },
    ): void => cb(info)
    ipcRenderer.on('agent:exit', handler)
    return () => ipcRenderer.removeListener('agent:exit', handler)
  },
}

export type CodeHamrApi = typeof api

contextBridge.exposeInMainWorld('codehamr', api)
