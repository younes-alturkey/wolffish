export const REPO = 'younes-alturkey/wolffish'
export const REPO_URL = `https://github.com/${REPO}`
export const RELEASES_URL = `${REPO_URL}/releases/latest`
export const ALL_RELEASES_URL = `${REPO_URL}/releases`
export const DOCS_URL = `${REPO_URL}/blob/main/docs/README.md`
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`

const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const DOWNLOAD_BASE = `${REPO_URL}/releases/latest/download`

export const INSTALL_SH = `curl -fsSL ${DOWNLOAD_BASE}/install.sh | sh`
export const INSTALL_PS1 = `irm ${DOWNLOAD_BASE}/install.ps1 | iex`

export interface ReleaseFile {
  url: string
  filename: string
}

export interface Release {
  version: string
  files: {
    macos?: ReleaseFile
    windows?: ReleaseFile
    linux: { deb?: ReleaseFile; rpm?: ReleaseFile; appimage?: ReleaseFile }
  }
}

interface GithubRelease {
  tag_name?: string
  assets?: { name: string; browser_download_url: string }[]
}

export function toRelease(gh: GithubRelease): Release | null {
  const assets = gh.assets
  if (!gh.tag_name || !Array.isArray(assets)) return null
  const find = (pattern: RegExp): ReleaseFile | undefined => {
    const asset = assets.find((a) => pattern.test(a.name))
    return asset && { url: asset.browser_download_url, filename: asset.name }
  }
  return {
    version: gh.tag_name.replace(/^v/, ''),
    files: {
      macos: find(/\.dmg$/),
      windows: find(/\.exe$/),
      linux: { deb: find(/\.deb$/), rpm: find(/\.rpm$/), appimage: find(/\.AppImage$/) }
    }
  }
}

export async function fetchLatestRelease(token?: string): Promise<Release | null> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(LATEST_API, { headers })
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText}`)
  return toRelease(await res.json())
}
