/**
 * Colors, as one object every component reads from.
 *
 * Two palettes — dark and light — chosen from the terminal's own answer
 * (OSC 11 background query via the renderer) unless the user pinned one.
 * The accent is Wolffish blue on both grounds; semantic colors (good, warn,
 * bad) are separate from the accent so state never competes with brand.
 */
import { RGBA } from '@opentui/core'
import { createSignal } from 'solid-js'

export type ThemeName = 'wolffish-dark' | 'wolffish-light' | 'mono'

export type Palette = {
  name: ThemeName
  /** Left transparent so the terminal's own background shows through. */
  background: RGBA | undefined
  panel: RGBA
  element: RGBA
  text: RGBA
  muted: RGBA
  dim: RGBA
  accent: RGBA
  accentFg: RGBA
  good: RGBA
  warn: RGBA
  bad: RGBA
  border: RGBA
  user: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  selection: RGBA
}

const hex = (h: string) => RGBA.fromHex(h)

export const DARK: Palette = {
  name: 'wolffish-dark',
  background: undefined,
  panel: hex('#171C24'),
  element: hex('#242B36'),
  text: hex('#DCE2EC'),
  muted: hex('#8A96A8'),
  dim: hex('#5D6878'),
  accent: hex('#5B9BFF'),
  accentFg: hex('#0B1220'),
  good: hex('#5FCB84'),
  warn: hex('#E3B45C'),
  bad: hex('#F27E7E'),
  border: hex('#2E3745'),
  user: hex('#7FB3FF'),
  diffAdded: hex('#173A26'),
  diffRemoved: hex('#3D1F22'),
  selection: hex('#2B4C86')
}

export const LIGHT: Palette = {
  name: 'wolffish-light',
  background: undefined,
  panel: hex('#EEF1F6'),
  element: hex('#E1E6EE'),
  text: hex('#1B2230'),
  muted: hex('#5B6678'),
  dim: hex('#8C97A8'),
  accent: hex('#1E63D6'),
  accentFg: hex('#FFFFFF'),
  good: hex('#1F8A4C'),
  warn: hex('#B7791F'),
  bad: hex('#C53030'),
  border: hex('#C9D1DE'),
  user: hex('#1E63D6'),
  diffAdded: hex('#DDF3E4'),
  diffRemoved: hex('#F9DEDE'),
  selection: hex('#BBD3FA')
}

/** Eight-color-safe fallback for terminals that report no truecolor. */
export const MONO: Palette = {
  ...DARK,
  name: 'mono',
  panel: RGBA.fromInts(40, 40, 40),
  element: RGBA.fromInts(60, 60, 60),
  border: RGBA.fromInts(90, 90, 90)
}

const [palette, setPalette] = createSignal<Palette>(DARK)

export const theme = palette
export function setTheme(name: ThemeName): void {
  setPalette(name === 'wolffish-light' ? LIGHT : name === 'mono' ? MONO : DARK)
}
export const THEMES: ThemeName[] = ['wolffish-dark', 'wolffish-light', 'mono']

/** Tint for a context-meter percentage: grey under 75, amber from 75, red from 90. */
export function meterTint(pct: number): RGBA {
  const p = palette()
  if (pct >= 90) return p.bad
  if (pct >= 75) return p.warn
  return p.muted
}
