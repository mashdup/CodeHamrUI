import { contextBridge, ipcRenderer } from 'electron'

/**
 * Webview preload — injected into every <webview> in the live-preview BrowserPane.
 * The guest page runs with contextIsolation:true (Chromium default for webviews),
 * so the ONLY bridge into the page's main world is this contextBridge.
 *
 * We expose `codehamrDialog` with alert/confirm/prompt shims that call back into
 * the main process via sendSync. The main process stashes the IpcMainEvent,
 * forwards the request to the host renderer (which shows a custom in-app modal),
 * and sets event.returnValue asynchronously when the user responds — verified
 * to unblock the guest's JS with the correct return value.
 *
 * The host renderer (BrowserPane) overrides window.alert/confirm/prompt on
 * dom-ready to delegate here, so pages see native-looking synchronous dialogs.
 */
type DialogType = 'alert' | 'confirm' | 'prompt'

interface DialogPayload {
  type: DialogType
  message: string
  default: string
  url: string
}

const api = {
  alert: (message: string): void => {
    ipcRenderer.sendSync('webview:dialog', {
      type: 'alert',
      message: String(message ?? ''),
      default: '',
      url: location.href,
    } satisfies DialogPayload)
  },
  confirm: (message: string): boolean => {
    return ipcRenderer.sendSync('webview:dialog', {
      type: 'confirm',
      message: String(message ?? ''),
      default: '',
      url: location.href,
    } satisfies DialogPayload) === true
  },
  prompt: (message: string, defaultValue?: string): string | null => {
    const v = ipcRenderer.sendSync('webview:dialog', {
      type: 'prompt',
      message: String(message ?? ''),
      default: String(defaultValue ?? ''),
      url: location.href,
    } satisfies DialogPayload)
    // Browser prompt() returns null when cancelled, the string otherwise.
    return v === null ? null : String(v)
  },
}

contextBridge.exposeInMainWorld('codehamrDialog', api)
