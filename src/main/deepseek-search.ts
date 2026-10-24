/**
 * DeepSeek Search & Fetch API key. Same stateless shape as brave.ts: the
 * web-search and web-fetch cerebellum plugins read config.json on every call,
 * so this module only validates a key and reports status for the panels.
 */

import { getDeepSeekSearchConfig } from '@main/workspace/workspace'

// The balance endpoint shares the key and auth with /v1/tools/*, and unlike a
// real search it is free — a Test click must not spend the user's money.
const DEEPSEEK_BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance'
const TEST_TIMEOUT_MS = 8_000

export type DeepSeekSearchErrorKind =
  | 'missing_key'
  | 'invalid_key'
  | 'insufficient_balance'
  | 'rate_limit'
  | 'network'
  | 'unknown'

export type DeepSeekSearchStatus = {
  status: 'disabled' | 'configured' | 'error'
  errorKind: DeepSeekSearchErrorKind | null
  error: string | null
}

export type DeepSeekSearchTestResult =
  | { ok: true }
  | { ok: false; kind: DeepSeekSearchErrorKind; message?: string }

class DeepSeekSearchService {
  private lastError: { kind: DeepSeekSearchErrorKind; message: string | null } | null = null

  /** Active when the key is set and at least one of Search / Fetch is on. */
  async getStatus(): Promise<DeepSeekSearchStatus> {
    const cfg = await getDeepSeekSearchConfig()
    if (cfg.apiKey.trim().length === 0 || (!cfg.searchEnabled && !cfg.fetchEnabled)) {
      return { status: 'disabled', errorKind: null, error: null }
    }
    if (this.lastError) {
      return { status: 'error', errorKind: this.lastError.kind, error: this.lastError.message }
    }
    return { status: 'configured', errorKind: null, error: null }
  }

  async testKey(apiKey: string): Promise<DeepSeekSearchTestResult> {
    const trimmed = apiKey.trim()
    if (trimmed.length === 0) {
      this.lastError = { kind: 'missing_key', message: null }
      return { ok: false, kind: 'missing_key' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(DEEPSEEK_BALANCE_ENDPOINT, {
        signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: `Bearer ${trimmed}` }
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
    if (response.status === 402) {
      this.lastError = { kind: 'insufficient_balance', message: null }
      return { ok: false, kind: 'insufficient_balance' }
    }
    if (response.status === 429) {
      this.lastError = { kind: 'rate_limit', message: null }
      return { ok: false, kind: 'rate_limit' }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const message = `HTTP ${response.status} ${response.statusText}${text ? ': ' + text.slice(0, 200) : ''}`
      this.lastError = { kind: 'unknown', message }
      return { ok: false, kind: 'unknown', message }
    }

    let json: { is_available?: boolean }
    try {
      json = (await response.json()) as { is_available?: boolean }
    } catch (err) {
      const message = `Failed to parse response: ${(err as Error)?.message ?? err}`
      this.lastError = { kind: 'unknown', message }
      return { ok: false, kind: 'unknown', message }
    }
    // A valid key on an empty account: every Search / Fetch call would 402.
    if (json.is_available === false) {
      this.lastError = { kind: 'insufficient_balance', message: null }
      return { ok: false, kind: 'insufficient_balance' }
    }

    this.lastError = null
    return { ok: true }
  }

  resetCache(): void {
    this.lastError = null
  }
}

export const deepseekSearchService = new DeepSeekSearchService()
