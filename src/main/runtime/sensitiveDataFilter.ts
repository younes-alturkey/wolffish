/**
 * Sensitive data filter — scans user messages for credentials BEFORE
 * they reach the LLM, hippocampus, basalganglia, or any persistent
 * store. The first match wins; we don't try to enumerate every leak,
 * we just stop the obvious ones.
 *
 * This runs at the message entry point (chat:send IPC handler). When a
 * match fires, the message is discarded outright — never sent to the
 * model, never appended to an episode, never written to the corpus log
 * with its content. Wolffish never accepts credentials over chat; if
 * elevation is needed, the OS-native password prompt is used instead.
 */

export type SensitiveDataType = 'password' | 'api_key' | 'access_token' | 'private_key' | 'ssh_key'

export type SensitiveDataMatch = {
  type: SensitiveDataType
  /** Why we matched (for debugging). Never includes the credential itself. */
  triggerLabel: string
}

type Pattern = {
  type: SensitiveDataType
  triggerLabel: string
  match: RegExp
}

// Patterns are intentionally broad. The user can rephrase if a benign
// message gets caught — false positives are cheap, leaks are not.
// Each regex is case-insensitive and looks for trigger phrasing followed
// by content (so just the word "password" alone in "what's a strong password?"
// won't fire — but "my password is hunter2" will).
const PATTERNS: Pattern[] = [
  {
    type: 'password',
    triggerLabel: 'password phrase',
    match: /\b(?:my|the|here'?s|here is)\s+(?:sudo\s+)?(?:password|pwd|passwd)\b[\s:=]+\S/i
  },
  {
    type: 'password',
    triggerLabel: 'sudo credential',
    match: /\b(?:sudo|admin|root)\s+(?:password|pwd|passwd)\b[\s:=]+\S/i
  },
  {
    type: 'password',
    triggerLabel: 'password label',
    match: /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i
  },
  {
    type: 'api_key',
    triggerLabel: 'API key',
    match: /\b(?:api[\s_-]?key|apikey|secret[\s_-]?key|client[\s_-]?secret)\b[\s:=]+\S/i
  },
  {
    type: 'access_token',
    triggerLabel: 'access token',
    match: /\b(?:access[\s_-]?token|auth[\s_-]?token|bearer[\s_-]?token)\b[\s:=]+\S/i
  },
  {
    type: 'ssh_key',
    triggerLabel: 'SSH key marker',
    match: /-----BEGIN\s+(?:OPENSSH|RSA|DSA|EC|PGP)\s+PRIVATE KEY-----/i
  },
  {
    type: 'private_key',
    triggerLabel: 'private key phrase',
    match: /\b(?:private[\s_-]?key|ssh[\s_-]?key)\b[\s:=]+\S/i
  }
]

/**
 * Scan a user message for credential patterns. Returns the first match
 * or null. Never returns the credential content — only the type.
 */
export function detectSensitiveData(message: string): SensitiveDataMatch | null {
  if (!message || typeof message !== 'string') return null
  for (const pattern of PATTERNS) {
    if (pattern.match.test(message)) {
      return { type: pattern.type, triggerLabel: pattern.triggerLabel }
    }
  }
  return null
}

/**
 * The text Wolffish replies with when it discards a credential. Kept here
 * (not in i18n) because the security message must always render, even if
 * locale loading fails.
 */
export const CREDENTIAL_BLOCKED_REPLY =
  "I detected what looks like a credential in your message. I've discarded it and it won't be stored anywhere. I never accept passwords or keys through chat — if I need admin access, I'll show you a secure system password prompt instead."
