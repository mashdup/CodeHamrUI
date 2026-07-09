import { useEffect, useState } from 'react'
import type { ConfigFile } from '@codehamr-ui/protocol'

/**
 * Settings: the graphical .codehamr/config.yaml editor. Edits are staged in
 * local state; Save writes the file and restarts the agent so the new config
 * is actually live (the agent reads config once, at bootstrap).
 */

// Row-shaped editing model: a map is awkward to edit in place (renames), so
// profiles become an array and fold back to a map on save.
interface ProfileRow {
  name: string
  llm: string
  url: string
  key: string
  contextSize: string // free text while editing; parsed on save
}

export function SettingsPanel({
  workspace,
  onSaved,
  onClose,
}: {
  workspace: string
  onSaved: () => void
  onClose: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState<ProfileRow[] | null>(null)
  const [active, setActive] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.codehamr.readConfig(workspace).then((cfg) => {
      if (!cfg) {
        setError('No config found yet — send one message first so the agent creates it.')
        setRows([])
        return
      }
      setActive(cfg.active)
      setRows(
        Object.entries(cfg.models).map(([name, p]) => ({
          name,
          llm: p.llm,
          url: p.url,
          key: p.key ?? '',
          contextSize: p.context_size ? String(p.context_size) : '',
        })),
      )
    })
  }, [workspace])

  const update = (i: number, patch: Partial<ProfileRow>): void => {
    setRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const addProfile = (): void => {
    setRows((prev) => [
      ...(prev ?? []),
      { name: `profile${(prev?.length ?? 0) + 1}`, llm: '', url: 'https://', key: '', contextSize: '128000' },
    ])
  }

  const removeProfile = (i: number): void => {
    setRows((prev) => prev!.filter((_, idx) => idx !== i))
  }

  const save = async (): Promise<void> => {
    if (!rows) return
    setError('')
    // Fold rows back into the config map with light validation.
    const models: ConfigFile['models'] = {}
    for (const r of rows) {
      const name = r.name.trim()
      if (!name) return setError('every profile needs a name')
      if (models[name]) return setError(`duplicate profile name "${name}"`)
      if (!r.llm.trim() || !r.url.trim()) return setError(`profile "${name}": llm and url are required`)
      const ctx = r.contextSize.trim() === '' ? undefined : Number(r.contextSize)
      if (ctx !== undefined && (!Number.isInteger(ctx) || ctx <= 0)) {
        return setError(`profile "${name}": context size must be a positive integer (or empty)`)
      }
      models[name] = { llm: r.llm.trim(), url: r.url.trim().replace(/\/+$/, ''), key: r.key, context_size: ctx }
    }
    if (Object.keys(models).length === 0) return setError('at least one profile is required')
    const activeName = models[active] ? active : Object.keys(models)[0]

    setSaving(true)
    try {
      await window.codehamr.writeConfig(workspace, { active: activeName, models })
      onSaved() // caller restarts the agent so the config is live
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="max-h-[85vh] w-[720px] max-w-[95vw] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center">
          <h2 className="text-sm font-semibold">Model profiles</h2>
          <span className="ml-2 truncate font-mono text-xs text-zinc-500">
            {workspace}\.codehamr\config.yaml
          </span>
          <button onClick={onClose} className="ml-auto rounded px-2 text-zinc-400 hover:bg-zinc-800">
            ✕
          </button>
        </div>
        <p className="mb-4 text-xs text-zinc-500">
          Tip: set <code className="rounded bg-zinc-800 px-1">key</code> to{' '}
          <code className="rounded bg-zinc-800 px-1">{'${MY_ENV_VAR}'}</code> to read the secret from
          the environment instead of storing it on disk. Saving restarts the agent.
        </p>

        {rows === null ? (
          <p className="py-8 text-center text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="space-y-3">
            {rows.map((r, i) => (
              <div key={i} className="rounded border border-zinc-800 bg-zinc-950/50 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <input
                      type="radio"
                      name="active"
                      checked={active === r.name}
                      onChange={() => setActive(r.name)}
                    />
                    active
                  </label>
                  <input
                    value={r.name}
                    onChange={(e) => {
                      if (active === r.name) setActive(e.target.value)
                      update(i, { name: e.target.value })
                    }}
                    className="w-40 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-sm outline-none focus:border-zinc-500"
                    placeholder="profile name"
                  />
                  <button
                    onClick={() => removeProfile(i)}
                    disabled={rows.length === 1}
                    title={rows.length === 1 ? 'at least one profile is required' : 'remove profile'}
                    className="ml-auto rounded px-2 py-0.5 text-xs text-red-400 hover:bg-red-950 disabled:opacity-30"
                  >
                    remove
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="model (llm)" value={r.llm} onChange={(v) => update(i, { llm: v })} placeholder="qwen3.6:27b / gpt-5.5" />
                  <Field label="endpoint url" value={r.url} onChange={(v) => update(i, { url: v })} placeholder="http://localhost:11434" />
                  <Field label="api key" value={r.key} onChange={(v) => update(i, { key: v })} placeholder="empty for local · ${VAR} for env" password />
                  <Field label="context size (empty = server-managed)" value={r.contextSize} onChange={(v) => update(i, { contextSize: v })} placeholder="32768" />
                </div>
              </div>
            ))}
            <button onClick={addProfile} className="rounded bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700">
              + add profile
            </button>
          </div>
        )}

        {error && <p className="mt-3 rounded bg-red-950 px-3 py-2 text-xs text-red-300">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded bg-zinc-800 px-4 py-1.5 text-sm hover:bg-zinc-700">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || rows === null || rows.length === 0}
            className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-medium hover:bg-emerald-600 disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save & restart agent'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  password,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  password?: boolean
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-zinc-500">{label}</span>
      <input
        type={password ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-sm outline-none focus:border-zinc-500"
      />
    </label>
  )
}
