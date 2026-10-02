import { diskWriter } from '@main/io/diskWriter'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONVERSATIONS_DIR = join(homedir(), '.wolffish', 'workspace', 'brain', 'conversations')

const LOGS_DIR = join(homedir(), '.wolffish', 'workspace', 'logs', 'extension')
let ready: Promise<void> | null = null

function ensureDir(): Promise<void> {
  if (!ready) ready = mkdir(LOGS_DIR, { recursive: true }).then(() => {})
  return ready
}

export type ExtensionEventType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'read'
  | 'tab'
  | 'script'
  | 'cookie'
  | 'wait'
  | 'screenshot'
  | 'scroll'
  | 'download'
  | 'debugger'
  | 'move'
  | 'unknown'

export interface ExtensionEvent {
  id: string
  type: ExtensionEventType
  title: string
  timestamp: number
  /**
   * Stable id of the browser instance that executed the command. Scopes the
   * extension side panel: each browser lists only conversations it ran.
   * Absent on events written before multi-browser shipped.
   */
  instanceId?: string
}

const COMMAND_EVENT_MAP: Record<string, ExtensionEventType> = {
  browser_navigate: 'navigate',
  browser_back: 'navigate',
  browser_forward: 'navigate',
  browser_reload: 'navigate',
  browser_click: 'click',
  browser_hover: 'click',
  browser_focus: 'click',
  browser_drag_drop: 'click',
  browser_file_upload: 'click',
  browser_type: 'type',
  browser_select: 'type',
  browser_keypress: 'type',
  browser_scroll: 'scroll',
  browser_read_page: 'read',
  browser_query_selector: 'read',
  browser_get_attribute: 'read',
  browser_get_value: 'read',
  browser_get_url: 'read',
  browser_get_page_info: 'read',
  browser_tabs_list: 'tab',
  browser_tab_open: 'tab',
  browser_tab_close: 'tab',
  browser_tab_switch: 'tab',
  browser_tab_duplicate: 'tab',
  browser_tab_move: 'tab',
  browser_windows_list: 'tab',
  browser_window_open: 'tab',
  browser_window_close: 'tab',
  browser_window_resize: 'tab',
  browser_set_activity: 'tab',
  browser_execute_js: 'script',
  browser_cookies_get: 'cookie',
  browser_cookies_set: 'cookie',
  browser_cookies_remove: 'cookie',
  browser_storage_get: 'cookie',
  browser_storage_set: 'cookie',
  browser_wait_for: 'wait',
  browser_wait_for_navigation: 'wait',
  browser_wait_for_network_idle: 'wait',
  browser_screenshot: 'screenshot',
  browser_pdf: 'screenshot',
  browser_download: 'download',
  browser_clipboard_read: 'download',
  browser_clipboard_write: 'download',
  browser_notify: 'download',
  browser_debugger_attach: 'debugger',
  browser_debugger_detach: 'debugger',
  browser_debugger_status: 'debugger',
  browser_mouse_move: 'move',
  browser_humanize: 'move',
  // Every wire command the extension defines (packages/shared/lib/wolffish/
  // commands.ts) has a row here — an unmapped command logs as 'unknown' and
  // the side panel renders it without an icon, which reads as a bug.
  browser_wait: 'wait',
  browser_set_value: 'type',
  browser_submit_form: 'click',
  browser_mouse_click: 'click',
  browser_mouse_down: 'click',
  browser_mouse_up: 'click',
  browser_mouse_drag: 'click',
  browser_element_from_point: 'read',
  browser_get_interactive_elements: 'read',
  browser_take_snapshot: 'read',
  browser_resolve_uid: 'read',
  browser_find: 'read',
  browser_fill: 'type',
  browser_fill_form: 'type',
  browser_list_network_requests: 'read',
  browser_get_network_request: 'read',
  browser_list_console_messages: 'read',
  browser_handle_dialog: 'click',
  browser_emulate: 'debugger',
  browser_doctor: 'debugger'
}

/** "uid=3_4" or the selector — whichever the command targeted. */
function targetOf(params: Record<string, unknown>, fallback: string): string {
  if (typeof params.uid === 'string' && params.uid) return `uid=${params.uid}`
  if (typeof params.selector === 'string' && params.selector) return params.selector
  return fallback
}

function buildTitle(commandType: string, params: Record<string, unknown>): string {
  switch (commandType) {
    case 'browser_navigate':
      return `Navigated to ${params.url ?? 'page'}`
    case 'browser_back':
      return 'Navigated back'
    case 'browser_forward':
      return 'Navigated forward'
    case 'browser_reload':
      return 'Reloaded page'
    case 'browser_click':
      return `Clicked ${params.selector ?? 'element'}`
    case 'browser_hover':
      return `Hovered ${params.selector ?? 'element'}`
    case 'browser_focus':
      return `Focused ${params.selector ?? 'element'}`
    case 'browser_drag_drop':
      return `Dragged ${params.sourceSelector ?? 'element'}`
    case 'browser_file_upload':
      return `Uploaded file to ${params.selector ?? 'input'}`
    case 'browser_type':
      return `Typed into ${params.selector ?? 'input'}`
    case 'browser_select':
      return `Selected in ${params.selector ?? 'dropdown'}`
    case 'browser_keypress':
      return `Pressed ${params.key ?? 'key'}`
    case 'browser_scroll':
      return `Scrolled ${params.direction ?? 'down'}`
    case 'browser_read_page':
      return `Read page as ${params.format ?? 'text'}`
    case 'browser_query_selector':
      return `Queried ${params.selector ?? 'elements'}`
    case 'browser_get_attribute':
      return `Read attributes of ${params.selector ?? 'element'}`
    case 'browser_get_value':
      return `Read value of ${params.selector ?? 'element'}`
    case 'browser_get_url':
      return 'Read current URL'
    case 'browser_get_page_info':
      return 'Read page info'
    case 'browser_tabs_list':
      return 'Listed tabs'
    case 'browser_tab_open':
      return `Opened tab${params.url ? ` ${params.url}` : ''}`
    case 'browser_tab_close':
      return `Closed tab #${params.tabId ?? ''}`
    case 'browser_tab_switch':
      return `Switched to tab #${params.tabId ?? ''}`
    case 'browser_tab_duplicate':
      return `Duplicated tab #${params.tabId ?? ''}`
    case 'browser_tab_move':
      return `Moved tab #${params.tabId ?? ''}`
    case 'browser_windows_list':
      return 'Listed windows'
    case 'browser_window_open':
      return 'Opened window'
    case 'browser_window_close':
      return `Closed window #${params.windowId ?? ''}`
    case 'browser_window_resize':
      return `Resized window #${params.windowId ?? ''}`
    case 'browser_execute_js':
      return `Executed JS${params.world ? ` in ${params.world}` : ''}`
    case 'browser_cookies_get':
      return `Read cookies for ${params.domain ?? 'domain'}`
    case 'browser_cookies_set':
      return `Set cookie for ${params.url ?? 'domain'}`
    case 'browser_cookies_remove':
      return `Removed cookie for ${params.url ?? 'domain'}`
    case 'browser_storage_get':
      return `Read ${params.type ?? 'local'} storage`
    case 'browser_storage_set':
      return `Set ${params.type ?? 'local'} storage`
    case 'browser_wait_for':
      return `Waited for ${params.selector ?? 'condition'}`
    case 'browser_wait_for_navigation':
      return 'Waited for navigation'
    case 'browser_wait_for_network_idle':
      return 'Waited for network idle'
    case 'browser_screenshot':
      return `Captured ${params.fullPage ? 'full page' : (params.selector ?? 'visible tab')}`
    case 'browser_pdf':
      return 'Captured PDF'
    case 'browser_download':
      return `Downloaded ${params.filename ?? params.url ?? 'file'}`
    case 'browser_clipboard_read':
      return 'Read clipboard'
    case 'browser_clipboard_write':
      return 'Wrote clipboard'
    case 'browser_notify':
      return `Notified: ${params.title ?? 'notification'}`
    case 'browser_set_activity':
      return `Tab group: ${[params.emoji, params.text].filter(Boolean).join(' ') || 'Wolffish'}`
    case 'browser_debugger_attach':
      return `Debugger attached to tab #${params.tabId ?? ''}`
    case 'browser_debugger_detach':
      return 'Debugger detached'
    case 'browser_debugger_status':
      return 'Debugger status checked'
    case 'browser_mouse_move':
      return `Moved to (${params.x ?? '?'}, ${params.y ?? '?'})`
    case 'browser_humanize':
      return `Humanize: ${params.intensity ?? 'default'}`
    case 'browser_wait':
      return params.selector
        ? `Waited for ${params.selector}`
        : `Waited ${params.ms ?? params.timeout_ms ?? params.timeout ?? ''} ms`.replace('  ', ' ')
    case 'browser_set_value':
      return `Set value of ${targetOf(params, 'input')}`
    case 'browser_submit_form':
      return `Submitted ${params.selector ?? 'form'}`
    case 'browser_mouse_click':
      return params.x !== undefined && params.y !== undefined
        ? `Clicked at (${params.x}, ${params.y})`
        : `Clicked ${targetOf(params, 'element')}`
    case 'browser_mouse_down':
      return params.x !== undefined && params.y !== undefined
        ? `Pressed at (${params.x}, ${params.y})`
        : `Pressed ${targetOf(params, 'element')}`
    case 'browser_mouse_up':
      return params.x !== undefined && params.y !== undefined
        ? `Released at (${params.x}, ${params.y})`
        : `Released ${targetOf(params, 'element')}`
    case 'browser_mouse_drag':
      return params.from_uid
        ? `Dragged uid=${params.from_uid} to uid=${params.to_uid ?? '?'}`
        : params.sourceSelector
          ? `Dragged ${params.sourceSelector} to ${params.targetSelector ?? 'target'}`
          : `Dragged (${params.startX ?? '?'}, ${params.startY ?? '?'}) to (${params.endX ?? '?'}, ${params.endY ?? '?'})`
    case 'browser_element_from_point':
      return `Inspected element at (${params.x ?? '?'}, ${params.y ?? '?'})`
    case 'browser_get_interactive_elements':
      return 'Listed interactive elements'
    case 'browser_take_snapshot':
      return `Took ${params.verbose ? 'verbose ' : ''}page snapshot`
    case 'browser_resolve_uid':
      return `Resolved uid=${params.uid ?? '?'}`
    case 'browser_find':
      return `Searched for "${params.query ?? ''}"`
    case 'browser_fill':
      return `Filled ${targetOf(params, 'field')}`
    case 'browser_fill_form': {
      const count = Array.isArray(params.elements) ? params.elements.length : 0
      return `Filled ${count} field${count === 1 ? '' : 's'}`
    }
    case 'browser_list_network_requests':
      return 'Listed network requests'
    case 'browser_get_network_request':
      return `Read network request #${params.reqid ?? ''}`
    case 'browser_list_console_messages':
      return 'Listed console messages'
    case 'browser_handle_dialog':
      return `${params.action === 'dismiss' ? 'Dismissed' : 'Accepted'} dialog`
    case 'browser_emulate':
      return `Emulated ${[params.viewport, params.colorScheme, params.networkConditions].filter(Boolean).join(', ') || 'device'}`
    case 'browser_doctor':
      return 'Checked extension readiness'
    default:
      return commandType.replace(/_/g, ' ')
  }
}

export async function logEvent(
  conversationId: string,
  commandType: string,
  params: Record<string, unknown>,
  instanceId?: string | null
): Promise<ExtensionEvent> {
  const eventType = COMMAND_EVENT_MAP[commandType] ?? 'unknown'
  const event: ExtensionEvent = {
    id: randomUUID(),
    type: eventType,
    title: buildTitle(commandType, params),
    timestamp: Date.now(),
    ...(instanceId ? { instanceId } : {})
  }
  try {
    await ensureDir()
    const file = join(LOGS_DIR, `${conversationId}.jsonl`)
    await diskWriter.appendLine(file, JSON.stringify(event) + '\n')
  } catch {
    // never let logging break tool execution
  }
  return event
}

export async function readEvents(conversationId: string): Promise<ExtensionEvent[]> {
  try {
    await ensureDir()
    const raw = await readFile(join(LOGS_DIR, `${conversationId}.jsonl`), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ExtensionEvent)
  } catch {
    return []
  }
}

export interface ConversationSummary {
  conversationId: string
  title: string
  eventCount: number
  lastTimestamp: number
  /**
   * Browser instances that ran events in this conversation (null entry =
   * pre-multi-browser events). Server-side scoping only — stripped before
   * the summary is pushed to a side panel.
   */
  instanceIds?: Array<string | null>
}

export async function lookupTitle(conversationId: string): Promise<string> {
  if (conversationId.startsWith('test-') || conversationId === '_test') {
    return 'extensionTest'
  }
  try {
    const safe = (conversationId ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
    const filePath = join(CONVERSATIONS_DIR, `conv-${safe}.json`)
    const raw = await readFile(filePath, 'utf8')
    const conv = JSON.parse(raw) as { title?: string }
    return conv.title || 'Untitled'
  } catch {
    return 'Untitled'
  }
}

export async function listConversations(): Promise<ConversationSummary[]> {
  try {
    await ensureDir()
    const files = await readdir(LOGS_DIR)
    const summaries: ConversationSummary[] = []
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const conversationId = file.slice(0, -6)
      try {
        const raw = await readFile(join(LOGS_DIR, file), 'utf8')
        const lines = raw.split('\n').filter(Boolean)
        if (lines.length === 0) continue
        const instances = new Set<string | null>()
        for (const line of lines) {
          try {
            instances.add((JSON.parse(line) as ExtensionEvent).instanceId ?? null)
          } catch {
            // skip corrupt line
          }
        }
        const last = JSON.parse(lines[lines.length - 1]) as ExtensionEvent
        const title = await lookupTitle(conversationId)
        summaries.push({
          conversationId,
          title,
          eventCount: lines.length,
          lastTimestamp: last.timestamp,
          instanceIds: [...instances]
        })
      } catch {
        continue
      }
    }
    summaries.sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    return summaries
  } catch {
    return []
  }
}
