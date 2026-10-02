import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const projectRoot = resolve(__dirname)

const srcAlias = {
  '@main': resolve('src/main'),
  '@preload': resolve('src/preload'),
  '@renderer': resolve('src/renderer/src'),
  '@components': resolve('src/renderer/src/components'),
  '@hooks': resolve('src/renderer/src/hooks'),
  '@lib': resolve('src/renderer/src/lib'),
  '@pages': resolve('src/renderer/src/pages'),
  '@providers': resolve('src/renderer/src/providers'),
  '@resources': resolve('resources')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store'] })],
    resolve: { alias: srcAlias },
    build: {
      rollupOptions: {
        onwarn(warning, defaultHandler) {
          // `workspace.ts` is imported lazily by the extension doctor and
          // statically by ~30 other main-process modules, so Vite notes that
          // the dynamic import buys no code splitting. True, and beside the
          // point: that import is lazy so `doctor.ts` LOADS AT ALL under plain
          // tsx. workspace.ts reads Electron's `app` at module scope, and the
          // doctor's composer tests run without an Electron binary — a static
          // import there fails with `Cannot read properties of undefined
          // (reading 'isPackaged')`. The module is in the entry chunk either
          // way, via src/main/index.ts.
          //
          // Matched narrowly on purpose: a mixed static/dynamic import of any
          // OTHER module still warns, which is when this warning earns its keep.
          const message = warning.message.replace(/\\/g, '/')
          if (
            warning.plugin === 'vite:reporter' &&
            message.includes('dynamic import will not move module into another chunk') &&
            message.includes('src/main/workspace/workspace.ts')
          ) {
            return
          }
          defaultHandler(warning)
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: srcAlias },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // Dedicated preload for the custom Windows tray popup menu.
          trayMenu: resolve('src/preload/trayMenu.ts')
        }
      }
    }
  },
  renderer: {
    resolve: { alias: srcAlias },
    server: {
      fs: {
        allow: [projectRoot]
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
