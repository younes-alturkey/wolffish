/**
 * The master-password policy, in one place both ends read: the main process
 * refuses a password it fails (auth.ts) and the settings panel shows the
 * meter under the field while the user types. Pure — no Node, no DOM — so
 * the renderer bundle can import it as-is.
 *
 * The score is deliberately simple and explainable: length earns up to three
 * points, each character class beyond the first earns one, and two patterns
 * a guesser tries first (a well-known password, a run of one repeated or
 * sequential character) zero it out. Four points is the floor — a 12-character
 * mix of three classes, or a 16-character two-class passphrase, both pass;
 * `password123` and `12345678` do not.
 */

export const PASSWORD_MIN_LENGTH = 10
export const PASSWORD_MAX_LENGTH = 256

export type PasswordLevel = 'weak' | 'fair' | 'good' | 'strong'

export type PasswordStrength = {
  /** 0–6 */
  score: number
  level: PasswordLevel
  /** What would raise the score, as hint keys for the UI (empty when acceptable). */
  hints: Array<'length' | 'mix' | 'common' | 'repeat'>
  acceptable: boolean
}

/** The floor of the score an acceptable password must reach. */
export const PASSWORD_MIN_SCORE = 4

const COMMON = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwerty123',
  'qwertyuiop',
  'letmein',
  'welcome1',
  'admin123',
  'iloveyou',
  '1234567890',
  '0987654321',
  'abc123456',
  'wolffish',
  'wolffish123',
  'changeme',
  'trustno1',
  'baseball',
  'football',
  'sunshine',
  'princess',
  'dragon123',
  'monkey123',
  'master123',
  'superman',
  'shadow123',
  'mustang1',
  'michael1',
  'jennifer',
  'computer'
])

function isRepeatOrSequence(password: string): boolean {
  const lower = password.toLowerCase()
  if (/^(.)\1+$/.test(lower)) return true
  let ascending = true
  let descending = true
  for (let i = 1; i < lower.length; i++) {
    const delta = lower.charCodeAt(i) - lower.charCodeAt(i - 1)
    if (delta !== 1) ascending = false
    if (delta !== -1) descending = false
  }
  return lower.length >= 4 && (ascending || descending)
}

export function scorePassword(password: string): PasswordStrength {
  const text = typeof password === 'string' ? password : ''
  const hints: PasswordStrength['hints'] = []
  if (text.length === 0) return { score: 0, level: 'weak', hints: ['length'], acceptable: false }

  // Length is the strongest signal there is, and a passphrase gets most of
  // its strength from it alone: twelve words of lowercase letters and spaces
  // are two classes, so without the fourth tier a 128-bit phrase would rate
  // below a 13-character mixed password.
  let score = 0
  if (text.length >= 8) score++
  if (text.length >= 12) score++
  if (text.length >= 16) score++
  if (text.length >= 24) score++

  const classes =
    Number(/[a-z]/.test(text)) +
    Number(/[A-Z]/.test(text)) +
    Number(/[0-9]/.test(text)) +
    Number(/[^A-Za-z0-9]/.test(text))
  score += Math.max(0, classes - 1)

  // A well-known word dressed up — `P@ssw0rd!!`, `letmein1` — is the first
  // thing a guesser tries, so a short tail of digits and symbols is stripped
  // and the usual letter swaps undone before the lookup.
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const tail = /[^A-Za-z]+$/.exec(text)?.[0] ?? ''
  const base = tail.length <= 3 ? text.slice(0, text.length - tail.length) : text
  const leet = base
    .toLowerCase()
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[^a-z]/g, '')
  if (
    COMMON.has(normalized) ||
    COMMON.has(text.toLowerCase()) ||
    (tail.length <= 3 && COMMON.has(leet))
  ) {
    score = 0
    hints.push('common')
  } else if (isRepeatOrSequence(text)) {
    score = 0
    hints.push('repeat')
  }

  if (text.length < PASSWORD_MIN_LENGTH) hints.push('length')
  if (classes < 2 && !hints.includes('common') && !hints.includes('repeat')) hints.push('mix')
  if (score < PASSWORD_MIN_SCORE && hints.length === 0)
    hints.push(text.length < 16 ? 'length' : 'mix')

  const level: PasswordLevel =
    score <= 2 ? 'weak' : score === 3 ? 'fair' : score === 4 ? 'good' : 'strong'
  const acceptable =
    text.length >= PASSWORD_MIN_LENGTH &&
    text.length <= PASSWORD_MAX_LENGTH &&
    score >= PASSWORD_MIN_SCORE
  return { score, level, hints: acceptable ? [] : hints, acceptable }
}
