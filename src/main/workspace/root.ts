import os from 'node:os'
import path from 'node:path'

/**
 * The workspace root path, alone in a leaf module on purpose: workspace.ts
 * statically imports conversations.ts, conversation-titler.ts and
 * compose-attachments.ts, and they all need this path back. Living below all
 * of them keeps the import graph acyclic — add nothing here that imports from
 * the rest of the app.
 */
export const WORKSPACE_ROOT = path.join(os.homedir(), '.wolffish', 'workspace')

export function workspaceRoot(): string {
  return WORKSPACE_ROOT
}
