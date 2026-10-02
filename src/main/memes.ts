import { getMemesConfig } from '@main/workspace/workspace'

const GIPHY_API = 'https://api.giphy.com/v1/gifs'
const IMGFLIP_API = 'https://api.imgflip.com'
const TEST_TIMEOUT_MS = 10_000

export type MemesErrorKind = 'missing_key' | 'invalid_key' | 'rate_limit' | 'network' | 'unknown'

export type MemesStatus = {
  memegen: 'available'
  giphy: 'disabled' | 'configured' | 'error'
  imgflip: 'disabled' | 'configured' | 'error'
  giphyErrorKind: MemesErrorKind | null
  giphyError: string | null
  imgflipErrorKind: MemesErrorKind | null
  imgflipError: string | null
}

export type MemesTestResult = { ok: true } | { ok: false; kind: MemesErrorKind; message?: string }

class MemesService {
  private lastGiphyError: { kind: MemesErrorKind; message: string | null } | null = null
  private lastImgflipError: { kind: MemesErrorKind; message: string | null } | null = null

  async getStatus(): Promise<MemesStatus> {
    const cfg = await getMemesConfig()
    return {
      memegen: 'available',
      giphy: this.lastGiphyError
        ? 'error'
        : cfg.giphy.apiKey.trim().length > 0
          ? 'configured'
          : 'disabled',
      imgflip: this.lastImgflipError
        ? 'error'
        : cfg.imgflip.username.trim().length > 0
          ? 'configured'
          : 'disabled',
      giphyErrorKind: this.lastGiphyError?.kind ?? null,
      giphyError: this.lastGiphyError?.message ?? null,
      imgflipErrorKind: this.lastImgflipError?.kind ?? null,
      imgflipError: this.lastImgflipError?.message ?? null
    }
  }

  async testGiphy(apiKey: string): Promise<MemesTestResult> {
    const trimmed = apiKey.trim()
    if (trimmed.length === 0) {
      this.lastGiphyError = { kind: 'missing_key', message: null }
      return { ok: false, kind: 'missing_key' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    try {
      const response = await fetch(
        `${GIPHY_API}/trending?api_key=${encodeURIComponent(trimmed)}&limit=1&rating=pg-13`,
        { signal: controller.signal }
      )
      if (response.status === 401 || response.status === 403) {
        this.lastGiphyError = { kind: 'invalid_key', message: null }
        return { ok: false, kind: 'invalid_key' }
      }
      if (response.status === 429) {
        this.lastGiphyError = { kind: 'rate_limit', message: null }
        return { ok: false, kind: 'rate_limit' }
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const message = `HTTP ${response.status}${text ? ': ' + text.slice(0, 200) : ''}`
        this.lastGiphyError = { kind: 'unknown', message }
        return { ok: false, kind: 'unknown', message }
      }
      this.lastGiphyError = null
      return { ok: true }
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError'
      const message = aborted ? 'Request timed out' : ((err as Error)?.message ?? String(err))
      this.lastGiphyError = { kind: 'network', message }
      return { ok: false, kind: 'network', message }
    } finally {
      clearTimeout(timer)
    }
  }

  async testImgflip(username: string, password: string): Promise<MemesTestResult> {
    if (!username.trim() || !password.trim()) {
      this.lastImgflipError = { kind: 'missing_key', message: null }
      return { ok: false, kind: 'missing_key' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    try {
      const body = new URLSearchParams({
        template_id: '181913649',
        username: username.trim(),
        password: password.trim(),
        text0: 'Test',
        text1: 'Connection'
      })
      const response = await fetch(`${IMGFLIP_API}/caption_image`, {
        method: 'POST',
        body,
        signal: controller.signal
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const message = `HTTP ${response.status}${text ? ': ' + text.slice(0, 200) : ''}`
        this.lastImgflipError = { kind: 'unknown', message }
        return { ok: false, kind: 'unknown', message }
      }
      const json = (await response.json()) as { success: boolean; error_message?: string }
      if (!json.success) {
        const isAuth =
          json.error_message?.toLowerCase().includes('password') ||
          json.error_message?.toLowerCase().includes('username')
        this.lastImgflipError = {
          kind: isAuth ? 'invalid_key' : 'unknown',
          message: json.error_message ?? null
        }
        return {
          ok: false,
          kind: isAuth ? 'invalid_key' : 'unknown',
          message: json.error_message
        }
      }
      this.lastImgflipError = null
      return { ok: true }
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError'
      const message = aborted ? 'Request timed out' : ((err as Error)?.message ?? String(err))
      this.lastImgflipError = { kind: 'network', message }
      return { ok: false, kind: 'network', message }
    } finally {
      clearTimeout(timer)
    }
  }

  resetCache(): void {
    this.lastGiphyError = null
    this.lastImgflipError = null
  }
}

export const memesService = new MemesService()
