---
name: google
description: Google Workspace integration — Gmail, Drive, Calendar, Contacts, Tasks, and Sheets via gogcli
triggers:
  - google
  - gmail
  - email
  - inbox
  - send email
  - compose email
  - search email
  - mark as read
  - mark read
  - archive email
  - trash email
  - forward email
  - save draft
  - delete event
  - update event
  - reschedule
  - complete task
  - delete task
  - create contact
  - add contact
  - create folder
  - drive
  - upload file
  - download file
  - list files
  - google drive
  - calendar
  - events
  - schedule
  - meeting
  - appointment
  - create event
  - contacts
  - address book
  - phone number
  - tasks
  - todo
  - task list
  - sheets
  - spreadsheet
  - google sheets
  - mail
  - message
  - reply
  - draft
  - label
  - unread
  - starred
  - attachment
  - invite
  - attendee
  - reminder
  - due date
  - workspace
  - cloud storage
  - shared drive
  - my drive
  - check email
  - new email
  - read email
  - write email
  - any mail
  - upcoming
  - next meeting
  - free time
  - busy
  - availability
  - add task
  - what's on my calendar
  - what meetings
  - cc
  - bcc
  - subject
  - recipient
  - sender
  - from address
  - thread
  - conversation
  - newsletter
  - promotion
  - spam
  - junk
  - important
  - priority
  - flag
  - snooze
  - rsvp
  - accept invite
  - decline invite
  - recurring
  - weekly meeting
  - daily standup
  - all day event
  - time zone
  - agenda
  - conference room
  - zoom link
  - google meet
  - hangout
  - shared document
  - shared folder
  - file sharing
  - checklist
  - subtask
  - overdue
  - pending tasks
  - my tasks
  - today's schedule
  - tomorrow's meetings
  - this week
  - send a message
  - reply to email
  - respond to
tools:
  - name: google_accounts
    description: List the Google accounts the user has authorized. Always call this first to get the exact account email(s) you must pass as `account` on every other google_* tool. There is no implicit "default" account — every other google_* call requires `account` explicitly.
    parameters: {}
  - name: google_gmail_search
    readOnly: true
    description: Search Gmail messages by query. Supports Gmail search operators (from:, to:, subject:, has:attachment, is:unread, after:, before:, label:, etc). Returns message metadata and snippets.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email to query. Get the exact value from google_accounts. For identity-agnostic requests like "any unread mail?", call this tool once per account in parallel.
      query:
        type: string
        description: Gmail search query (same syntax as the Gmail search bar)
      max:
        type: number
        required: false
        description: Maximum results to return (default 10)
  - name: google_gmail_read
    readOnly: true
    description: Read a full email thread by ID. Returns all messages in the thread with headers, body text, and attachment metadata.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email the thread belongs to. Use the same account you got the thread ID from.
      id:
        type: string
        description: The thread or message ID (from a search result)
  - name: google_gmail_send
    description: Send a new email. Supports plain text body. For replies, use the thread_id parameter.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email to send from. The recipient sees this address in the From header.
      to:
        type: string
        description: Recipient email address (comma-separated for multiple)
      subject:
        type: string
        description: Email subject line
      body:
        type: string
        description: Email body (plain text)
      cc:
        type: string
        required: false
        description: CC recipients (comma-separated)
      bcc:
        type: string
        required: false
        description: BCC recipients (comma-separated)
      thread_id:
        type: string
        required: false
        description: Thread ID to reply to (makes this a reply in that thread)
  - name: google_gmail_labels
    description: List all Gmail labels for the account. Returns label names, IDs, and message counts.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email to query.
  - name: google_gmail_mark_read
    description: Mark messages as read. Provide either specific message IDs or a Gmail search query to mark all matching messages as read.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email the messages belong to.
      ids:
        type: array
        required: false
        description: Array of message IDs to mark as read (from search results). Use this OR query, not both.
      query:
        type: string
        required: false
        description: Gmail search query — marks all matching messages as read (alternative to ids). Same syntax as google_gmail_search.
      max:
        type: number
        required: false
        description: Max messages to mark when using query (default 100)
  - name: google_gmail_archive
    description: Archive messages (remove from inbox without deleting). Provide message IDs or a Gmail search query.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      ids:
        type: array
        required: false
        description: Array of message IDs to archive.
      query:
        type: string
        required: false
        description: Gmail search query — archives all matching messages.
      max:
        type: number
        required: false
        description: Max messages to archive when using query (default 100)
  - name: google_gmail_mark_unread
    description: Mark messages as unread. Provide message IDs or a Gmail search query.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      ids:
        type: array
        required: false
        description: Array of message IDs to mark as unread.
      query:
        type: string
        required: false
        description: Gmail search query — marks all matching messages as unread.
      max:
        type: number
        required: false
        description: Max messages when using query (default 100)
  - name: google_gmail_trash
    description: Move messages to trash. Provide message IDs or a Gmail search query.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      ids:
        type: array
        required: false
        description: Array of message IDs to trash.
      query:
        type: string
        required: false
        description: Gmail search query — trashes all matching messages.
      max:
        type: number
        required: false
        description: Max messages when using query (default 100)
  - name: google_gmail_forward
    description: Forward a message to new recipients. Sends from the authorized account.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email to send from.
      id:
        type: string
        description: Message ID to forward (from a search result)
      to:
        type: string
        description: Recipients (comma-separated)
      cc:
        type: string
        required: false
        description: CC recipients
      bcc:
        type: string
        required: false
        description: BCC recipients
      note:
        type: string
        required: false
        description: Introductory text above the forwarded message
      skip_attachments:
        type: boolean
        required: false
        description: Do not include original attachments
  - name: google_gmail_draft_create
    description: Save a draft email without sending. Use to stage a reply or new email for the user to review before sending.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email to draft from.
      to:
        type: string
        required: false
        description: Recipients (comma-separated)
      subject:
        type: string
        description: Subject line
      body:
        type: string
        description: Email body (plain text)
      cc:
        type: string
        required: false
        description: CC recipients
      bcc:
        type: string
        required: false
        description: BCC recipients
      thread_id:
        type: string
        required: false
        description: Reply to this message ID (sets threading headers)
  - name: google_drive_list
    readOnly: true
    description: List files in Google Drive. Optionally filter by parent folder. Returns file names, IDs, types, sizes, and modification dates.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email whose Drive to query. For identity-agnostic requests, fan out per account.
      parent:
        type: string
        required: false
        description: Parent folder ID to list children of. Omit for root.
      max:
        type: number
        required: false
        description: Maximum results (default 20)
  - name: google_drive_search
    readOnly: true
    description: Search Google Drive files by name or content. Returns matching file names, IDs, types, sizes, and modification dates.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email whose Drive to query. For identity-agnostic requests, fan out per account.
      query:
        type: string
        description: Search query (matches file names and content)
      max:
        type: number
        required: false
        description: Maximum results (default 20)
  - name: google_drive_upload
    description: Upload a local file to Google Drive. The file path is resolved relative to the workspace root.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email whose Drive receives the upload.
      path:
        type: string
        description: Local file path to upload (relative to workspace root or absolute)
      parent:
        type: string
        required: false
        description: Parent folder ID to upload into. Omit for root.
      name:
        type: string
        required: false
        description: Override the filename in Drive (defaults to the local filename)
  - name: google_drive_download
    description: Download a file from Google Drive to a local path.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email that owns the file.
      file_id:
        type: string
        description: The Drive file ID to download
      output:
        type: string
        description: Local output path (relative to workspace root or absolute)
  - name: google_drive_delete
    description: Move a Drive file to trash.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      file_id:
        type: string
        description: Drive file ID to delete
  - name: google_drive_mkdir
    description: Create a new folder in Google Drive.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      name:
        type: string
        description: Folder name
      parent:
        type: string
        required: false
        description: Parent folder ID (omit for root)
  - name: google_calendar_events
    description: List upcoming calendar events. Supports relative time ranges (today, tomorrow, week) or explicit date ranges.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email whose calendar to read. For identity-agnostic requests, fan out per account.
      range:
        type: string
        required: false
        description: '"today", "tomorrow", "week", or omit for the next 7 days'
      days:
        type: number
        required: false
        description: Number of days ahead to look (alternative to range)
      from:
        type: string
        required: false
        description: Start date (YYYY-MM-DD) for an explicit range
      to:
        type: string
        required: false
        description: End date (YYYY-MM-DD) for an explicit range
      max:
        type: number
        required: false
        description: Maximum events to return (default 20)
  - name: google_calendar_create
    description: Create a new calendar event. Dates should be in ISO 8601 format.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email whose calendar to add the event to.
      summary:
        type: string
        description: Event title
      start:
        type: string
        description: Start time in ISO 8601 (e.g. 2026-01-15T09:00:00)
      end:
        type: string
        description: End time in ISO 8601 (e.g. 2026-01-15T10:00:00)
      description:
        type: string
        required: false
        description: Event description
      location:
        type: string
        required: false
        description: Event location
      attendees:
        type: string
        required: false
        description: Comma-separated attendee email addresses
  - name: google_calendar_update
    description: Update an existing calendar event — reschedule, rename, add/remove attendees, change location, etc.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      calendar_id:
        type: string
        description: Calendar ID (use the account email for the primary calendar)
      event_id:
        type: string
        description: Event ID (from google_calendar_events)
      summary:
        type: string
        required: false
        description: New event title
      start:
        type: string
        required: false
        description: New start time (ISO 8601)
      end:
        type: string
        required: false
        description: New end time (ISO 8601)
      description:
        type: string
        required: false
        description: New description
      location:
        type: string
        required: false
        description: New location
      attendees:
        type: string
        required: false
        description: Replace all attendees (comma-separated emails)
      add_attendee:
        type: string
        required: false
        description: Add attendees without replacing existing ones (comma-separated)
      send_updates:
        type: string
        required: false
        description: '"all", "externalOnly", or "none" — whether to notify attendees (default none)'
  - name: google_calendar_delete
    description: Delete a calendar event permanently.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      calendar_id:
        type: string
        description: Calendar ID (use the account email for the primary calendar)
      event_id:
        type: string
        description: Event ID (from google_calendar_events)
      send_updates:
        type: string
        required: false
        description: '"all", "externalOnly", or "none" — whether to notify attendees (default none)'
  - name: google_contacts_search
    readOnly: true
    description: Search Google Contacts by name, email, or phone number.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email whose contacts to search.
      query:
        type: string
        description: Search query (name, email, or phone)
      max:
        type: number
        required: false
        description: Maximum results (default 20)
  - name: google_contacts_create
    description: Create a new Google contact.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      given:
        type: string
        description: First / given name (required)
      family:
        type: string
        required: false
        description: Last / family name
      email:
        type: string
        required: false
        description: Email address
      phone:
        type: string
        required: false
        description: Phone number
      org:
        type: string
        required: false
        description: Organization / company name
      title:
        type: string
        required: false
        description: Job title
      note:
        type: string
        required: false
        description: Notes / biography
  - name: google_tasks_list
    readOnly: true
    description: List Google Tasks. When called without a task_list_id, returns all task lists. When called with a task_list_id, returns tasks in that list.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email whose tasks to list.
      task_list_id:
        type: string
        required: false
        description: Task list ID to get tasks from. Omit to list all task lists.
      max:
        type: number
        required: false
        description: Maximum results (default 20)
      show_completed:
        type: boolean
        required: false
        description: Include completed tasks (default false)
  - name: google_tasks_add
    description: Add a new task to a task list.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email that owns the task list.
      task_list_id:
        type: string
        description: Task list ID to add the task to
      title:
        type: string
        description: Task title
      notes:
        type: string
        required: false
        description: Task notes/description
      due:
        type: string
        required: false
        description: Due date in YYYY-MM-DD format
  - name: google_tasks_complete
    description: Mark a task as completed.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      task_list_id:
        type: string
        description: Task list ID
      task_id:
        type: string
        description: Task ID
  - name: google_tasks_delete
    description: Delete a task permanently.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email.
      task_list_id:
        type: string
        description: Task list ID
      task_id:
        type: string
        description: Task ID
  - name: google_sheets_read
    readOnly: true
    description: Read data from a Google Sheets spreadsheet. Returns cell values as a 2D array.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email that owns the spreadsheet.
      spreadsheet_id:
        type: string
        description: The spreadsheet ID (from the URL)
      range:
        type: string
        description: 'A1 notation range, e.g. "Sheet1!A1:D10" or "Sheet1"'
  - name: google_sheets_write
    description: Write data to a Google Sheets spreadsheet. Values are written starting at the top-left cell of the specified range.
    parameters:
      account:
        type: string
        description: REQUIRED. The authorized account email that owns the spreadsheet.
      spreadsheet_id:
        type: string
        description: The spreadsheet ID
      range:
        type: string
        description: 'A1 notation range to write to, e.g. "Sheet1!A1"'
      values:
        type: array
        description: '2D array of values, e.g. [["Name","Age"],["Alice",30]]'
danger_patterns:
  - pattern: 'google_gmail_send'
    level: destructive
    reason: Sending an email on behalf of the user
  - pattern: 'google_gmail_forward'
    level: destructive
    reason: Forwarding an email on behalf of the user
  - pattern: 'google_calendar_delete'
    level: destructive
    reason: Permanently deleting a calendar event
  - pattern: 'google_drive_upload.*"parent"\s*:\s*"[^"]*trash'
    level: block
    reason: Uploading to trash is not allowed
confirm_patterns:
  - pattern: 'google_gmail_trash'
    reason: Moving messages to Gmail trash
  - pattern: 'google_drive_upload'
    reason: Uploading a file to Google Drive
  - pattern: 'google_drive_download'
    reason: Downloading a file from Google Drive
  - pattern: 'google_drive_delete'
    reason: Deleting a file from Google Drive
  - pattern: 'google_calendar_create'
    reason: Creating a calendar event
  - pattern: 'google_calendar_update'
    reason: Modifying a calendar event
  - pattern: 'google_calendar_delete'
    reason: Deleting a calendar event
  - pattern: 'google_tasks_add'
    reason: Adding a task
  - pattern: 'google_tasks_delete'
    reason: Deleting a task
  - pattern: 'google_sheets_write'
    reason: Writing to a spreadsheet
---

# Google Workspace

## Before doing anything: confirm the user is configured

Every tool here depends on (a) the `gog` binary being installed and (b) at least one Google account being authorized inside Wolffish. Both are user-facing setup steps that only work from the Settings panel — you cannot fix them from chat.

**Always call `google_accounts` first.** Every other `google_*` tool requires `account` as a parameter — there is no default account. The call fails with a clear error if you omit it. `google_accounts` returns the list of authorized account emails plus surfaces clear setup errors when something is missing:

- `Google Workspace is not installed. Open Wolffish → Settings → Services → Google Workspace and click Install.`
- `No Google account is authorized yet. Open Wolffish → Settings → Services → Google Workspace, upload your OAuth client JSON, and authorize at least one account.`

If you see either of those errors (from `google_accounts` or from any other `google_*` tool), stop the workflow and relay the message to the user **verbatim** — they need to follow the exact path to Settings → Services → Google Workspace. Do not try to work around the missing setup with shell commands; gogcli stores credentials in the OS keyring and only the Settings flow wires it up correctly.

## How it works

All tools use the `gog` CLI (gogcli) under the hood. Every command returns structured JSON. The `gog` binary must be installed and the user must have authenticated at least one Google account via Settings → Services → Google Workspace.

## Account selection (REQUIRED on every call)

Every `google_*` tool except `google_accounts` requires an `account` parameter. **There is no default and no "primary" — pick the email explicitly for every call.** Calls without `account` fail with:

```
Missing required `account` parameter. Call google_accounts to get the list of authorized account emails, then pass one as `account` on this tool.
```

### Identity-agnostic requests: fan out across all accounts

When the user asks something generic that doesn't name a specific identity — "check my email", "any unread mail?", "what's in my inbox", "any new calendar events", "search drive for X" — **iterate over every authorized account autonomously**. Do NOT pick just one, and do NOT ask the user which account to use.

Mandatory flow:

1. Call `google_accounts` to get the full list of authorized accounts.
2. Call the relevant `google_*` tool **once per account**, passing each email as `account`. Run these calls in parallel.
3. Aggregate the results into a single unified response, grouped by account email.

Example — user says "any unread email?":

```
google_accounts → ["alice@gmail.com", "bob@example.com", "work@corp.com"]
google_gmail_search { account: "alice@gmail.com",  query: "is:unread in:inbox" }
google_gmail_search { account: "bob@example.com",  query: "is:unread in:inbox" }
google_gmail_search { account: "work@corp.com",    query: "is:unread in:inbox" }
→ present results grouped by account
```

**Never** tell the user "the tool only supports the primary account" or ask them to switch the primary in Settings — the `account` parameter already handles per-call switching. **Never** ask "which account?" for a generic ask; just fan out. If a single account fails, note it briefly in the unified response and continue with the others.

### Reading counts correctly

Every read/list/search response is wrapped with two top-level fields the LLM **must** trust verbatim when summarizing:

```json
{
  "account": "younes@wolffi.sh",
  "count": 1,
  "threads": [ ... ]
}
```

When summarizing across N parallel calls, **read `count` directly** for each result — do not eyeball `threads.length` or skim the JSON. If `count > 0`, that account has results, full stop. Saying "0 unread" while the response shows `"count": 1` is a hallucination; always quote the `count` you see.

### When to target one account

Only restrict to a single account when the user names one explicitly ("check my work email", "the alice@ account") or when the workflow inherently belongs to one identity (replying in a thread you already read from a specific account). For "my work account" without an email, call `google_accounts` first and ask the user to disambiguate from the actual list.

### Cross-account patterns

- **Identity-agnostic read (the default)** — fan out: one tool call per authorized account, results aggregated.
- **Reply from a different identity** — read a thread on Alice's account, then call `google_gmail_send` with `account: "bob@example.com"` and `thread_id` to reply from Bob.
- **Single named account** — pass `account` for that one call.

## Output format

All tool results are JSON. Parse the output to extract the data you need. Common fields:

- Gmail messages have `id`, `threadId`, `from`, `to`, `subject`, `snippet`, `date`, `body`, `labels`
- Drive files have `id`, `name`, `mimeType`, `size`, `modifiedTime`, `webViewLink`
- Calendar events have `id`, `summary`, `start`, `end`, `location`, `attendees`, `description`
- Contacts have `name`, `email`, `phone`, `organization`
- Tasks have `id`, `title`, `status`, `due`, `notes`
- Sheets data is returned as a 2D array of cell values

## Workflow patterns

### Email workflow
1. `google_accounts` — discover authorized accounts (skip only if the user named one explicitly).
2. `google_gmail_search` — fan out: one call per authorized account, passing `account` each time. For named-account requests, just one call.
3. `google_gmail_read` — read the full thread to understand context (use the same `account` the message came from).
4. `google_gmail_send` — compose and send a reply (use `thread_id` for threading; pass `account` to send from a specific identity).
5. `google_gmail_mark_read` — mark messages as read by IDs (from search results) or by query. Pass the same `account` the messages belong to.

### File management
1. `google_drive_search` or `google_drive_list` — find files
2. `google_drive_download` — download to local filesystem for processing
3. Process locally (read, edit, etc.)
4. `google_drive_upload` — upload the result back to Drive

### Calendar management
1. `google_calendar_events` — check what's already scheduled
2. `google_calendar_create` — create a new event with attendees
3. `google_calendar_update` — reschedule or edit an existing event (pass `calendar_id` = account email for primary calendar)
4. `google_calendar_delete` — delete an event (requires confirmation)

### Task management
1. `google_tasks_list` — list task lists first (no task_list_id)
2. `google_tasks_list` — then list tasks in a specific list
3. `google_tasks_add` — add new tasks
4. `google_tasks_complete` — mark a task done
5. `google_tasks_delete` — delete a task permanently

### Spreadsheet operations
1. `google_sheets_read` — read current data
2. Process or analyze the data
3. `google_sheets_write` — write results back

## Gmail search operators

The `google_gmail_search` query supports all Gmail search operators:
- `from:user@example.com` — sender
- `to:user@example.com` — recipient
- `subject:meeting` — subject line
- `has:attachment` — has attachments
- `is:unread` — unread messages
- `is:starred` — starred messages
- `label:important` — by label
- `after:2026/01/01` — date range
- `before:2026/02/01` — date range
- `filename:pdf` — attachment type
- Combine with spaces (implicit AND) or `OR`

### Default scope: pair `is:unread` with `in:inbox`

When the user asks about "unread emails" without further qualification, default to `is:unread in:inbox` rather than bare `is:unread`. Auto-archived promotional and category-tabbed mail keeps the unread flag indefinitely; users almost always mean *inbox unread*. Drop the `in:inbox` filter only when the user explicitly asks for archived or all mail ("show me all unread including archived", "anything in promotions"). The same logic applies when scanning multiple accounts in parallel — keep the scope consistent across the fan-out so the aggregated count matches what the user expects.

## Important notes

- All operations require the user to have authenticated with Google in Settings
- Gmail send is a destructive action — the safety system will require confirmation
- Drive uploads/downloads resolve paths relative to the workspace root
- Calendar times must be in ISO 8601 format
- Sheets ranges use A1 notation (e.g. "Sheet1!A1:D10")
- The `gog` CLI handles pagination internally for most commands
