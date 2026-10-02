/**
 * Run a classic (line-mode) verb from inside the TUI: suspend the renderer,
 * run the old command on the plain terminal, wait for Enter, repaint.
 */
import type { AppContext } from '../context'
import { pressEnter } from '../legacy'

export async function runClassic(
  app: AppContext,
  command: string,
  args: string[] = [],
  flags: Record<string, unknown> = {}
): Promise<void> {
  const { dispatch } = await import('../../wolffish.mjs')
  app.dialog.clear()
  await app.suspend(async () => {
    try {
      await dispatch(app.client, command, args, {
        json: false,
        yes: false,
        long: false,
        all: false,
        raw: false,
        limit: null,
        prompt: null,
        files: [],
        conversation: null,
        project: null,
        plan: false,
        tools: null,
        last: null,
        verbose: app.store[0].verbose,
        ...flags
      })
    } catch (error) {
      process.stderr.write(`\n${(error as Error)?.message ?? String(error)}\n`)
    }
    await pressEnter()
  })
  await app.actions.refreshSnapshot()
}
