import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

let workspaceRoot = null


const GOG_PATH = path.join(
  os.homedir(),
  '.wolffish',
  'bin',
  process.platform === 'win32' ? 'gog.exe' : 'gog'
)

const NOT_INSTALLED_ERROR = {
  success: false,
  error:
    'Google Workspace is not installed. Open Wolffish → Settings → Services → Google Workspace and click Install.'
}

const MISSING_ACCOUNT_ERROR = {
  success: false,
  error:
    'Missing required `account` parameter. Call google_accounts to get the list of authorized account emails, then pass one as `account` on this tool. There is no default — every google_* call must specify which account to use.'
}

function run(args, timeout = 0, transform) {
  return new Promise((resolve) => {
    execFile(GOG_PATH, args, { timeout: timeout || undefined, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // gog binary is missing — point the user (and the LLM) at Settings.
        if (err.code === 'ENOENT' || /no such file or directory/i.test(err.message || '')) {
          resolve(NOT_INSTALLED_ERROR)
          return
        }
        const msg = stderr?.trim() || err.message || String(err)
        // A parse-shaped error (unknown flag / unexpected argument /
        // expected "…") means the installed gogcli's syntax differs from
        // what this plugin was audited against — an ancient install, or a
        // future gogcli that moved again. Raw parser errors send the model
        // guessing at CLI syntax (the 2026-08-22 sweep drifted into broken
        // shell pipelines exactly that way); name the actual fix instead.
        if (/unknown flag|unexpected argument|expected "/i.test(msg)) {
          resolve({
            success: false,
            error:
              `${msg}\n\nThe installed gogcli version does not match this integration. ` +
              'Ask the user to open Wolffish → Settings → Services → Google Workspace ' +
              'and click Update, then retry. Do not guess alternative CLI syntax.'
          })
          return
        }
        resolve({ success: false, error: msg })
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        // Some tools (e.g. gmail search) wrap the parsed payload with extra
        // fields like `count` and `account` so the LLM can't miscount when
        // summarizing many parallel results — pass `transform` to opt in.
        const payload = transform ? transform(parsed) : parsed
        resolve({ success: true, output: JSON.stringify(payload) })
      } catch {
        resolve({ success: true, output: stdout.trim() })
      }
    })
  })
}

// Build the gogcli base args. The `account` parameter is REQUIRED on every
// google_* call — there is intentionally no fallback to a "primary" account.
// A silent fallback masks LLM mistakes (the LLM thinks it queried account A
// when it actually hit B) and produced wrong cross-account summaries. Force
// the LLM to pass `account` explicitly; if it doesn't, fail with a clear
// error that tells it exactly how to fix the call.
function buildBase(args) {
  const acc = String(args?.account ?? '').trim()
  if (!acc) return null
  return ['--json', '--no-input', '--account', acc]
}

// Stamp the result with the resolved account and an explicit `count`. The
// LLM has been observed to summarize "0 unread" across N parallel searches
// when one of them actually returned threads — counting `<list>.length` in
// each of N JSON blobs is exactly the kind of thing a fast-summarizing LLM
// gets wrong. Echoing `count: <number>` and `account: <email>` makes the
// answer impossible to misread. We preserve the original payload as-is and
// add the two extra fields on top.
function stampCount(acc) {
  return (parsed) => {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { account: acc, count: Array.isArray(parsed) ? parsed.length : 0, result: parsed }
    }
    // Find the first array-valued field — gogcli uses different names
    // per resource (threads, files, events, contacts, items, ...) but
    // there's only ever one list per response, so picking the first is
    // unambiguous.
    let count = 0
    for (const v of Object.values(parsed)) {
      if (Array.isArray(v)) {
        count = v.length
        break
      }
    }
    return { account: acc, count, ...parsed }
  }
}

// --- Tool implementations ---

async function gmailSearch(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  const acc = base[3]
  const cmdArgs = [...base, 'gmail', 'search', args?.query ?? '']
  if (args?.max) cmdArgs.push('--max', String(args.max))
  return run(cmdArgs, 0, stampCount(acc))
}

async function gmailRead(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.id) return { success: false, error: 'id is required' }
  return run([...base, 'gmail', 'read', args.id])
}

async function gmailSend(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.to) return { success: false, error: 'to is required' }
  if (!args?.subject) return { success: false, error: 'subject is required' }
  if (!args?.body) return { success: false, error: 'body is required' }
  const cmdArgs = [
    ...base,
    'gmail',
    'send',
    '--to',
    args.to,
    '--subject',
    args.subject,
    '--body',
    args.body
  ]
  if (args?.cc) cmdArgs.push('--cc', args.cc)
  if (args?.bcc) cmdArgs.push('--bcc', args.bcc)
  if (args?.thread_id) cmdArgs.push('--thread-id', args.thread_id)
  return run(cmdArgs)
}

async function gmailMarkRead(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  const ids = args?.ids
  const query = args?.query
  if (!ids && !query) return { success: false, error: 'Either ids (array of message IDs) or query (Gmail search query) is required' }
  const cmdArgs = [...base, 'gmail', 'mark-read']
  if (query) {
    cmdArgs.push('--query', query)
    if (args?.max) cmdArgs.push('--max', String(args.max))
  } else {
    const idList = Array.isArray(ids) ? ids : [ids]
    cmdArgs.push(...idList)
  }
  return run(cmdArgs)
}

async function gmailLabels(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  const acc = base[3]
  // `labels` grew subcommands in gogcli v0.34 (list/get/create/rename/…);
  // the bare form now answers `expected one of "list", …` instead of
  // listing. This tool lists — say so.
  return run([...base, 'gmail', 'labels', 'list'], 0, stampCount(acc))
}

function buildQueryOrIds(base, subcmd, args) {
  const ids = args?.ids
  const query = args?.query
  if (!ids && !query) return null
  const cmdArgs = [...base, 'gmail', subcmd]
  if (query) {
    cmdArgs.push('--query', query)
    if (args?.max) cmdArgs.push('--max', String(args.max))
  } else {
    cmdArgs.push(...(Array.isArray(ids) ? ids : [ids]))
  }
  return cmdArgs
}

async function gmailArchive(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  const cmdArgs = buildQueryOrIds(base, 'archive', args)
  if (!cmdArgs) return { success: false, error: 'Either ids (array of message IDs) or query is required' }
  return run(cmdArgs)
}

async function gmailMarkUnread(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  const cmdArgs = buildQueryOrIds(base, 'unread', args)
  if (!cmdArgs) return { success: false, error: 'Either ids (array of message IDs) or query is required' }
  return run(cmdArgs)
}

async function gmailTrash(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  const cmdArgs = buildQueryOrIds(base, 'trash', args)
  if (!cmdArgs) return { success: false, error: 'Either ids (array of message IDs) or query is required' }
  return run(cmdArgs)
}

async function gmailForward(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.id) return { success: false, error: 'id is required' }
  if (!args?.to) return { success: false, error: 'to is required' }
  const cmdArgs = [...base, 'gmail', 'forward', '--to', args.to, args.id]
  if (args?.cc) cmdArgs.push('--cc', args.cc)
  if (args?.bcc) cmdArgs.push('--bcc', args.bcc)
  if (args?.note) cmdArgs.push('--note', args.note)
  if (args?.skip_attachments) cmdArgs.push('--skip-attachments')
  return run(cmdArgs)
}

async function gmailDraftCreate(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.subject) return { success: false, error: 'subject is required' }
  if (!args?.body) return { success: false, error: 'body is required' }
  const cmdArgs = [...base, 'gmail', 'drafts', 'create', '--subject', args.subject, '--body', args.body]
  if (args?.to) cmdArgs.push('--to', args.to)
  if (args?.cc) cmdArgs.push('--cc', args.cc)
  if (args?.bcc) cmdArgs.push('--bcc', args.bcc)
  if (args?.thread_id) cmdArgs.push('--reply-to-message-id', args.thread_id)
  return run(cmdArgs)
}

async function driveList(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  const acc = base[3]
  // gogcli v0.34 renamed `drive list` to `drive ls`.
  const cmdArgs = [...base, 'drive', 'ls']
  if (args?.parent) cmdArgs.push('--parent', args.parent)
  if (args?.max) cmdArgs.push('--max', String(args.max))
  return run(cmdArgs, 0, stampCount(acc))
}

async function driveSearch(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.query) return { success: false, error: 'query is required' }
  const acc = base[3]
  const cmdArgs = [...base, 'drive', 'search', args.query]
  if (args?.max) cmdArgs.push('--max', String(args.max))
  return run(cmdArgs, 0, stampCount(acc))
}

async function driveUpload(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.path) return { success: false, error: 'path is required' }
  const filePath = path.isAbsolute(args.path) ? args.path : path.resolve(workspaceRoot, args.path)
  const cmdArgs = [...base, 'drive', 'upload', filePath]
  if (args?.parent) cmdArgs.push('--parent', args.parent)
  if (args?.name) cmdArgs.push('--name', args.name)
  return run(cmdArgs)
}

async function driveDownload(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.file_id) return { success: false, error: 'file_id is required' }
  if (!args?.output) return { success: false, error: 'output is required' }
  const outPath = path.isAbsolute(args.output)
    ? args.output
    : path.resolve(workspaceRoot, args.output)
  return run([...base, 'drive', 'download', args.file_id, '--output', outPath])
}

async function driveDelete(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.file_id) return { success: false, error: 'file_id is required' }
  // --force skips the interactive confirmation gogcli refuses to proceed
  // without under --no-input; the file goes to trash (never --permanent),
  // and Wolffish's own approval gate is the safety layer in front of this.
  return run([...base, 'drive', 'delete', args.file_id, '--force'])
}

async function driveMkdir(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.name) return { success: false, error: 'name is required' }
  const cmdArgs = [...base, 'drive', 'mkdir', args.name]
  if (args?.parent) cmdArgs.push('--parent', args.parent)
  return run(cmdArgs)
}

async function calendarEvents(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  const acc = base[3]
  const cmdArgs = [...base, 'calendar', 'events']
  // gogcli v0.34 dropped `--range` for dedicated flags — map the tool's
  // relative vocabulary onto them ("today"/"week" have their own switches;
  // "tomorrow" is a relative --from plus a one-day window).
  if (args?.range === 'today') cmdArgs.push('--today')
  else if (args?.range === 'week') cmdArgs.push('--week')
  else if (args?.range === 'tomorrow') cmdArgs.push('--from', 'tomorrow', '--days', '1')
  if (args?.days) cmdArgs.push('--days', String(args.days))
  if (args?.from) cmdArgs.push('--from', args.from)
  if (args?.to) cmdArgs.push('--to', args.to)
  if (args?.max) cmdArgs.push('--max', String(args.max))
  return run(cmdArgs, 0, stampCount(acc))
}

async function calendarCreate(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.summary) return { success: false, error: 'summary is required' }
  if (!args?.start) return { success: false, error: 'start is required' }
  if (!args?.end) return { success: false, error: 'end is required' }
  // gogcli v0.34: `create <calendarId>` is a required positional ('primary'
  // is the account's default calendar), and start/end travel as --from/--to.
  const cmdArgs = [
    ...base,
    'calendar',
    'create',
    args?.calendar_id || 'primary',
    '--summary',
    args.summary,
    '--from',
    args.start,
    '--to',
    args.end
  ]
  if (args?.description) cmdArgs.push('--description', args.description)
  if (args?.location) cmdArgs.push('--location', args.location)
  if (args?.attendees) cmdArgs.push('--attendees', args.attendees)
  return run(cmdArgs)
}

async function calendarUpdate(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.calendar_id) return { success: false, error: 'calendar_id is required' }
  if (!args?.event_id) return { success: false, error: 'event_id is required' }
  const cmdArgs = [...base, 'calendar', 'update', args.calendar_id, args.event_id]
  if (args?.summary) cmdArgs.push('--summary', args.summary)
  if (args?.start) cmdArgs.push('--from', args.start)
  if (args?.end) cmdArgs.push('--to', args.end)
  if (args?.description) cmdArgs.push('--description', args.description)
  if (args?.location) cmdArgs.push('--location', args.location)
  if (args?.attendees) cmdArgs.push('--attendees', args.attendees)
  if (args?.add_attendee) cmdArgs.push('--add-attendee', args.add_attendee)
  if (args?.send_updates) cmdArgs.push('--send-updates', args.send_updates)
  return run(cmdArgs)
}

async function calendarDelete(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.calendar_id) return { success: false, error: 'calendar_id is required' }
  if (!args?.event_id) return { success: false, error: 'event_id is required' }
  // --force: gogcli refuses destructive commands without it under --no-input;
  // Wolffish's approval gate is the safety layer in front of this.
  const cmdArgs = [...base, 'calendar', 'delete', args.calendar_id, args.event_id, '--force']
  if (args?.send_updates) cmdArgs.push('--send-updates', args.send_updates)
  return run(cmdArgs)
}

async function contactsSearch(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.query) return { success: false, error: 'query is required' }
  const acc = base[3]
  const cmdArgs = [...base, 'contacts', 'search', args.query]
  if (args?.max) cmdArgs.push('--max', String(args.max))
  return run(cmdArgs, 0, stampCount(acc))
}

async function tasksList(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  const acc = base[3]
  const cmdArgs = [...base, 'tasks']
  if (args?.task_list_id) {
    // gogcli v0.34: the task list is a positional (`tasks list <tasklistId>`).
    cmdArgs.push('list', args.task_list_id)
    if (args?.show_completed) cmdArgs.push('--show-completed')
  } else {
    cmdArgs.push('lists')
  }
  if (args?.max) cmdArgs.push('--max', String(args.max))
  return run(cmdArgs, 0, stampCount(acc))
}

async function tasksAdd(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.task_list_id) return { success: false, error: 'task_list_id is required' }
  if (!args?.title) return { success: false, error: 'title is required' }
  // gogcli v0.34: the task list is a positional (`tasks add <tasklistId>`).
  const cmdArgs = [...base, 'tasks', 'add', args.task_list_id, '--title', args.title]
  if (args?.notes) cmdArgs.push('--notes', args.notes)
  if (args?.due) cmdArgs.push('--due', args.due)
  return run(cmdArgs)
}

async function tasksComplete(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.task_list_id) return { success: false, error: 'task_list_id is required' }
  if (!args?.task_id) return { success: false, error: 'task_id is required' }
  return run([...base, 'tasks', 'done', args.task_list_id, args.task_id])
}

async function tasksDelete(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.task_list_id) return { success: false, error: 'task_list_id is required' }
  if (!args?.task_id) return { success: false, error: 'task_id is required' }
  // --force: same non-interactive confirmation rule as the other deletes.
  return run([...base, 'tasks', 'delete', args.task_list_id, args.task_id, '--force'])
}

async function contactsCreate(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.given) return { success: false, error: 'given (first name) is required' }
  const cmdArgs = [...base, 'contacts', 'create', '--given', args.given]
  if (args?.family) cmdArgs.push('--family', args.family)
  if (args?.email) cmdArgs.push('--email', args.email)
  if (args?.phone) cmdArgs.push('--phone', args.phone)
  if (args?.org) cmdArgs.push('--org', args.org)
  if (args?.title) cmdArgs.push('--title', args.title)
  if (args?.note) cmdArgs.push('--note', args.note)
  return run(cmdArgs)
}

async function sheetsRead(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.spreadsheet_id) return { success: false, error: 'spreadsheet_id is required' }
  if (!args?.range) return { success: false, error: 'range is required' }
  // gogcli v0.34: the range is a positional (`sheets get <id> <range>`).
  return run([...base, 'sheets', 'read', args.spreadsheet_id, args.range])
}

async function sheetsWrite(args) {
  const base = buildBase(args)
  if (!base) return MISSING_ACCOUNT_ERROR
  if (!args?.spreadsheet_id) return { success: false, error: 'spreadsheet_id is required' }
  if (!args?.range) return { success: false, error: 'range is required' }
  if (!args?.values) return { success: false, error: 'values is required' }
  // gogcli v0.34: `sheets update <id> <range>` with the 2D array on
  // --values-json (positional values are comma/pipe text, wrong for JSON).
  const cmdArgs = [
    ...base,
    'sheets',
    'update',
    args.spreadsheet_id,
    args.range,
    '--values-json',
    JSON.stringify(args.values)
  ]
  return run(cmdArgs)
}

async function googleAccounts() {
  return new Promise((resolve) => {
    execFile(
      GOG_PATH,
      ['--json', '--no-input', 'auth', 'list'],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT' || /no such file or directory/i.test(err.message || '')) {
            resolve(NOT_INSTALLED_ERROR)
            return
          }
          const msg = stderr?.trim() || err.message || String(err)
          resolve({ success: false, error: msg })
          return
        }
        let list = []
        try {
          const parsed = JSON.parse(stdout)
          const items = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.accounts)
              ? parsed.accounts
              : []
          list = items
            .map((a) => String(a?.email ?? a?.account ?? '').trim())
            .filter(Boolean)
        } catch {
          /* fall through with empty list */
        }
        const payload = {
          accounts: list,
          note:
            'Every google_* tool call REQUIRES an explicit `account` parameter — there is no default account. Pick the email from `accounts` above. For identity-agnostic requests like "check my email", call the tool once per entry in `accounts` (in parallel) and aggregate the results.'
        }
        resolve({ success: true, output: JSON.stringify(payload) })
      }
    )
  })
}

// --- Tool descriptors ---

const toolDefinitions = [
  {
    name: 'google_gmail_search',
    description:
      'Search Gmail messages by query. Supports Gmail search operators (from:, to:, subject:, has:attachment, is:unread, etc).',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        query: { type: 'string', description: 'Gmail search query' },
        max: { type: 'number', description: 'Maximum results (default 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'google_gmail_read',
    description: 'Read a full email thread by ID. Returns all messages with headers, body, and attachment metadata.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        id: { type: 'string', description: 'Thread or message ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'google_gmail_send',
    description: 'Send a new email. For replies, include the thread_id.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        to: { type: 'string', description: 'Recipient (comma-separated for multiple)' },
        subject: { type: 'string', description: 'Subject line' },
        body: { type: 'string', description: 'Email body (plain text)' },
        cc: { type: 'string', description: 'CC recipients' },
        bcc: { type: 'string', description: 'BCC recipients' },
        thread_id: { type: 'string', description: 'Thread ID to reply to' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'google_gmail_labels',
    description: 'List all Gmail labels with IDs and message counts.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        }
      },
      required: []
    }
  },
  {
    name: 'google_gmail_mark_read',
    description: 'Mark messages as read. Provide either specific message IDs or a Gmail search query to mark all matching messages.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use. Pass to switch between authorized Google accounts.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Array of message IDs to mark as read' },
        query: { type: 'string', description: 'Gmail search query — marks all matching messages as read (alternative to ids)' },
        max: { type: 'number', description: 'Max messages to mark when using query (default 100)' }
      },
      required: []
    }
  },
  {
    name: 'google_gmail_archive',
    description: 'Archive messages (remove from inbox without deleting). Provide message IDs or a Gmail search query.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Array of message IDs to archive' },
        query: { type: 'string', description: 'Gmail search query — archives all matching messages (alternative to ids)' },
        max: { type: 'number', description: 'Max messages to archive when using query (default 100)' }
      },
      required: []
    }
  },
  {
    name: 'google_gmail_mark_unread',
    description: 'Mark messages as unread. Provide message IDs or a Gmail search query.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Array of message IDs to mark as unread' },
        query: { type: 'string', description: 'Gmail search query — marks all matching messages as unread (alternative to ids)' },
        max: { type: 'number', description: 'Max messages when using query (default 100)' }
      },
      required: []
    }
  },
  {
    name: 'google_gmail_trash',
    description: 'Move messages to trash. Provide message IDs or a Gmail search query.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Array of message IDs to trash' },
        query: { type: 'string', description: 'Gmail search query — trashes all matching messages (alternative to ids)' },
        max: { type: 'number', description: 'Max messages when using query (default 100)' }
      },
      required: []
    }
  },
  {
    name: 'google_gmail_forward',
    description: 'Forward a message to new recipients.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to send from.' },
        id: { type: 'string', description: 'Message ID to forward' },
        to: { type: 'string', description: 'Recipients (comma-separated)' },
        cc: { type: 'string', description: 'CC recipients (comma-separated)' },
        bcc: { type: 'string', description: 'BCC recipients (comma-separated)' },
        note: { type: 'string', description: 'Introductory text above the forwarded message' },
        skip_attachments: { type: 'boolean', description: 'Do not include original attachments' }
      },
      required: ['id', 'to']
    }
  },
  {
    name: 'google_gmail_draft_create',
    description: 'Save a draft email without sending. Use for staged composing before the user confirms.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to draft from.' },
        to: { type: 'string', description: 'Recipients (comma-separated)' },
        subject: { type: 'string', description: 'Subject line' },
        body: { type: 'string', description: 'Email body (plain text)' },
        cc: { type: 'string', description: 'CC recipients' },
        bcc: { type: 'string', description: 'BCC recipients' },
        thread_id: { type: 'string', description: 'Reply to this message ID (sets threading headers)' }
      },
      required: ['subject', 'body']
    }
  },
  {
    name: 'google_drive_list',
    description: 'List files in Google Drive, optionally filtered by parent folder.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        parent: { type: 'string', description: 'Parent folder ID (omit for root)' },
        max: { type: 'number', description: 'Maximum results (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'google_drive_search',
    description: 'Search Google Drive files by name or content.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        query: { type: 'string', description: 'Search query' },
        max: { type: 'number', description: 'Maximum results (default 20)' }
      },
      required: ['query']
    }
  },
  {
    name: 'google_drive_upload',
    description: 'Upload a local file to Google Drive.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        path: { type: 'string', description: 'Local file path' },
        parent: { type: 'string', description: 'Parent folder ID' },
        name: { type: 'string', description: 'Override filename in Drive' }
      },
      required: ['path']
    }
  },
  {
    name: 'google_drive_download',
    description: 'Download a file from Google Drive to a local path.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        file_id: { type: 'string', description: 'Drive file ID' },
        output: { type: 'string', description: 'Local output path' }
      },
      required: ['file_id', 'output']
    }
  },
  {
    name: 'google_drive_delete',
    description: 'Move a Drive file to trash.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        file_id: { type: 'string', description: 'Drive file ID to delete' }
      },
      required: ['file_id']
    }
  },
  {
    name: 'google_drive_mkdir',
    description: 'Create a new folder in Google Drive.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        name: { type: 'string', description: 'Folder name' },
        parent: { type: 'string', description: 'Parent folder ID (omit for root)' }
      },
      required: ['name']
    }
  },
  {
    name: 'google_calendar_events',
    description: 'List upcoming calendar events. Supports relative ranges (today, tomorrow, week) or explicit dates.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        range: { type: 'string', description: '"today", "tomorrow", "week"' },
        days: { type: 'number', description: 'Days ahead to look' },
        from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
        max: { type: 'number', description: 'Maximum events (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'google_calendar_create',
    description: 'Create a new calendar event.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        summary: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time (ISO 8601)' },
        end: { type: 'string', description: 'End time (ISO 8601)' },
        description: { type: 'string', description: 'Event description' },
        location: { type: 'string', description: 'Event location' },
        attendees: { type: 'string', description: 'Attendee emails (comma-separated)' }
      },
      required: ['summary', 'start', 'end']
    }
  },
  {
    name: 'google_calendar_update',
    description: 'Update an existing calendar event — reschedule, rename, change attendees, etc.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        calendar_id: { type: 'string', description: 'Calendar ID (use the account email for the primary calendar)' },
        event_id: { type: 'string', description: 'Event ID (from google_calendar_events)' },
        summary: { type: 'string', description: 'New event title' },
        start: { type: 'string', description: 'New start time (ISO 8601)' },
        end: { type: 'string', description: 'New end time (ISO 8601)' },
        description: { type: 'string', description: 'New description' },
        location: { type: 'string', description: 'New location' },
        attendees: { type: 'string', description: 'Replace all attendees (comma-separated emails)' },
        add_attendee: { type: 'string', description: 'Add attendees without replacing existing ones (comma-separated)' },
        send_updates: { type: 'string', description: '"all", "externalOnly", or "none" (default none)' }
      },
      required: ['calendar_id', 'event_id']
    }
  },
  {
    name: 'google_calendar_delete',
    description: 'Delete a calendar event.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        calendar_id: { type: 'string', description: 'Calendar ID (use the account email for the primary calendar)' },
        event_id: { type: 'string', description: 'Event ID (from google_calendar_events)' },
        send_updates: { type: 'string', description: '"all", "externalOnly", or "none" (default none)' }
      },
      required: ['calendar_id', 'event_id']
    }
  },
  {
    name: 'google_contacts_search',
    description: 'Search Google Contacts by name, email, or phone number.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        query: { type: 'string', description: 'Search query' },
        max: { type: 'number', description: 'Maximum results (default 20)' }
      },
      required: ['query']
    }
  },
  {
    name: 'google_tasks_list',
    description:
      'List Google Tasks. Without task_list_id returns all task lists. With task_list_id returns tasks in that list.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        task_list_id: { type: 'string', description: 'Task list ID (omit to list all lists)' },
        max: { type: 'number', description: 'Maximum results (default 20)' },
        show_completed: { type: 'boolean', description: 'Include completed tasks' }
      },
      required: []
    }
  },
  {
    name: 'google_tasks_add',
    description: 'Add a new task to a task list.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        task_list_id: { type: 'string', description: 'Task list ID' },
        title: { type: 'string', description: 'Task title' },
        notes: { type: 'string', description: 'Task notes' },
        due: { type: 'string', description: 'Due date (YYYY-MM-DD)' }
      },
      required: ['task_list_id', 'title']
    }
  },
  {
    name: 'google_tasks_complete',
    description: 'Mark a task as completed.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        task_list_id: { type: 'string', description: 'Task list ID' },
        task_id: { type: 'string', description: 'Task ID' }
      },
      required: ['task_list_id', 'task_id']
    }
  },
  {
    name: 'google_tasks_delete',
    description: 'Delete a task permanently.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        task_list_id: { type: 'string', description: 'Task list ID' },
        task_id: { type: 'string', description: 'Task ID' }
      },
      required: ['task_list_id', 'task_id']
    }
  },
  {
    name: 'google_contacts_create',
    description: 'Create a new Google contact.',
    parameters: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account email to use.' },
        given: { type: 'string', description: 'First / given name (required)' },
        family: { type: 'string', description: 'Last / family name' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        org: { type: 'string', description: 'Organization / company name' },
        title: { type: 'string', description: 'Job title' },
        note: { type: 'string', description: 'Notes / biography' }
      },
      required: ['given']
    }
  },
  {
    name: 'google_sheets_read',
    description: 'Read data from a Google Sheets spreadsheet.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        spreadsheet_id: { type: 'string', description: 'Spreadsheet ID' },
        range: { type: 'string', description: 'A1 notation range (e.g. "Sheet1!A1:D10")' }
      },
      required: ['spreadsheet_id', 'range']
    }
  },
  {
    name: 'google_sheets_write',
    description: 'Write data to a Google Sheets spreadsheet.',
    parameters: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description:
            'Account email to use. REQUIRED — there is no default: call google_accounts first and pass one of the emails it lists. Never invent or placeholder this value.'
        },
        spreadsheet_id: { type: 'string', description: 'Spreadsheet ID' },
        range: { type: 'string', description: 'A1 notation range to write to' },
        values: { type: 'array', description: '2D array of values' }
      },
      required: ['spreadsheet_id', 'range', 'values']
    }
  },
  {
    name: 'google_accounts',
    description:
      'List the Google accounts the user has authorized in Wolffish, plus which one is the primary. Call this first when you need to decide which account to use for a workflow that touches multiple Google identities.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }
]

const TOOL_MAP = {
  google_gmail_search: gmailSearch,
  google_gmail_read: gmailRead,
  google_gmail_send: gmailSend,
  google_gmail_mark_read: gmailMarkRead,
  google_gmail_archive: gmailArchive,
  google_gmail_mark_unread: gmailMarkUnread,
  google_gmail_trash: gmailTrash,
  google_gmail_forward: gmailForward,
  google_gmail_draft_create: gmailDraftCreate,
  google_gmail_labels: gmailLabels,
  google_drive_list: driveList,
  google_drive_search: driveSearch,
  google_drive_upload: driveUpload,
  google_drive_download: driveDownload,
  google_drive_delete: driveDelete,
  google_drive_mkdir: driveMkdir,
  google_calendar_events: calendarEvents,
  google_calendar_create: calendarCreate,
  google_calendar_update: calendarUpdate,
  google_calendar_delete: calendarDelete,
  google_contacts_search: contactsSearch,
  google_contacts_create: contactsCreate,
  google_tasks_list: tasksList,
  google_tasks_add: tasksAdd,
  google_tasks_complete: tasksComplete,
  google_tasks_delete: tasksDelete,
  google_sheets_read: sheetsRead,
  google_sheets_write: sheetsWrite,
  google_accounts: googleAccounts
}

export default {
  name: 'google',
  tools: toolDefinitions,

  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? null
  },

  describeAction(toolName, args) {
    // Append the account on every per-account call so the renderer makes it
    // visually obvious which identity each call is hitting. Cross-account
    // bugs were nearly invisible without this.
    const acct = String(args?.account ?? '').trim()
    const accountSuffix = acct ? ` · ${acct}` : ''
    switch (toolName) {
      case 'google_accounts':
        return { title: 'List Google accounts', description: 'Authorized accounts', risk: 'low' }
      case 'google_gmail_search':
        return { title: 'Search Gmail', description: `Query: ${args?.query ?? '(empty)'}${accountSuffix}`, risk: 'low' }
      case 'google_gmail_read':
        return { title: 'Read email', description: `Thread: ${args?.id ?? '?'}${accountSuffix}`, risk: 'low' }
      case 'google_gmail_send':
        return {
          title: 'Send email',
          description: `To: ${args?.to ?? '?'} — Subject: ${args?.subject ?? '?'}${accountSuffix}`,
          impact: 'Sends an email from your Google account',
          risk: 'high'
        }
      case 'google_gmail_mark_read':
        return {
          title: 'Mark as read',
          description: `${args?.query ? `Query: ${args.query}` : `IDs: ${(args?.ids ?? []).join(', ')}`}${accountSuffix}`,
          risk: 'low'
        }
      case 'google_gmail_archive':
        return {
          title: 'Archive email',
          description: `${args?.query ? `Query: ${args.query}` : `IDs: ${(args?.ids ?? []).join(', ')}`}${accountSuffix}`,
          risk: 'low'
        }
      case 'google_gmail_mark_unread':
        return {
          title: 'Mark as unread',
          description: `${args?.query ? `Query: ${args.query}` : `IDs: ${(args?.ids ?? []).join(', ')}`}${accountSuffix}`,
          risk: 'low'
        }
      case 'google_gmail_trash':
        return {
          title: 'Trash email',
          description: `${args?.query ? `Query: ${args.query}` : `IDs: ${(args?.ids ?? []).join(', ')}`}${accountSuffix}`,
          impact: 'Moves messages to Gmail trash',
          risk: 'medium'
        }
      case 'google_gmail_forward':
        return {
          title: 'Forward email',
          description: `To: ${args?.to ?? '?'} — Message: ${args?.id ?? '?'}${accountSuffix}`,
          impact: 'Forwards an email on your behalf',
          risk: 'high'
        }
      case 'google_gmail_draft_create':
        return {
          title: 'Save draft',
          description: `To: ${args?.to ?? '(no recipient)'} — Subject: ${args?.subject ?? '?'}${accountSuffix}`,
          risk: 'low'
        }
      case 'google_gmail_labels':
        return { title: 'List Gmail labels', description: `Listing labels${accountSuffix}`, risk: 'low' }
      case 'google_drive_list':
        return { title: 'List Drive files', description: `${args?.parent ? `Folder: ${args.parent}` : 'Root folder'}${accountSuffix}`, risk: 'low' }
      case 'google_drive_search':
        return { title: 'Search Drive', description: `Query: ${args?.query ?? '(empty)'}${accountSuffix}`, risk: 'low' }
      case 'google_drive_upload':
        return {
          title: 'Upload to Drive',
          description: `File: ${args?.path ?? '?'}${accountSuffix}`,
          impact: 'Uploads a file to your Google Drive',
          risk: 'medium'
        }
      case 'google_drive_download':
        return {
          title: 'Download from Drive',
          description: `File: ${args?.file_id ?? '?'} → ${args?.output ?? '?'}${accountSuffix}`,
          risk: 'medium'
        }
      case 'google_drive_delete':
        return {
          title: 'Delete Drive file',
          description: `File: ${args?.file_id ?? '?'}${accountSuffix}`,
          impact: 'Moves file to Google Drive trash',
          risk: 'medium'
        }
      case 'google_drive_mkdir':
        return {
          title: 'Create Drive folder',
          description: `${args?.name ?? '?'}${args?.parent ? ` in ${args.parent}` : ''}${accountSuffix}`,
          risk: 'low'
        }
      case 'google_calendar_events':
        return { title: 'List calendar events', description: `${args?.range ?? 'Upcoming events'}${accountSuffix}`, risk: 'low' }
      case 'google_calendar_create':
        return {
          title: 'Create calendar event',
          description: `${args?.summary ?? '?'} (${args?.start ?? '?'} → ${args?.end ?? '?'})${accountSuffix}`,
          impact: 'Creates an event on your Google Calendar',
          risk: 'medium'
        }
      case 'google_calendar_update':
        return {
          title: 'Update calendar event',
          description: `Event: ${args?.event_id ?? '?'}${args?.summary ? ` → "${args.summary}"` : ''}${accountSuffix}`,
          impact: 'Modifies an existing calendar event',
          risk: 'medium'
        }
      case 'google_calendar_delete':
        return {
          title: 'Delete calendar event',
          description: `Event: ${args?.event_id ?? '?'}${accountSuffix}`,
          impact: 'Permanently deletes a calendar event',
          risk: 'high'
        }
      case 'google_contacts_search':
        return { title: 'Search contacts', description: `Query: ${args?.query ?? '(empty)'}${accountSuffix}`, risk: 'low' }
      case 'google_contacts_create':
        return {
          title: 'Create contact',
          description: `${[args?.given, args?.family].filter(Boolean).join(' ')}${args?.email ? ` <${args.email}>` : ''}${accountSuffix}`,
          risk: 'low'
        }
      case 'google_tasks_list':
        return { title: 'List tasks', description: `${args?.task_list_id ? `List: ${args.task_list_id}` : 'All task lists'}${accountSuffix}`, risk: 'low' }
      case 'google_tasks_add':
        return {
          title: 'Add task',
          description: `${args?.title ?? '?'}${args?.due ? ` (due ${args.due})` : ''}${accountSuffix}`,
          risk: 'medium'
        }
      case 'google_tasks_complete':
        return { title: 'Complete task', description: `Task: ${args?.task_id ?? '?'}${accountSuffix}`, risk: 'low' }
      case 'google_tasks_delete':
        return {
          title: 'Delete task',
          description: `Task: ${args?.task_id ?? '?'}${accountSuffix}`,
          impact: 'Permanently deletes a task',
          risk: 'medium'
        }
      case 'google_sheets_read':
        return { title: 'Read spreadsheet', description: `${args?.spreadsheet_id ?? '?'} ${args?.range ?? ''}${accountSuffix}`, risk: 'low' }
      case 'google_sheets_write':
        return {
          title: 'Write to spreadsheet',
          description: `${args?.spreadsheet_id ?? '?'} ${args?.range ?? ''}${accountSuffix}`,
          impact: 'Writes data to your Google Sheets spreadsheet',
          risk: 'medium'
        }
      default:
        return null
    }
  },

  async execute(toolName, args) {
    const handler = TOOL_MAP[toolName]
    if (!handler) return { success: false, error: `google: unknown tool ${toolName}` }
    return handler(args)
  }
}
