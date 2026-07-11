/**
 * Runtime theming. Tailwind v4 utilities compile to var(--color-zinc-900)
 * etc., with the defaults declared on :root — so overriding those custom
 * properties on <html> retunes every surface and accent in the app without
 * touching a single component class.
 *
 * A theme is two seed colors: a surface tint (bg) and an accent. Full ramps
 * are generated from Tailwind's own lightness stops so contrast relationships
 * survive the hue swap. 'forge' (the stock zinc + emerald look) simply clears
 * the overrides.
 */

export interface ThemeSeeds {
  bg: string
  accent: string
}
export interface ThemeChoice {
  name: string // scheme name or 'custom'
  custom?: ThemeSeeds
}

// A surface seed with lightness >= 50 makes a light theme (the ramp flips).
export const SCHEMES: ({ name: string; label: string; light?: boolean } & ThemeSeeds)[] = [
  // Dark
  { name: 'forge', label: 'Forge', bg: '#18181b', accent: '#10b981' }, // stock zinc + emerald
  { name: 'ember', label: 'Ember', bg: '#211917', accent: '#f97316' }, // warm, matches the anvil spark
  { name: 'ocean', label: 'Ocean', bg: '#141b26', accent: '#0ea5e9' },
  { name: 'nebula', label: 'Nebula', bg: '#1a1725', accent: '#a78bfa' },
  { name: 'mist', label: 'Mist', bg: '#161d21', accent: '#2dd4bf' },
  // Light
  { name: 'paper', label: 'Paper', bg: '#f4f1ea', accent: '#b45309', light: true }, // warm off-white
  { name: 'daylight', label: 'Daylight', bg: '#eef1f6', accent: '#0284c7', light: true }, // cool white
  { name: 'sage', label: 'Sage', bg: '#eef2ec', accent: '#047857', light: true }, // soft green-gray
]

// Lightness stops mirroring Tailwind's zinc / emerald ramps (approximate HSL
// lightness of each stop) so generated ramps keep the same contrast ladder.
const SURFACE_L: [string, number][] = [
  ['950', 5],
  ['900', 10],
  ['800', 16],
  ['700', 25],
  ['600', 33],
  ['500', 46],
  ['400', 66],
  ['300', 84],
  ['200', 90],
  ['100', 96],
  ['50', 98],
]
const ACCENT_L: [string, number][] = [
  ['950', 12],
  ['900', 19],
  ['800', 25],
  ['700', 31],
  ['600', 38],
  ['500', 45],
  ['400', 58],
  ['300', 74],
  ['200', 85],
]

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return { h: 0, s: 0, l: 50 }
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l: l * 100 }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h: h * 360, s: s * 100, l: l * 100 }
}

const css = (h: number, s: number, l: number): string =>
  `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`

// The native Windows caption-button overlay only accepts a concrete color
// (not a CSS var / oklch), so overlay tints are computed to hex here.
function hslToHex(h: number, s: number, l: number): string {
  s /= 100
  l /= 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  const hex = (x: number): string =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`
}

// Stock (Forge) caption overlay: zinc-950 background, zinc-300 symbols.
const STOCK_OVERLAY = { color: '#09090b', symbolColor: '#d4d4d8' }

function setOverlay(color: string, symbolColor: string): void {
  window.codehamr?.setTitleBarOverlay?.(color, symbolColor)
}

// Static hues (warnings, links, errors, reasoning) are tuned for dark
// surfaces; on a light theme their 400-ish stops wash out. These overrides
// darken just the stops the app uses for text/icons.
const LIGHT_FIXES: [string, string][] = [
  ['--color-amber-400', 'hsl(30 90% 34%)'],
  ['--color-amber-500', 'hsl(28 92% 30%)'],
  ['--color-amber-300', 'hsl(32 88% 30%)'],
  ['--color-sky-400', 'hsl(200 90% 34%)'],
  ['--color-red-400', 'hsl(0 72% 42%)'],
  ['--color-red-300', 'hsl(0 70% 36%)'],
  // Error/notice bands: bg-red-950 is a dark maroon panel on dark themes;
  // on light ones it must become a light red tint under the darkened text.
  ['--color-red-950', 'hsl(0 75% 93%)'],
  ['--color-red-900', 'hsl(0 65% 86%)'],
  ['--color-violet-400', 'hsl(262 70% 44%)'],
  ['--color-violet-500', 'hsl(262 72% 40%)'],
]

/** All custom properties a theme may set — cleared when returning to stock. */
const themedVars = (): string[] => [
  ...SURFACE_L.map(([stop]) => `--color-zinc-${stop}`),
  ...ACCENT_L.map(([stop]) => `--color-emerald-${stop}`),
  ...LIGHT_FIXES.map(([v]) => v),
]

const STORAGE_KEY = 'chtheme'

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  for (const v of themedVars()) root.style.removeProperty(v)
  delete root.dataset.light
  localStorage.setItem(STORAGE_KEY, JSON.stringify(choice))

  const seeds =
    choice.name === 'custom' ? choice.custom : SCHEMES.find((s) => s.name === choice.name)
  if (!seeds || choice.name === 'forge') {
    setOverlay(STOCK_OVERLAY.color, STOCK_OVERLAY.symbolColor) // stock look
    return
  }

  const bg = hexToHsl(seeds.bg)
  const ac = hexToHsl(seeds.accent)
  // A light seed (e.g. white) flips the whole ladder: "zinc-950" becomes the
  // near-white page, the light text stops become dark text — every utility
  // class in the app follows without knowing which mode it's in.
  const light = bg.l >= 50
  if (light) root.dataset.light = '1' // hook for code-stays-dark CSS rules
  // Surface stop → {h,s,l}, shared by the ramp and the caption-overlay tint.
  const surface = (l: number): { h: number; s: number; l: number } => {
    const ll = light ? 100 - l : l
    // The tint lives in the surfaces; text stops go near-neutral so text
    // doesn't read colored.
    const textish = light ? ll < 40 : ll > 60
    const s = bg.s * (textish ? 0.12 : ll > 30 && ll < 70 ? 0.5 : 1)
    return { h: bg.h, s: Math.min(s, 45), l: ll }
  }
  for (const [stop, l] of SURFACE_L) {
    const c = surface(l)
    root.style.setProperty(`--color-zinc-${stop}`, css(c.h, c.s, c.l))
  }
  // Accents do NOT flip with the surface ladder: the accent should stay a
  // saturated mid-tone in both modes so filled buttons (emerald-700 bg + light
  // text) keep their contrast on a light page instead of going pale.
  for (const [stop, l] of ACCENT_L) {
    root.style.setProperty(`--color-emerald-${stop}`, css(ac.h, Math.min(ac.s, 92), l))
  }
  if (light) {
    for (const [v, val] of LIGHT_FIXES) root.style.setProperty(v, val)
  }

  // Caption buttons: match the page (zinc-950, l=5) with readable symbols
  // (zinc-300, l=84) — both flip automatically with the light ladder.
  const ob = surface(5)
  const os = surface(84)
  setOverlay(hslToHex(ob.h, ob.s, ob.l), hslToHex(os.h, os.s, os.l))
}

export function loadThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as ThemeChoice
  } catch {
    /* corrupted entry: fall through to default */
  }
  return { name: 'mist' } // default scheme for fresh installs
}

export function applyStoredTheme(): void {
  applyTheme(loadThemeChoice())
}

// ---------------------------------------------------------------------------
// UI scale (accessibility): Electron zoom scales everything — text, spacing,
// panels — which beats font-size fiddling for readability.
// ---------------------------------------------------------------------------

const ZOOM_KEY = 'chzoom'

export function loadZoom(): number {
  const z = Number(localStorage.getItem(ZOOM_KEY))
  return Number.isFinite(z) && z >= 0.7 && z <= 1.6 ? z : 1
}

export function applyZoom(factor: number): void {
  const f = Math.min(1.6, Math.max(0.7, factor))
  localStorage.setItem(ZOOM_KEY, String(f))
  void window.codehamr.setZoom(f)
}
