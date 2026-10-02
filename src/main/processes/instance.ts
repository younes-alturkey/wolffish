import { WORKSPACE_ROOT } from '@main/workspace/root'
import { ProcessManager } from './manager'

/**
 * The one process manager. Constructed on import (cheap: no I/O until
 * init()), initialised by main once the workspace is ready, and read by the
 * Agent for the runtime tail and the per-turn card emitter — the countdowns
 * singleton pattern.
 */
export const processManager = new ProcessManager(WORKSPACE_ROOT)
