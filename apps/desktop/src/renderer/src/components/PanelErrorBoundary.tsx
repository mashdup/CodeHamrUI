import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * PanelErrorBoundary: catches render crashes in a side panel (e.g. BrowserPane)
 * so a bug there can't blank the entire workspace. Shows a small inline
 * fallback with a reset button instead of a white/blank screen.
 */
export class PanelErrorBoundary extends Component<
  { children: ReactNode; onReset?: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[PanelErrorBoundary] caught:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 border-l border-zinc-800 bg-zinc-950 p-4 text-center text-zinc-400">
          <p className="text-sm">This panel crashed.</p>
          <p className="max-w-xs truncate text-xs text-zinc-600">{this.state.error.message}</p>
          <button
            onClick={() => {
              this.setState({ error: null })
              this.props.onReset?.()
            }}
            className="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
