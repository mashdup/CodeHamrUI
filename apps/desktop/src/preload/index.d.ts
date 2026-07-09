import type { CodeHamrApi } from './index'

declare global {
  interface Window {
    codehamr: CodeHamrApi
  }
}

export {}
