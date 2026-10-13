import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fetchLatestRelease, type Release } from './src/release'

const resources = fileURLToPath(new URL('../../resources', import.meta.url))

// The Pages workflow passes the deployed address; locally it falls back to the github.io one.
const siteUrl = (process.env.SITE_URL ?? 'https://younes-alturkey.github.io/wolffish').replace(
  /\/?$/,
  '/'
)

async function bakedRelease(): Promise<Release | null> {
  try {
    return await fetchLatestRelease(process.env.GITHUB_TOKEN)
  } catch (error) {
    console.warn(`[landing] no release baked in, the page will look it up live: ${error}`)
    return null
  }
}

function siteUrlPlugin(): Plugin {
  return {
    name: 'site-url',
    transformIndexHtml: (html) => html.replaceAll('%SITE_URL%', siteUrl)
  }
}

export default defineConfig(async () => ({
  base: './',
  plugins: [react(), tailwindcss(), siteUrlPlugin()],
  resolve: { alias: { '@resources': resources } },
  define: { __RELEASE__: JSON.stringify(await bakedRelease()) },
  build: { chunkSizeWarningLimit: 800 },
  server: { fs: { allow: ['.', resources] } }
}))
