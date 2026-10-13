// JS-side mirror of the semantic tokens in src/global.css, for the few
// places React Native needs a concrete color value instead of a className
// (placeholderTextColor, status bar, navigation background). Keep in sync
// with global.css and wolffish-app main.css.
export type ThemeTokens = {
  bg: string
  surface: string
  fg: string
  muted: string
  border: string
  borderSoft: string
  primary: string
  primaryFg: string
  accent: string
  ring: string
}

export const LIGHT_TOKENS: ThemeTokens = {
  bg: '#f0f4f8',
  surface: '#ffffff',
  fg: '#0d1117',
  muted: '#5b6778',
  border: '#d5dde5',
  borderSoft: '#e0e6ed',
  primary: '#1b365d',
  primaryFg: '#ffffff',
  accent: '#00d4ff',
  ring: '#1b365d'
}

export const DARK_TOKENS: ThemeTokens = {
  bg: '#0d1117',
  surface: '#161b22',
  fg: '#ffffff',
  muted: '#8b95a7',
  border: '#2a313c',
  borderSoft: '#1e242d',
  primary: '#a5d8ff',
  primaryFg: '#0d1117',
  accent: '#00d4ff',
  ring: '#a5d8ff'
}

export function tokensFor(isDark: boolean): ThemeTokens {
  return isDark ? DARK_TOKENS : LIGHT_TOKENS
}
