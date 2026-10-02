/**
 * The command registry. One table drives the palette, slash completion in the
 * prompt, the hint rows and /help. A command carries a title, a category, an
 * optional slash name with aliases, a keybind action it can be reached by,
 * an enabled predicate, and the thing it does.
 */
import type { ActionName } from './keymap'

export type Command = {
  name: string
  title: string
  category: 'Chat' | 'Controls' | 'Files' | 'Library' | 'Settings' | 'Machine' | 'View'
  description?: string
  slash?: string
  aliases?: string[]
  /** Slash commands that take an argument: shown as `/name <arg>`. */
  argHint?: string
  key?: ActionName
  enabled?: () => boolean
  hidden?: boolean
  run: (args: string) => void | Promise<void>
}

export class CommandRegistry {
  private readonly list: Command[] = []

  register(...commands: Command[]): void {
    for (const command of commands) {
      const i = this.list.findIndex((c) => c.name === command.name)
      if (i >= 0) this.list[i] = command
      else this.list.push(command)
    }
  }

  all(): Command[] {
    return this.list.filter((c) => !c.hidden && (c.enabled?.() ?? true))
  }

  byKey(action: ActionName): Command | undefined {
    return this.list.find((c) => c.key === action && (c.enabled?.() ?? true))
  }

  keyed(): ActionName[] {
    return this.list.filter((c) => c.key).map((c) => c.key as ActionName)
  }

  /** Resolve `/name args` typed into the prompt. */
  slash(input: string): { command: Command; args: string } | null {
    const match = input.match(/^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/)
    if (!match) return null
    const word = match[1].toLowerCase()
    const command = this.list.find((c) => c.slash === word || c.aliases?.includes(word))
    if (!command) return null
    return { command, args: match[2].trim() }
  }

  slashes(): Array<{ display: string; description: string; command: Command }> {
    return this.all()
      .filter((c) => c.slash)
      .map((c) => ({
        display: `/${c.slash}${c.argHint ? ` ${c.argHint}` : ''}`,
        description: c.description ?? c.title,
        command: c
      }))
      .sort((a, b) => a.display.localeCompare(b.display))
  }
}
