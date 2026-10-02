/**
 * Notion integration. Stateless — no daemon, no long-poll. The notion
 * cerebellum plugin reads config.json directly on every tool call.
 * This module exposes a lightweight "test the token works" helper and
 * a status view for the settings panel.
 */

import { getNotionConfig } from '@main/workspace/workspace'

const NOTION_API_BASE = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const TEST_TIMEOUT_MS = 8_000

export type NotionErrorKind =
  | 'missing_token'
  | 'invalid_token'
  | 'rate_limit'
  | 'network'
  | 'unknown'

export type NotionStatus = {
  status: 'disabled' | 'configured' | 'error'
  errorKind: NotionErrorKind | null
  error: string | null
}

export type NotionTestResult =
  | { ok: true; name: string; email: string | null }
  | { ok: false; kind: NotionErrorKind; message?: string }

class NotionService {
  // Aggregate status across all connections: configured when at least one
  // connection carries a token, disabled otherwise. Per-connection test
  // outcomes are surfaced in the settings panel, not folded in here — a
  // single failed test shouldn't poison the whole service's status dot.
  async getStatus(): Promise<NotionStatus> {
    const cfg = await getNotionConfig()
    const hasToken = cfg.connections.some((c) => c.token.trim().length > 0)
    if (!hasToken) {
      return { status: 'disabled', errorKind: null, error: null }
    }
    return { status: 'configured', errorKind: null, error: null }
  }

  async testToken(token: string): Promise<NotionTestResult> {
    const trimmed = token.trim()
    if (trimmed.length === 0) {
      return { ok: false, kind: 'missing_token' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(`${NOTION_API_BASE}/users/me`, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${trimmed}`,
          'Notion-Version': NOTION_VERSION
        }
      })
    } catch (err) {
      const aborted = (err as { name?: string })?.name === 'AbortError'
      const message = aborted ? 'Request timed out' : ((err as Error)?.message ?? String(err))
      return { ok: false, kind: 'network', message }
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401) {
      return { ok: false, kind: 'invalid_token' }
    }
    if (response.status === 403) {
      return { ok: false, kind: 'invalid_token' }
    }
    if (response.status === 429) {
      return { ok: false, kind: 'rate_limit' }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const message = `HTTP ${response.status} ${response.statusText}${text ? ': ' + text.slice(0, 200) : ''}`
      return { ok: false, kind: 'unknown', message }
    }

    let json: {
      name?: string
      person?: { email?: string }
      bot?: { owner?: { user?: { person?: { email?: string } } } }
    }
    try {
      json = (await response.json()) as typeof json
    } catch (err) {
      const message = `Failed to parse response: ${(err as Error)?.message ?? err}`
      return { ok: false, kind: 'unknown', message }
    }

    const name = json.name ?? 'Unknown'
    const email = json.bot?.owner?.user?.person?.email ?? json.person?.email ?? null
    return { ok: true, name, email }
  }
}

export const notionService = new NotionService()
