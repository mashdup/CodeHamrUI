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
  // Which panel tab is showing: the model-profile editor or project memory.
  const [tab, setTab] = useState<'models' | 'memory' | 'accounts'>('models')
  // OAuth subscription linking (Accounts tab). Linking runs the browser OAuth
  // flow (Phase 1) AND materializes a subscription-backed profile in this
  // project's config.yaml whose key is a `${ENV}` reference resolved at
  // agent-spawn time to the live (auto-refreshed) OAuth token — turns route
  // through the in-process translating proxy (main/auth/proxy.ts) without the
  // token ever touching disk (Phase 2 — see OAUTH_PLAN.md).
  const SHOW_ACCOUNTS = true

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

  /**
   * A profile backed by an OAuth subscription (Claude/Codex) routes through the
   * in-process proxy, so its `key` is a `${CODEHAMR_OAUTH_*}` env reference and
   * its `url` is a throwaway 127.0.0.1 loopback port (rewritten every launch).
   * Detect that off the stable key reference (URL/path is a fallback) so the UI
   * can show "Connected to <Provider>" instead of the meaningless loopback URL.
   */
  const subscriptionLabel = (r: ProfileRow): string | null => {
    const key = r.key.trim()
    if (key === '${CODEHAMR_OAUTH_CLAUDE}') return 'Claude'
    if (key === '${CODEHAMR_OAUTH_CODEX}') return 'Codex'
    const m = /\/oauth\/(claude|codex)(?:\/|$)/.exec(r.url)
    if (m) return m[1] === 'claude' ? 'Claude' : 'Codex'
    return null
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
        className="max-h-[90vh] w-[920px] max-w-[95vw] overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center">
          <h2 className="text-sm font-semibold">Settings</h2>
          <span className="ml-2 truncate font-mono text-xs text-zinc-500">{workspace}</span>
          <button onClick={onClose} className="ml-auto rounded px-2 text-zinc-400 hover:bg-zinc-800">
            ✕
          </button>
        </div>

        <div className="mb-4 flex gap-1 border-b border-zinc-800">
          {(
            [
              ['models', 'Model profiles'],
              ['memory', 'Project memory'],
              ...(SHOW_ACCOUNTS ? ([['accounts', 'Accounts']] as const) : []),
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-xs font-medium ${
                tab === id
                  ? 'border-emerald-500 text-zinc-100'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'memory' ? (
          <MemorySection workspace={workspace} />
        ) : tab === 'accounts' && SHOW_ACCOUNTS ? (
          <AccountsSection workspace={workspace} onChanged={onSaved} />
        ) : (
          <>
            <p className="mb-3 text-xs text-zinc-500">
              <span className="font-mono text-zinc-600">{workspace}\.codehamr\config.yaml</span>
              {' — '}Tip: set <code className="rounded bg-zinc-800 px-1">key</code> to{' '}
              <code className="rounded bg-zinc-800 px-1">{'${MY_ENV_VAR}'}</code> to read the secret
              from the environment instead of storing it on disk. Saving restarts the agent.
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
                  {subscriptionLabel(r) ? (
                    <>
                      <div>
                        <div className="flex items-end gap-1.5">
                          <div className="flex-1">
                            <Field label="model (llm)" value={r.llm} onChange={(v) => update(i, { llm: v })} placeholder="claude-sonnet-4-5" />
                          </div>
                          <button
                            onClick={() => void scanModels(i)}
                            disabled={r.scanning}
                            title="list the models this subscription offers"
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
                      <div className="flex flex-col justify-end">
                        <span className="mb-1 block text-[10px] uppercase tracking-wide text-zinc-500">
                          endpoint
                        </span>
                        <div className="flex items-center gap-1.5 rounded border border-emerald-800/60 bg-emerald-950/30 px-2 py-1 text-sm text-emerald-300">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                          Connected to {subscriptionLabel(r)} subscription
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>
              </div>
            ))}
            <button onClick={addProfile} className="rounded bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700">
              + add profile
            </button>
          </div>
        )}

            {error && (
              <p className="mt-3 rounded bg-red-950 px-3 py-2 text-xs text-red-300">{error}</p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={onClose}
                className="rounded bg-zinc-800 px-4 py-1.5 text-sm hover:bg-zinc-700"
              >
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
          </>
        )}
      </div>
    </div>
  )
}



/**
 * AccountsSection: link/unlink a Claude or Codex subscription via OAuth. On
 * link, main runs the browser flow and writes a proxy-backed profile into this
 * project's config.yaml (key = a `${ENV}` reference to the live token); on
 * unlink it removes that profile. `onChanged` restarts the agent so the new
 * active profile + injected token take effect (Phase 2, Option A). Status comes
 * from auth:status. Tokens live encrypted under Electron userData, never in the
 * repo.
 */
const ACCOUNT_PROVIDERS = [
  { id: 'claude', label: 'Claude', hint: 'Anthropic subscription' },
  { id: 'codex', label: 'Codex', hint: 'ChatGPT / OpenAI subscription' },
] as const

function AccountsSection({
  workspace,
  onChanged,
}: {
  workspace: string
  onChanged: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState<{ claude: boolean; codex: boolean } | null>(null)
  const [busy, setBusy] = useState<'claude' | 'codex' | ''>('')
  const [error, setError] = useState('')
  // Paste-mode (Claude): after the browser opens, the provider shows a code the
  // user copies back. Non-null id means we're awaiting a paste for that provider.
  const [awaitingCode, setAwaitingCode] = useState<'claude' | 'codex' | null>(null)
  const [fallbackNote, setFallbackNote] = useState('')
  const [code, setCode] = useState('')

  const refresh = (): void => {
    void window.codehamr.authStatus().then(setStatus)
  }
  useEffect(refresh, [])

  const link = async (id: 'claude' | 'codex'): Promise<void> => {
    setError('')
    setFallbackNote('')
    setBusy(id)
    try {
      const { needsCode, fellBack } = await window.codehamr.authStart(id, workspace)
      if (needsCode) {
        // Either a paste-only provider, or the in-app window couldn't complete
        // and we fell back to the system browser. Wait for the pasted code.
        setAwaitingCode(id)
        setCode('')
        if (fellBack) {
          setFallbackNote(
            "Couldn't finish sign-in in the app window — opened your browser instead.",
          )
        }
        return
      }
      refresh()
      onChanged() // config now carries the proxy profile; restart the agent
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const submitCode = async (id: 'claude' | 'codex'): Promise<void> => {
    setError('')
    setBusy(id)
    try {
      await window.codehamr.authSubmitCode(id, code, workspace)
      setAwaitingCode(null)
      setFallbackNote('')
      setCode('')
      refresh()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  const cancelCode = (): void => {
    setAwaitingCode(null)
    setFallbackNote('')
    setCode('')
    setError('')
  }

  const unlink = async (id: 'claude' | 'codex'): Promise<void> => {
    setError('')
    try {
      await window.codehamr.authLogout(id, workspace)
      refresh()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-zinc-500">
        Link a subscription instead of pasting an API key. Tokens are stored
        encrypted on this machine (never in the project); a proxy-backed profile
        is added to this project so agent turns route through the subscription.
      </p>
      {error && (
        <div className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {ACCOUNT_PROVIDERS.map(({ id, label, hint }) => {
          const linked = status?.[id] ?? false
          const pending = busy === id
          const awaiting = awaitingCode === id
          return (
            <div
              key={id}
              className="flex flex-col gap-2 rounded border border-zinc-800 bg-zinc-950/50 px-3 py-2.5"
            >
              <div className="flex items-center gap-3">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-zinc-100">{label}</span>
                  <span className="text-[11px] text-zinc-500">{hint}</span>
                </div>
                <span
                  className={`ml-auto flex items-center gap-1.5 text-xs ${
                    linked ? 'text-emerald-400' : 'text-zinc-500'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      linked ? 'bg-emerald-400' : 'bg-zinc-600'
                    }`}
                  />
                  {awaiting
                    ? 'Waiting for code…'
                    : pending
                      ? 'Signing in…'
                      : linked
                        ? 'Linked'
                        : 'Not linked'}
                </span>
                {linked ? (
                  <button
                    onClick={() => void unlink(id)}
                    disabled={pending}
                    className="rounded border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    Unlink
                  </button>
                ) : awaiting ? (
                  <button
                    onClick={cancelCode}
                    className="rounded border border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-300 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    onClick={() => void link(id)}
                    disabled={pending}
                    className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium hover:bg-emerald-600 disabled:opacity-40"
                  >
                    {pending ? 'Linking…' : 'Link'}
                  </button>
                )}
              </div>
              {awaiting && (
                <div className="flex flex-col gap-1.5 border-t border-zinc-800 pt-2">
                  {fallbackNote && (
                    <span className="text-[11px] text-amber-400">{fallbackNote}</span>
                  )}
                  <span className="text-[11px] text-zinc-500">
                    Authorize in the browser, then paste the code it shows here.
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && code.trim()) void submitCode(id)
                      }}
                      autoFocus
                      placeholder="paste authorization code"
                      className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-xs outline-none focus:border-zinc-500"
                    />
                    <button
                      onClick={() => void submitCode(id)}
                      disabled={pending || code.trim() === ''}
                      className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium hover:bg-emerald-600 disabled:opacity-40"
                    >
                      {pending ? 'Linking…' : 'Submit'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * MemorySection: view / edit / download / load the project's persistent memory
 * - the out-of-repo facts the agent accumulates via its `remember` tool and
 * reads into every new chat. Facts show as a card list (date + text, newest
 * first); an Edit toggle drops to the raw text for hand-editing. Edits are
 * staged locally; Save writes the file (no agent restart needed - memory is
 * read fresh at the start of each chat).
 */
function MemorySection({ workspace }: { workspace: string }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState('') // last-persisted content, to detect edits
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    void window.codehamr.readMemory(workspace).then((m) => {
      setText(m.content)
      setSaved(m.content)
    })
  }, [workspace])

  const dirty = text !== null && text !== saved
  const facts = text !== null ? parseMemory(text) : []

  const save = async (): Promise<void> => {
    if (text === null) return
    setBusy(true)
    setStatus('')
    try {
      await window.codehamr.writeMemory(workspace, text)
      setSaved(text)
      setStatus('saved — loads into the next chat')
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const download = async (): Promise<void> => {
    setStatus('')
    try {
      const path = await window.codehamr.exportMemory(workspace)
      if (path) setStatus(`exported to ${path}`)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }

  // Load a file into the editor for review; the user then Saves to persist.
  const load = async (): Promise<void> => {
    setStatus('')
    try {
      const content = await window.codehamr.importMemory()
      if (content !== null) {
        setText(content)
        setStatus('loaded — review, then Save to apply')
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }

  const clear = (): void => {
    setText('')
    setStatus('cleared — Save to wipe stored memory')
  }

  // Drop one fact card: rebuild the raw text without its line. Save persists.
  const removeFact = (idx: number): void => {
    const next = facts.filter((_, i) => i !== idx)
    setText(serializeMemory(next))
    setStatus('removed — Save to apply')
  }

  return (
    <div>
      <p className="mb-3 text-xs text-zinc-500">
        <span className="text-zinc-400">out-of-repo · loads into every new chat.</span> Durable
        facts the agent learns about this project (build commands, where things live, conventions).
        It grows automatically as you work, and is stored outside your repo — nothing is written into
        the project folder.
      </p>
      {text === null ? (
        <p className="py-4 text-center text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs text-zinc-500">
              {facts.length} fact{facts.length === 1 ? '' : 's'}
            </span>
            <button
              onClick={() => setEditing((e) => !e)}
              className={`ml-auto rounded px-2 py-0.5 text-[11px] hover:bg-zinc-700 ${
                editing ? 'bg-zinc-700 text-zinc-100' : 'bg-zinc-800 text-zinc-400'
              }`}
            >
              {editing ? '✓ Editing raw' : 'Edit raw'}
            </button>
          </div>

          {editing ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              placeholder="No memory yet — the agent adds facts here as it works, or you can write your own."
              className="h-72 w-full resize-y rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs leading-relaxed outline-none focus:border-zinc-500"
            />
          ) : facts.length === 0 ? (
            <p className="rounded border border-dashed border-zinc-800 py-8 text-center text-sm text-zinc-600">
              No memory yet — the agent adds facts here as it works.
            </p>
          ) : (
            <div className="max-h-[52vh] space-y-1.5 overflow-y-auto pr-1">
              {facts.map((f, i) => (
                <div
                  key={i}
                  className="group flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
                >
                  <span className="mt-0.5 shrink-0 text-fuchsia-400" title="a remembered fact">
                    ★
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-zinc-200">
                      {f.fact}
                    </p>
                    {f.date && <p className="mt-0.5 text-[10px] text-zinc-600">{f.date}</p>}
                  </div>
                  <button
                    onClick={() => removeFact(i)}
                    title="remove this fact (Save to apply)"
                    className="shrink-0 rounded px-1 text-zinc-600 opacity-0 group-hover:opacity-100 hover:bg-red-950 hover:text-red-400"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => void save()}
              disabled={busy || !dirty}
              className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium hover:bg-emerald-600 disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save memory'}
            </button>
            <button
              onClick={() => void download()}
              className="rounded bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700"
            >
              Download…
            </button>
            <button
              onClick={() => void load()}
              className="rounded bg-zinc-800 px-3 py-1 text-xs hover:bg-zinc-700"
            >
              Load file…
            </button>
            <button
              onClick={clear}
              disabled={text === ''}
              className="rounded px-3 py-1 text-xs text-red-400 hover:bg-red-950 disabled:opacity-30"
            >
              Clear
            </button>
            {status && <span className="ml-auto truncate text-[11px] text-zinc-500">{status}</span>}
          </div>
        </>
      )}
    </div>
  )
}

type MemoryFact = { date: string | null; fact: string }

/**
 * Parse the memory file into fact cards. Each entry is a `- <date> <fact>`
 * bullet (the Go `remember` tool's format); a continuation line without a
 * bullet is appended to the previous fact. Non-bullet leading prose (rare) is
 * ignored so only real facts become cards. Newest first for display.
 */
function parseMemory(text: string): MemoryFact[] {
  const facts: MemoryFact[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    const m = /^-\s+(?:(\d{4}-\d{2}-\d{2})\s+)?(.*)$/.exec(line)
    if (m) {
      facts.push({ date: m[1] ?? null, fact: m[2] })
    } else if (line.trim() && facts.length) {
      // Continuation of the previous fact (wrapped line).
      facts[facts.length - 1].fact += '\n' + line
    }
  }
  return facts.reverse() // newest first
}

/** Rebuild the raw memory text from fact cards (oldest-first, as on disk). */
function serializeMemory(facts: MemoryFact[]): string {
  const oldestFirst = [...facts].reverse()
  return oldestFirst
    .map((f) => `- ${f.date ? f.date + ' ' : ''}${f.fact}`)
    .join('\n')
    .concat(oldestFirst.length ? '\n' : '')
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
