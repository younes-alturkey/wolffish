import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // The coding-agent parity benchmark: plain-JS harness scripts and the
      // bug fixtures the two agents are graded on — fixture code is the bug.
      'bench/**',
      // Bundled workspace defaults are user-facing assets copied into
      // ~/.wolffish on first launch. Plugin code there is JavaScript the
      // user can edit — not part of the app's TypeScript source.
      'src/defaults/workspace/**',
      'scripts/**',
      // Compiled terminal-client binaries.
      'build/cli/**'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    // The CLI client is plain ESM JavaScript, not TypeScript: it is read
    // straight off disk and run under ELECTRON_RUN_AS_NODE, with no build
    // step to strip annotations. Only the TypeScript-shaped rules are off —
    // everything else (unused vars, correctness, prettier) still applies.
    //
    // electron-builder hooks in build/ are the same kind of file for the same
    // reason: Node loads them directly, so there is nothing to strip
    // annotations. Exempting the rule rather than adding them to `ignores`
    // (where scripts/ sits) keeps every non-TypeScript rule on them.
    //
    // The live runtime harnesses (`npx electron …/e2e-mobile-live.mjs`) are a
    // third instance of the same shape — Electron reads them off disk, so an
    // annotation would be a syntax error at run time.
    files: ['src/cli/**/*.mjs', 'build/**/*.mjs', 'src/main/runtime/__tests__/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  {
    // The live computer-use harness is CommonJS that Electron's main process
    // loads directly (`electron harness.cjs`), so `require` is its module
    // system and there is no build step to strip annotations. Same treatment
    // as the build hooks: only the TypeScript-shaped rules are off.
    files: ['src/main/__tests__/computer-use-live/**/*.cjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    // The terminal client is Solid + OpenTUI, not React: its JSX elements are
    // terminal renderables (`<box>`, `<text>`), `<For>` needs no keys, and
    // there are no React hooks to police. The React rule sets are off here;
    // every TypeScript and correctness rule stays on. Daemon payloads cross
    // this boundary as untyped JSON, hence `any` is allowed at the seam.
    files: ['src/cli/**/*.{ts,tsx}'],
    rules: {
      'react/no-unknown-property': 'off',
      'react/jsx-key': 'off',
      'react/no-children-prop': 'off',
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  },
  eslintConfigPrettier
)
