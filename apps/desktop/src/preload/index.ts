import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, Command, ConfigFile } from '@codehamr-ui/protocol'

const api = {
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
  listPresets: (): Promise<{ defaultPreset: string | null; presets: Record<string, ConfigFile> }> =>
    ipcRenderer.invoke('presets:list'),
  savePreset: (name: string, cfg: ConfigFile, setDefault: boolean): Promise<void> =>
    ipcRenderer.invoke('presets:save', name, cfg, setDefault),
  deletePreset: (name: string): Promise<void> => ipcRenderer.invoke('presets:delete', name),
  setDefaultPreset: (name: string | null): Promise<void> =>
    ipcRenderer.invoke('presets:setDefault', name),
  readTranscript: (cwd: string): Promise<unknown> => ipcRenderer.invoke('transcript:read', cwd),
  writeTranscript: (cwd: string, items: unknown): Promise<void> =>
    ipcRenderer.invoke('transcript:write', cwd, items),
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
