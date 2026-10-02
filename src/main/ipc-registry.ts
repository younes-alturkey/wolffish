import { ipcMain, type IpcMainInvokeEvent } from 'electron'

/**
 * A thin wrapper over `ipcMain.handle` that ALSO keeps the handler in a map.
 *
 * The renderer reaches these over IPC; the CLI reaches the same functions over
 * its local socket. Registering once, in one place, is what makes "the CLI
 * supports every setting the UI has" true by construction instead of by
 * discipline — there is no second surface to extend when a panel gains a
 * toggle, and no list that can silently fall behind.
 *
 * Electron gives no way to invoke a registered handler from the main process
 * (there is no `ipcMain.invoke`), which is the whole reason the map exists.
 *
 * Only three of the app's handlers read the IpcMainInvokeEvent at all — two
 * spellcheck calls and one OAuth window — and all three are refused by name in
 * the CLI server, so socket callers passing `null` for it is honest rather
 * than a stub that would misbehave under a caller that did use it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IpcHandler = (event: any, ...args: any[]) => any

export const ipcHandlers = new Map<string, IpcHandler>()

export function handle(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => any
): void {
  ipcHandlers.set(channel, listener as IpcHandler)
  ipcMain.handle(channel, listener)
}
