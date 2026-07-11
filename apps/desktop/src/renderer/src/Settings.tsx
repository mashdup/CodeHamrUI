import { useEffect, useState } from 'react'
import type { ConfigFile } from '@codehamr-ui/protocol'
import {
  SCHEMES,
  applyTheme,
  applyZoom,
  loadThemeChoice,
  loadZoom,
  type ThemeChoice,
} from './themes'

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
  // Transient "scan endpoint for models" UI state (never persisted).
  scanning?: boolean
  scanned?: string[]
  scanError?: string
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
  const [presets, setPresets] = useState<Record<string, ConfigFile>>({})
  const [defaultPreset, setDefaultPreset] = useState<string | null>(null)
  const [selectedPreset, setSelectedPreset] = useState('')
  const [presetName, setPresetName] = useState('')

  const configToForm = (cfg: ConfigFile): void => {
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
  }

  useEffect(() => {
    void window.codehamr.readConfig(workspace).then((cfg) => {
      if (!cfg) {
        setError('No config found yet — send one message first so the agent creates it.')
        setRows([])
        return
      }
      configToForm(cfg)
    })
    void window.codehamr.listPresets().then((store) => {
      setPresets(store.presets)
      setDefaultPreset(store.defaultPreset)
    })
  }, [workspace])

  const update = (i: number, patch: Partial<ProfileRow>): void => {
    setRows((prev) => prev!.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const scanModels = async (i: number): Promise<void> => {
    const row = rows?.[i]
    if (!row) return
    update(i, { scanning: true, scanError: undefined, scanned: undefined })
    try {
      const models = await window.codehamr.scanModels(row.url, row.key)
      update(i, {
        scanning: false,
        scanned: models,
        scanError: models.length ? undefined : 'endpoint returned no models',
      })
    } catch (e) {
      update(i, { scanning: false, scanError: e instanceof Error ? e.message : String(e) })
    }
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

  /** Fold the form rows back into a validated config, or set error and return null. */
  const buildConfig = (): ConfigFile | null => {
    if (!rows) return null
    const models: ConfigFile['models'] = {}
    for (const r of rows) {
      const name = r.name.trim()
      if (!name) return setError('every profile needs a name'), null
      if (models[name]) return setError(`duplicate profile name "${name}"`), null
      if (!r.llm.trim() || !r.url.trim())
        return setError(`profile "${name}": llm and url are required`), null
      const ctx = r.contextSize.trim() === '' ? undefined : Number(r.contextSize)
      if (ctx !== undefined && (!Number.isInteger(ctx) || ctx <= 0)) {
        return setError(`profile "${name}": context size must be a positive integer (or empty)`), null
      }
      models[name] = { llm: r.llm.trim(), url: r.url.trim().replace(/\/+$/, ''), key: r.key, context_size: ctx }
    }
    if (Object.keys(models).length === 0) return setError('at least one profile is required'), null
    return { active: models[active] ? active : Object.keys(models)[0], models }
  }

  const save = async (): Promise<void> => {
    setError('')
    const cfg = buildConfig()
    if (!cfg) return
    setSaving(true)
    try {
      await window.codehamr.writeConfig(workspace, cfg)
      onSaved() // caller restarts the agent so the config is live
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const applyPreset = (name: string): void => {
    setSelectedPreset(name)
    const cfg = presets[name]
    if (cfg) {
      configToForm(cfg)
      setError('')
    }
  }

  const saveAsPreset = async (): Promise<void> => {
    setError('')
    const name = presetName.trim()
    if (!name) return setError('give the preset a name first')
    const cfg = buildConfig()
    if (!cfg) return
    // First preset ever becomes the default automatically — that's the
    // "just work on my next project" path.
    const makeDefault = Object.keys(presets).length === 0
    await window.codehamr.savePreset(name, cfg, makeDefault)
    setPresets((prev) => ({ ...prev, [name]: cfg }))
    if (makeDefault) setDefaultPreset(name)
    setSelectedPreset(name)
    setPresetName('')
  }

  // Save the current form back onto the loaded preset (keeping its default
  // flag). "Save & restart agent" only writes the project config; this is how
  // edits flow back to the preset itself.
  const updatePreset = async (): Promise<void> => {
    if (!selectedPreset) return
    setError('')
    const cfg = buildConfig()
    if (!cfg) return
    await window.codehamr.savePreset(selectedPreset, cfg, defaultPreset === selectedPreset)
    setPresets((prev) => ({ ...prev, [selectedPreset]: cfg }))
  }

  const deleteSelected = async (): Promise<void> => {
    if (!selectedPreset) return
    await window.codehamr.deletePreset(selectedPreset)
    setPresets((prev) => {
      const next = { ...prev }
      delete next[selectedPreset]
      return next
    })
    if (defaultPreset === selectedPreset) setDefaultPreset(null)
    setSelectedPreset('')
  }

  const toggleDefault = async (): Promise<void> => {
    if (!selectedPreset) return
    const next = defaultPreset === selectedPreset ? null : selectedPreset
    await window.codehamr.setDefaultPreset(next)
    setDefaultPreset(next)
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
        <p className="mb-3 text-xs text-zinc-500">
          Tip: set <code className="rounded bg-zinc-800 px-1">key</code> to{' '}
          <code className="rounded bg-zinc-800 px-1">{'${MY_ENV_VAR}'}</code> to read the secret from
          the environment instead of storing it on disk. Saving restarts the agent.
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-950/50 p-2">
          <span className="text-xs text-zinc-400">Presets</span>
          <select
            value={selectedPreset}
            onChange={(e) => applyPreset(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs outline-none"
          >
            <option value="">load a saved config…</option>
            {Object.keys(presets)
              .sort()
              .map((name) => (
                <option key={name} value={name}>
                  {name}
                  {defaultPreset === name ? ' ★' : ''}
                </option>
              ))}
          </select>
          {selectedPreset && (
            <>
              <label className="flex items-center gap-1 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={defaultPreset === selectedPreset}
                  onChange={() => void toggleDefault()}
                />
                default for new projects
              </label>
              <button
                onClick={() => void updatePreset()}
                title={`overwrite the "${selectedPreset}" preset with the current form`}
                className="rounded bg-sky-900/60 px-2 py-0.5 text-xs text-sky-200 hover:bg-sky-900"
              >
                update “{selectedPreset}”
              </button>
              <button
                onClick={() => void deleteSelected()}
                className="rounded px-2 py-0.5 text-xs text-red-400 hover:bg-red-950"
              >
                delete
              </button>
            </>
          )}
          <span className="mx-1 h-4 w-px bg-zinc-700" />
          <input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder="save current as…"
            className="w-36 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs outline-none focus:border-zinc-500"
          />
          <button
            onClick={() => void saveAsPreset()}
            disabled={presetName.trim() === '' || rows === null || rows.length === 0}
            className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700 disabled:opacity-40"
          >
            save preset
          </button>
        </div>

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
                  <div>
                    <div className="flex items-end gap-1.5">
                      <div className="flex-1">
                        <Field label="model (llm)" value={r.llm} onChange={(v) => update(i, { llm: v })} placeholder="qwen3.6:27b / gpt-5.5" />
                      </div>
                      <button
                        onClick={() => void scanModels(i)}
                        disabled={r.scanning || !r.url.trim()}
                        title={r.url.trim() ? 'list the models this endpoint offers' : 'enter the endpoint URL first'}
                        className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700 disabled:opacity-40"
                      >
                        {r.scanning ? 'Scanning…' : 'Scan'}
                      </button>
                    </div>
                    {r.scanError && <p className="mt-1 text-[10px] text-red-400">{r.scanError}</p>}
                    {r.scanned && r.scanned.length > 0 && (
                      <select
                        value=""
                        onChange={(e) => e.target.value && update(i, { llm: e.target.value })}
                        className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs outline-none"
                      >
                        <option value="">{r.scanned.length} models found — pick one…</option>
                        {r.scanned.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
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

/**
 * AppearanceModal: theme + accessibility, opened from the workspace bar (not
 * the per-project model settings — these apply to the whole app, live).
 */
export function AppearanceModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeChoice>(() => loadThemeChoice())
  const [zoom, setZoom] = useState(() => loadZoom())
  const pickTheme = (choice: ThemeChoice): void => {
    setTheme(choice)
    applyTheme(choice)
  }
  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[95vw] rounded-lg border border-zinc-700 bg-zinc-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center">
          <h2 className="text-sm font-semibold">Appearance</h2>
          <span className="ml-2 text-xs text-zinc-500">whole app, applies immediately</span>
          <button onClick={onClose} className="ml-auto rounded px-2 text-zinc-400 hover:bg-zinc-800">
            ✕
          </button>
        </div>
        <div className="space-y-4">
          <div className="rounded border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="mb-2 text-xs font-semibold text-zinc-300">Theme</div>
            <ThemeRow theme={theme} onPick={pickTheme} />
          </div>
          <div className="rounded border border-zinc-800 bg-zinc-950/50 p-3">
            <div className="mb-2 text-xs font-semibold text-zinc-300">Accessibility</div>
            <label className="flex items-center gap-3 text-xs text-zinc-400">
              UI scale
              <input
                type="range"
                min={70}
                max={160}
                step={5}
                value={Math.round(zoom * 100)}
                onChange={(e) => {
                  const f = Number(e.target.value) / 100
                  setZoom(f)
                  applyZoom(f)
                }}
                className="w-56"
              />
              <span className="w-10 text-right tabular-nums text-zinc-300">
                {Math.round(zoom * 100)}%
              </span>
              {zoom !== 1 && (
                <button
                  onClick={() => {
                    setZoom(1)
                    applyZoom(1)
                  }}
                  className="rounded bg-zinc-800 px-2 py-0.5 hover:bg-zinc-700"
                >
                  reset
                </button>
              )}
            </label>
            <p className="mt-1.5 text-[10px] text-zinc-600">
              scales the entire interface — text, panels, spacing
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Theme swatches + custom color inputs. */
function ThemeRow({
  theme,
  onPick,
}: {
  theme: ThemeChoice
  onPick: (choice: ThemeChoice) => void
}): React.JSX.Element {
  const swatch = (s: (typeof SCHEMES)[number]): React.JSX.Element => (
    <button
      key={s.name}
      onClick={() => onPick({ name: s.name })}
      className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
        theme.name === s.name
          ? 'border-zinc-400 bg-zinc-800 text-zinc-100'
          : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
      }`}
    >
      <span className="h-3 w-3 rounded-sm border border-black/40" style={{ background: s.bg }} />
      <span className="h-3 w-3 rounded-full" style={{ background: s.accent }} />
      {s.label}
    </button>
  )
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {SCHEMES.filter((s) => !s.light).map(swatch)}
        <span className="mx-0.5 self-stretch border-l border-zinc-700" />
        <span className="text-[10px] text-zinc-600">light</span>
        {SCHEMES.filter((s) => s.light).map(swatch)}
        <button
          onClick={() =>
            onPick({
              name: 'custom',
              custom: theme.custom ?? { bg: '#161d21', accent: '#2dd4bf' },
            })
          }
          className={`rounded border px-2 py-1 text-xs ${
            theme.name === 'custom'
              ? 'border-zinc-400 bg-zinc-800 text-zinc-100'
              : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
          }`}
        >
          Custom…
        </button>
      </div>
      {theme.name === 'custom' && (
        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-zinc-400">
          <label className="flex items-center gap-1.5">
            surface
            <input
              type="color"
              value={theme.custom?.bg ?? '#161d21'}
              onChange={(e) =>
                onPick({
                  name: 'custom',
                  custom: { bg: e.target.value, accent: theme.custom?.accent ?? '#2dd4bf' },
                })
              }
              className="h-6 w-9 cursor-pointer rounded border border-zinc-700 bg-transparent"
            />
          </label>
          <label className="flex items-center gap-1.5">
            accent
            <input
              type="color"
              value={theme.custom?.accent ?? '#2dd4bf'}
              onChange={(e) =>
                onPick({
                  name: 'custom',
                  custom: { bg: theme.custom?.bg ?? '#161d21', accent: e.target.value },
                })
              }
              className="h-6 w-9 cursor-pointer rounded border border-zinc-700 bg-transparent"
            />
          </label>
          <span className="text-[10px] text-zinc-600">
            a light surface color makes a light theme — the whole ramp flips
          </span>
        </div>
      )}
    </>
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
