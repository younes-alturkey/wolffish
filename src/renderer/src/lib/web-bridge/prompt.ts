/**
 * A prompt the web bridge can raise from outside React — the one place a
 * browser has no native equivalent of a folder picker, so the sheet browses
 * the server's folders instead (or takes a typed path). The host component (WebPromptHost) registers
 * the renderer; until it mounts, the browser's own prompt() stands in.
 */
export type WebPromptOptions = {
  title: string
  description?: string
  placeholder?: string
  defaultValue?: string
  /** Returns an error message to show, or null to accept. */
  validate?: (value: string) => Promise<string | null> | string | null
  /** Browse the server's folders instead of only typing a path; `defaultValue` is where it opens. */
  browse?: 'directory'
}

type PromptHandler = (options: WebPromptOptions) => Promise<string | null>

let handler: PromptHandler | null = null

export function registerWebPrompt(next: PromptHandler | null): void {
  handler = next
}

export async function webPrompt(options: WebPromptOptions): Promise<string | null> {
  if (handler) return handler(options)
  const value = window.prompt(options.title, options.defaultValue ?? '')
  if (value === null) return null
  const error = options.validate ? await options.validate(value) : null
  if (error) {
    window.alert(error)
    return null
  }
  return value
}
