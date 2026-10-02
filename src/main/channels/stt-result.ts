/**
 * Parsers for stt_transcribe tool output, shared by every channel that
 * transcribes voice notes (Telegram, Mobile). The plugin returns a JSON blob
 * shaped like `{ "text": "...", "language": "...", "segments": [...] }`;
 * older / alternate plugin shapes might just print the transcript as a bare
 * string — both are handled.
 */

/** Plain transcript text, or the empty string when nothing usable is there. */
export function extractTranscript(rawOutput: string): string {
  const trimmed = rawOutput.trim()
  if (trimmed.length === 0) return ''
  try {
    const parsed = JSON.parse(trimmed) as { text?: unknown }
    if (parsed && typeof parsed.text === 'string') return parsed.text.trim()
  } catch {
    // not JSON; fall through to raw
  }
  return trimmed
}

/**
 * Whisper's detected language (ISO 639-1, e.g. "en"), or '' when absent or
 * unparseable — callers treat that as "no signal" and fall back to the plain
 * <voice_note> tag.
 */
export function extractVoiceLanguage(rawOutput: string): string {
  const trimmed = rawOutput.trim()
  if (trimmed.length === 0) return ''
  try {
    const parsed = JSON.parse(trimmed) as { language?: unknown }
    if (parsed && typeof parsed.language === 'string') return parsed.language.trim()
  } catch {
    // not JSON
  }
  return ''
}
