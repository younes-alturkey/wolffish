/**
 * GitHub integration. Stateless — no daemon, no long-poll. The github
 * cerebellum plugin reads config.json directly on every tool call.
 * This module exposes a lightweight "test the token works" helper and
 * a status view for the settings panel.
 */

import { getGitHubConfig } from '@main/workspace/workspace'

const GITHUB_API_BASE = 'https://api.github.com'
const TEST_TIMEOUT_MS = 8_000

export type GitHubErrorKind =
  | 'missing_token'
  | 'invalid_token'
  | 'rate_limit'
  | 'insufficient_scope'
  | 'network'
  | 'unknown'

export type GitHubStatus = {
  status: 'disabled' | 'configured' | 'error'
  errorKind: GitHubErrorKind | null
  error: string | null
}

export type GitHubTestResult =
  | { ok: true; login: string; name: string | null; scopes: string }
  | { ok: false; kind: GitHubErrorKind; message?: string }

class GitHubService {
  // Aggregate status across all connections: configured when at least one
  // connection carries a token, disabled otherwise. Per-connection test
  // outcomes are surfaced in the settings panel, not folded in here — a
  // single failed test shouldn't poison the whole service's status dot.
  async getStatus(): Promise<GitHubStatus> {
    const cfg = await getGitHubConfig()
    const hasToken = cfg.connections.some((c) => c.token.trim().length > 0)
    if (!hasToken) {
      return { status: 'disabled', errorKind: null, error: null }
    }
    return { status: 'configured', errorKind: null, error: null }
  }

  async testToken(token: string): Promise<GitHubTestResult> {
    const trimmed = token.trim()
    if (trimmed.length === 0) {
      return { ok: false, kind: 'missing_token' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(`${GITHUB_API_BASE}/user`, {
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${trimmed}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
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
      return { ok: false, kind: 'insufficient_scope' }
    }
    if (response.status === 429) {
      return { ok: false, kind: 'rate_limit' }
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const message = `HTTP ${response.status} ${response.statusText}${text ? ': ' + text.slice(0, 200) : ''}`
      return { ok: false, kind: 'unknown', message }
    }

    let json: { login?: string; name?: string | null }
    try {
      json = (await response.json()) as typeof json
    } catch (err) {
      const message = `Failed to parse response: ${(err as Error)?.message ?? err}`
      return { ok: false, kind: 'unknown', message }
    }

    const login = json.login ?? 'unknown'
    const name = json.name ?? null
    const scopes = response.headers.get('x-oauth-scopes') ?? ''
    return { ok: true, login, name, scopes }
  }
}

export const githubService = new GitHubService()
