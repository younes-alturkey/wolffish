/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  presets: [require('nativewind/preset')],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Wolffish brand palette — mirrors wolffish-app main.css @theme.
        ocean: '#1b365d',
        arctic: '#a5d8ff',
        cyan: '#00d4ff',
        void: '#0d1117',
        frosted: '#f0f4f8',
        cloud: '#ffffff',

        // Semantic tokens — resolved at runtime from the CSS variables in
        // global.css so they follow the active light/dark scheme.
        bg: 'var(--color-bg)',
        'bg-soft': 'var(--color-bg-soft)',
        surface: 'var(--color-surface)',
        'surface-soft': 'var(--color-surface-soft)',
        fg: 'var(--color-fg)',
        muted: 'var(--color-muted)',
        border: 'var(--color-border)',
        'border-soft': 'var(--color-border-soft)',
        primary: 'var(--color-primary)',
        'primary-soft': 'var(--color-primary-soft)',
        'primary-line': 'var(--color-primary-line)',
        'primary-fg': 'var(--color-primary-fg)',
        accent: 'var(--color-accent)',
        'accent-soft': 'var(--color-accent-soft)',
        'accent-line': 'var(--color-accent-line)',
        ring: 'var(--color-ring)'
      },
      // React Native selects fonts by family name per weight, so each weight
      // of IBM Plex Sans Arabic is its own family. font-sans is the regular
      // weight; use font-sans-medium/semibold/bold where the desktop app
      // uses font-medium/semibold/bold.
      fontFamily: {
        sans: ['IBMPlexSansArabic-Regular'],
        'sans-medium': ['IBMPlexSansArabic-Medium'],
        'sans-semibold': ['IBMPlexSansArabic-SemiBold'],
        'sans-bold': ['IBMPlexSansArabic-Bold']
      }
    }
  },
  plugins: []
}
