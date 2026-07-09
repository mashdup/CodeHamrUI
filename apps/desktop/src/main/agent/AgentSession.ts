/**
 * AgentSession owns one `codehamr --json` child process for one workspace:
 * spawn/kill lifecycle plus the NDJSON protocol bridge over its stdio.
 *
 * stdout → line-split → zod-parse (protocol) → onEvent callback
 * command → encode → stdin
 *
 * No network sockets anywhere: stdio only.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  parseAgentLine,
  encodeCommand,
  type AgentEvent,
  type Command,
} from '@codehamr-ui/protocol'

export interface AgentSessionOptions {
  /** Absolute path to the codehamr binary. */
  binaryPath: string
  /** Workspace directory the agent runs in (where .codehamr/ lives). */
  cwd: string
  onEvent: (event: AgentEvent) => void
  /** Raw stdout lines that failed protocol parsing — logged, never fatal. */
  onNoise?: (line: string) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}

export class AgentSession {
  private child: ChildProcessWithoutNullStreams | null = null
  /**
   * Set by stop(): an exit we asked for (workspace switch, window close) must
   * not surface as a crash notice in the renderer.
   */
  private stopping = false

  constructor(private readonly opts: AgentSessionOptions) {}

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  start(): void {
    if (this.running) return
    const child = spawn(this.opts.binaryPath, ['--json'], {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEHAMR_NO_UPDATE_CHECK: '1',
        // Mitigation for golang/go#76614-class runtime crashes on Windows
        // 26xxx kernels ("traceback did not unwind completely" during GC):
        // async preemption is the other known trigger of bad-time unwinds on
        // Windows; the binary itself is built with GOEXPERIMENT=nogreenteagc.
        GODEBUG: 'asyncpreemptoff=1',
      },
      windowsHide: true,
    })
    this.child = child

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const event = parseAgentLine(line)
      if (event) this.opts.onEvent(event)
      else if (line.trim() !== '') this.opts.onNoise?.(line)
    })

    // stderr is the agent's human-facing diagnostics channel; surface as noise.
    const errLines = createInterface({ input: child.stderr })
    errLines.on('line', (line) => this.opts.onNoise?.(`[stderr] ${line}`))

    child.on('exit', (code, signal) => {
      this.child = null
      if (this.stopping) return // we killed it on purpose; not a crash
      this.opts.onExit(code, signal)
    })
    child.on('error', (err) => {
      // Spawn failure (bad path, no permission): report as exit, not a throw.
      this.child = null
      this.opts.onNoise?.(`[spawn error] ${err.message}`)
      if (!this.stopping) this.opts.onExit(null, null)
    })
  }

  send(cmd: Command): void {
    if (!this.child) throw new Error('agent not running')
    this.child.stdin.write(encodeCommand(cmd))
  }

  stop(): void {
    if (!this.child) return
    this.stopping = true
    this.child.stdin.end()
    this.child.kill()
    this.child = null
  }
}
