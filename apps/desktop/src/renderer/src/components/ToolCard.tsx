import { useEffect, useRef, useState } from 'react'
import type { Decide, ToolItem, ToolStatus } from '../workspace/types'
import { numberDiffLines, gut } from '../workspace/diff'

const statusLabel: Record<ToolStatus, string> = {
  pending_approval: 'needs approval',
  running: 'running…',
  done: 'done',
  failed: 'failed',
  denied: 'denied',
}

/**
 * Per-tool accent color for the name label, so the eye can triage a transcript
 * at a glance: amber = shell, sky = read-only inspection, emerald = file
 * mutations, violet = planning. Full literal classes so Tailwind's JIT keeps
 * them.
 */
const toolColor: Record<string, string> = {
  bash: 'text-amber-400',
  read_file: 'text-sky-400',
  grep: 'text-sky-400',
  glob: 'text-sky-400',
  web_fetch: 'text-cyan-400',
  write_file: 'text-emerald-400',
  edit_file: 'text-emerald-400',
  multi_edit: 'text-emerald-400',
  todo_write: 'text-violet-400',
  remember: 'text-fuchsia-400',
}

const toolColorClass = (name: string): string => toolColor[name] ?? 'text-zinc-400'

/**
 * The file-mutation tools. Their diffs are the whole point of a coding
 * harness, so cards for these default to showing their diff — even when
 * grouped, where other tool cards stay collapsed.
 */
const isFileEditTool = (name: string): boolean =>
  name === 'write_file' || name === 'edit_file' || name === 'multi_edit'

/**
 * One-line summary shown in a tool card header. Each tool's most telling
 * argument: the command for bash, the pattern for grep/glob, the path for the
 * file tools, the url for web_fetch, an item count for todo_write. Falls back
 * to the raw args so an unknown tool still shows something readable.
 */
function toolSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'bash':
      return String(args.cmd ?? '')
    case 'grep':
    case 'glob': {
      const pattern = String(args.pattern ?? '')
      const scope = args.path ? ` in ${args.path}` : ''
      const include = args.include ? ` (${args.include})` : ''
      return `${pattern}${include}${scope}`
    }
    case 'web_fetch':
      return String(args.url ?? '')
    case 'multi_edit': {
      const path = String(args.path ?? '')
      const n = Array.isArray(args.edits) ? args.edits.length : 0
      return n ? `${path} (${n} edit${n === 1 ? '' : 's'})` : path
    }
    case 'todo_write': {
      const n = Array.isArray(args.todos) ? args.todos.length : 0
      return `${n} item${n === 1 ? '' : 's'}`
    }
    case 'remember':
      return String(args.fact ?? '')
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(args.path ?? '')
    default:
      return String(args.path ?? args.url ?? JSON.stringify(args))
  }
}

export function ToolCard({
  item,
  onDecide,
  onOpenFile,
  cwd,
  embedded = false,
}: {
  item: Extract<ToolItem, { kind: 'tool' }>
  onDecide: Decide
  onOpenFile: (path: string) => void
  cwd?: string
  embedded?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(isFileEditTool(item.name))
  const summary = toolSummary(item.name, item.args)
  // Live bash output: auto-follow the tail while chunks stream in, like a
  // terminal. Only present for a running bash call; cleared on tool_result.
  const liveRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = liveRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [item.liveOutput])
  // Undo state for a remember card: once forgotten, the fact line is stripped
  // from the out-of-repo memory file and the card reflects it.
  const [forgotten, setForgotten] = useState(false)
  const [forgetting, setForgetting] = useState(false)

  return (
    <div
      className={`${embedded ? '' : 'max-w-[var(--msg-max,85%)]'} rounded-lg border border-zinc-800 bg-zinc-900/60 text-sm`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`font-mono text-xs ${toolColorClass(item.name)}`}>{item.name}</span>
        <span className="truncate font-mono text-xs text-zinc-400">{summary}</span>
        {item.background && (
          <span
            title="a background process is still running after the shell exited"
            className="shrink-0 rounded bg-sky-950 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
          >
            background
          </span>
        )}
        <span
          className={`ml-auto shrink-0 text-xs ${
            item.status === 'failed' || item.status === 'denied'
              ? 'text-red-400'
              : item.status === 'done'
                ? 'text-emerald-400'
                : 'text-zinc-400'
          }`}
        >
          {statusLabel[item.status]}
        </span>
      </button>

      {item.status === 'pending_approval' && (
        <div className="flex gap-2 border-t border-zinc-800 px-3 py-2">
          <button
            onClick={() => onDecide(item.id, 'allow')}
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium hover:bg-emerald-600"
          >
            Allow
          </button>
          <button
            onClick={() => onDecide(item.id, 'allow', 'session')}
            title={`don't ask again for ${item.name} this session`}
            className="rounded bg-emerald-900 px-3 py-1 text-xs hover:bg-emerald-800"
          >
            Always allow {item.name}
          </button>
          <button
            onClick={() => onDecide(item.id, 'deny')}
            className="ml-auto rounded bg-zinc-700 px-3 py-1 text-xs hover:bg-zinc-600"
          >
            Deny
          </button>
        </div>
      )}

      {open && item.diff && <DiffBlock diff={item.diff} onOpenFile={onOpenFile} />}

      {/* remember: the saved fact is short and worth seeing at a glance, so
          show it inline (not hidden behind the output toggle) with a note that
          it persists into future chats. */}
      {item.name === 'remember' && typeof item.args.fact === 'string' && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <div className="flex items-start gap-2">
            <span
              className={`mt-0.5 shrink-0 ${forgotten ? 'text-zinc-600' : 'text-fuchsia-400'}`}
              title={forgotten ? 'removed from project memory' : 'saved to project memory'}
            >
              ★
            </span>
            <p
              className={`font-mono text-xs leading-relaxed whitespace-pre-wrap ${
                forgotten ? 'text-zinc-500 line-through' : 'text-zinc-200'
              }`}
            >
              {String(item.args.fact)}
            </p>
          </div>
          {item.status === 'done' && (
            <div className="mt-1.5 flex items-center gap-2 pl-6">
              <p className="text-[10px] text-zinc-500">
                {forgotten
                  ? 'removed from project memory'
                  : 'saved to project memory — loads into every future chat for this project'}
              </p>
              {!forgotten && cwd && (
                <button
                  disabled={forgetting}
                  onClick={() => {
                    setForgetting(true)
                    void window.codehamr
                      .forgetMemory(cwd, String(item.args.fact))
                      .then((ok) => setForgotten(ok))
                      .finally(() => setForgetting(false))
                  }}
                  className="rounded px-1.5 py-0.5 text-[10px] text-fuchsia-300 hover:bg-fuchsia-950/50 disabled:opacity-40"
                  title="remove this fact from project memory"
                >
                  {forgetting ? 'undoing…' : 'Undo'}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {open && item.status === 'running' && item.liveOutput !== undefined && (
        <pre
          ref={liveRef}
          className="max-h-64 overflow-auto border-t border-zinc-800 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-zinc-400"
        >
          {item.liveOutput}
          <span className="animate-pulse text-zinc-500">▍</span>
        </pre>
      )}

      {open && item.output !== undefined && (
        <pre className="max-h-64 overflow-auto border-t border-zinc-800 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-zinc-300">
          {item.output}
        </pre>
      )}
    </div>
  )
}

/**
 * ToolGroupCard: consecutive tool calls collapse into one summary row —
 * agents often chain many reads/greps back to back and the transcript drowns
 * in cards. Click to reveal the individual calls. Forced open while any call
 * inside still needs approval or is running (Allow/Deny must stay reachable).
 */
export function ToolGroupCard({
  tools,
  onDecide,
  onOpenFile,
  cwd,
}: {
  tools: ToolItem[]
  onDecide: Decide
  onOpenFile: (path: string) => void
  cwd?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (tools.length === 1) {
    return <ToolCard item={tools[0]} onDecide={onDecide} onOpenFile={onOpenFile} cwd={cwd} />
  }
  const active = tools.some((t) => t.status === 'pending_approval' || t.status === 'running')
  const expanded = open || active
  const failed = tools.filter((t) => t.status === 'failed' || t.status === 'denied').length
  const uniqueNames = [...new Set(tools.map((t) => t.name))]
  const hasBackground = tools.some((t) => t.background)
  // File edits stay visible even while the group is collapsed — hiding a diff
  // behind a fold is the wrong default for a coding harness. Each edit card
  // still toggles its own diff off when tapped.
  const editTools = tools.filter((t) => isFileEditTool(t.name))
  const showEditsOnly = !expanded && editTools.length > 0
  return (
    <div className="max-w-[var(--msg-max,85%)] rounded-lg border border-zinc-800 bg-zinc-900/40 text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs text-zinc-500">{expanded ? '▾' : '▸'}</span>
        <span className="text-xs text-zinc-300">
          {tools.length} tool call{tools.length === 1 ? '' : 's'}
        </span>
        <span className="flex min-w-0 gap-1.5 truncate font-mono text-xs">
          {uniqueNames.map((n, i) => (
            <span key={n} className={toolColorClass(n)}>
              {n}
              {i < uniqueNames.length - 1 ? ',' : ''}
            </span>
          ))}
        </span>
        {hasBackground && (
          <span
            title="a background process is still running after the shell exited"
            className="shrink-0 rounded bg-sky-950 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
          >
            background
          </span>
        )}
        <span
          className={`ml-auto shrink-0 text-xs ${
            active ? 'text-zinc-400' : failed > 0 ? 'text-red-400' : 'text-emerald-400'
          }`}
        >
          {active ? 'working…' : failed > 0 ? `${failed} failed` : 'done'}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-zinc-800 p-2">
          {tools.map((t) => (
            <ToolCard key={t.id} item={t} onDecide={onDecide} onOpenFile={onOpenFile} cwd={cwd} embedded />
          ))}
        </div>
      )}
      {showEditsOnly && (
        <div className="space-y-2 border-t border-zinc-800 p-2">
          {editTools.map((t) => (
            <ToolCard key={t.id} item={t} onDecide={onDecide} onOpenFile={onOpenFile} cwd={cwd} embedded />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * DiffBlock: colored unified diff, auto-expanded — seeing what the agent
 * changed is the harness's whole point. Long diffs scroll inside the card.
 * A two-column gutter (old · new line numbers) is derived from the @@ hunk
 * headers, so a reviewer can point at an exact line the way an editor does.
 */
function DiffBlock({
  diff,
  onOpenFile,
}: {
  diff: { path: string; unifiedDiff: string }
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const rows = numberDiffLines(diff.unifiedDiff)
  return (
    <div className="border-t border-zinc-800 px-3 pt-1.5 pb-3">
      <button
        onClick={() => onOpenFile(diff.path)}
        title="open this file in the viewer"
        className="pb-1.5 font-mono text-xs text-sky-400 hover:underline"
      >
        {diff.path}
      </button>
      {/* Inset, rounded panel on the fixed code palette (dark on dark themes,
          light on light) — see --code-* / --diff-* in styles.css. */}
      <div
        className="max-h-80 overflow-auto rounded-lg border font-mono text-xs leading-5"
        style={{
          background: 'var(--code-bg)',
          color: 'var(--code-fg)',
          borderColor: 'var(--code-border)',
        }}
      >
        {rows.map((row, i) => {
          let style: React.CSSProperties | undefined
          if (row.kind === 'add')
            style = { background: 'var(--diff-add-bg)', color: 'var(--diff-add-fg)' }
          else if (row.kind === 'del')
            style = { background: 'var(--diff-del-bg)', color: 'var(--diff-del-fg)' }
          else if (row.kind === 'hunk') style = { color: 'var(--diff-hunk-fg)' }
          else if (row.kind === 'meta') style = { color: 'var(--diff-meta-fg)' }
          return (
            <div key={i} className="flex" style={style}>
              <span
                className="sticky left-0 shrink-0 border-r px-1.5 text-right whitespace-pre select-none tabular-nums"
                style={{
                  background: 'var(--code-gutter-bg)',
                  color: 'var(--code-gutter-fg)',
                  borderColor: 'var(--code-border)',
                }}
              >
                {gut(row.oldNo)} {gut(row.newNo)}
              </span>
              <span className="flex-1 px-2 break-words whitespace-pre-wrap">{row.text || ' '}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
