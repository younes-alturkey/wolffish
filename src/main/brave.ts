/**
 * Brave Search API integration. Stateless — no long-poll, no in-process
 * server. The web-search cerebellum plugin reads the persisted config
 * directly from config.json on every search and uses Brave as the
 * primary provider when enabled. This module just exposes the lightweight
 * "test the key works" helper and a status view for the settings panel.
 */

import { getBraveConfig } from '@main/workspace/workspace'

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const TEST_TIMEOUT_MS = 8_000

export type BraveErrorKind =
  | 'missing_key'
  | 'invalid_key'
  | 'rate_limit'
  | 'subscription'
  | 'network'
  | 'unknown'

export type BraveStatus = {
  status: 'disabled' | 'configured' | 'error'
  errorKind: BraveErrorKind | null
  /** Raw error from the last test attempt, surfaced when kind is `unknown`. */
  error: string | null
}

export type BraveTestResult =
  | { ok: true; resultsCount: number }
  | { ok: false; kind: BraveErrorKind; message?: string }

class BraveService {
  // Last test result is cached so the renderer can read status without
  // re-hitting Brave on every panel mount. Clears when the user changes
  // the key (setConfig path).
  private lastError: { kind: BraveErrorKind; message: string | null } | null = null

  async getStatus(): Promise<BraveStatus> {
    const cfg = await getBraveConfig()
    if (!cfg.enabled || cfg.apiKey.trim().length === 0) {
      return { status: 'disabled', errorKind: null, error: null }
    }
    if (this.lastError) {
      return { status: 'error', errorKind: this.lastError.kind, error: this.lastError.message }
    }
    return { status: 'configured', errorKind: null, error: null }
  }

  /**
   * Hit the Brave Search endpoint with a tiny query just to validate the
   * key. Returns the result count from the response so the UI can show
   * "Test passed (N results)" — proves the request actually went through
   * end-to-end, not just that the auth header was accepted.
   */
  async testKey(apiKey: string): Promise<BraveTestResult> {
    const trimmed = apiKey.trim()
    if (trimmed.length === 0) {
      this.lastError = { kind: 'missing_key', message: null }
      return { ok: false, kind: 'missing_key' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(`${BRAVE_SEARCH_ENDPOINT}?q=test&count=1`, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': trimmed
        }
      })
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError'
      const message = aborted ? 'Request timed out' : ((err as Error)?.message ?? String(err))
      this.lastError = { kind: 'network', message }
      return { ok: false, kind: 'network', message }
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401 || response.status === 403) {
      this.lastError = { kind: 'invalid_key', message: null }
      return { ok: false, kind: 'invalid_key' }
    }
    if (response.status === 429) {
      this.lastError = { kind: 'rate_limit', message: null }
      return { ok: false, kind: 'rate_limit' }
    }
    if (response.status === 422) {
      // Brave returns 422 when the subscription is suspended/expired.
      this.lastError = { kind: 'subscription', message: null }
      return { ok: false, kind: 'subscription' }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const message = `HTTP ${response.status} ${response.statusText}${text ? ': ' + text.slice(0, 200) : ''}`
      this.lastError = { kind: 'unknown', message }
      return { ok: false, kind: 'unknown', message }
    }

    let json: { web?: { results?: unknown[] } }
    try {
      json = (await response.json()) as { web?: { results?: unknown[] } }
    } catch (err) {
      const message = `Failed to parse response: ${(err as Error)?.message ?? err}`
      this.lastError = { kind: 'unknown', message }
      return { ok: false, kind: 'unknown', message }
    }

    const resultsCount = Array.isArray(json.web?.results) ? json.web.results.length : 0
    this.lastError = null
    return { ok: true, resultsCount }
  }

  /** Clear cached error after config changes so the next status read is fresh. */
  resetCache(): void {
    this.lastError = null
  }
}

export const braveService = new BraveService()
