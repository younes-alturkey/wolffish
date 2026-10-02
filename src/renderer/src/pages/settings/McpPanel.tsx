import { Button } from '@components/core/Button'
import { CopyButton } from '@components/core/CopyButton'
import { Input } from '@components/core/Input'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { McpHeader, McpServerSnapshot, McpServerState } from '@preload/index'
import {
  Add01Icon,
  Alert02Icon,
  Delete02Icon,
  RefreshIcon,
  SquareLock02Icon,
  ViewIcon,
  ViewOffIcon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Settings → MCP. The one surface the user sees for MCP connections, so
 * it stays calm: the connection list with subtle live status, an add
 * form, and a short how-it-works explainer at the bottom. All connection
 * mechanics (reconnects, health checks, discovery) are invisible
 * main-process business — status updates arrive over mcp:statusChange and
 * just re-render quietly. No spinners, no red banners: transient trouble
 * is a neutral dot and a muted detail line.
 */

const STATUS_DOT: Record<McpServerState, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500',
  'needs-auth': 'bg-amber-500',
  offline: 'bg-border',
  disabled: 'bg-border'
}

const STATUS_LABEL_KEY: Record<McpServerState, string> = {
  connected: 'settings.mcp.status.connected',
  connecting: 'settings.mcp.status.connecting',
  'needs-auth': 'settings.mcp.status.needsAuth',
  offline: 'settings.mcp.status.offline',
  disabled: 'settings.mcp.status.disabled'
}

/**
 * Module-level cache of the last-known server snapshots, warmed once at
 * app start (this panel is eagerly imported by Settings.tsx, so the load
 * below runs during startup). By the time the user opens the tab the list
 * is already in memory and paints on the first frame — no IPC round-trip,
 * no null→skeleton→list flash. Kept in sync by every list()/statusChange.
 * `null` means "not loaded yet".
 */
let cachedServers: McpServerSnapshot[] | null = null
let loadPromise: Promise<McpServerSnapshot[]> | null = null

function loadServers(): Promise<McpServerSnapshot[]> {
  if (cachedServers) return Promise.resolve(cachedServers)
  if (!loadPromise) {
    const api = window.api?.mcp
    if (!api) return Promise.resolve([]) // preload not ready yet; retry on mount
    loadPromise = api
      .list()
      .then((list) => {
        cachedServers = list
        return list
      })
      .catch(() => {
        cachedServers = []
        return cachedServers
      })
  }
  return loadPromise
}

// Prefill the cache at app start.
void loadServers()

function looksLikeUrl(target: string): boolean {
  return /^https?:\/\//i.test(target.trim())
}

/** Parse "KEY=value" lines into an env map; ignores blanks and comments. */
function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

const ICON_BUTTON =
  'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-40'

// Same icon-button and small-button idioms as the Variables panel.
const ROW_ICON_BUTTON =
  'shrink-0 cursor-pointer rounded-lg p-1.5 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-40'

const SMALL_CANCEL_BUTTON =
  'border-border text-fg hover:bg-border/40 cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-60'

const SMALL_SAVE_BUTTON =
  'bg-primary text-primary-fg cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium shadow-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-60'

const HEADER_ROW_INPUT =
  'border-border bg-bg text-fg placeholder:text-muted/60 min-w-0 rounded-lg border px-3 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'

const TEXT_TOGGLE_BUTTON =
  'text-muted hover:text-fg self-start text-xs font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'

/**
 * One editable header row. `rid` is a local, monotonic React key —
 * header keys are user-editable mid-list, so they can't key the rows.
 * `revealed` is per-row UI state for peeking at a sensitive value.
 */
type HeaderRow = { rid: number; key: string; value: string; sensitive: boolean; revealed: boolean }

let nextHeaderRid = 1

function makeHeaderRow(header?: McpHeader): HeaderRow {
  return {
    rid: nextHeaderRid++,
    key: header?.key ?? '',
    value: header?.value ?? '',
    sensitive: header?.sensitive === true,
    revealed: false
  }
}

/** Rows → the wire shape, dropping rows the user left entirely blank. */
function rowsToHeaders(rows: HeaderRow[]): McpHeader[] {
  return rows
    .map((row) => ({ key: row.key.trim(), value: row.value.trim(), sensitive: row.sensitive }))
    .filter((header) => header.key !== '' || header.value !== '')
}

/**
 * The header rows editor shared by the add form and each remote server
 * card. Follows the Variables panel's sensitive idiom: a sensitive row's
 * value renders as a password field with an eye toggle to peek — purely
 * a display courtesy; values are stored in plaintext either way.
 */
function HeadersEditor(props: {
  rows: HeaderRow[]
  onChange: (rows: HeaderRow[]) => void
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { rows, onChange, disabled } = props

  const patchRow = (rid: number, patch: Partial<HeaderRow>): void => {
    onChange(rows.map((row) => (row.rid === rid ? { ...row, ...patch } : row)))
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div key={row.rid} className="flex items-center gap-2" dir="ltr">
          <input
            type="text"
            value={row.key}
            disabled={disabled}
            placeholder={t('settings.mcp.headers.keyPlaceholder')}
            spellCheck={false}
            onChange={(e) => patchRow(row.rid, { key: e.target.value })}
            className={cn(HEADER_ROW_INPUT, 'w-2/5')}
          />
          <input
            type={row.sensitive && !row.revealed ? 'password' : 'text'}
            value={row.value}
            disabled={disabled}
            placeholder={t('settings.mcp.headers.valuePlaceholder')}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => patchRow(row.rid, { value: e.target.value })}
            className={cn(HEADER_ROW_INPUT, 'flex-1')}
          />
          {row.sensitive && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => patchRow(row.rid, { revealed: !row.revealed })}
              aria-label={
                row.revealed ? t('settings.mcp.headers.hide') : t('settings.mcp.headers.reveal')
              }
              title={
                row.revealed ? t('settings.mcp.headers.hide') : t('settings.mcp.headers.reveal')
              }
              className={cn(ROW_ICON_BUTTON, 'text-muted hover:text-fg')}
            >
              {row.revealed ? <ViewOffIcon size={14} /> : <ViewIcon size={14} />}
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={() => patchRow(row.rid, { sensitive: !row.sensitive, revealed: false })}
            aria-pressed={row.sensitive}
            aria-label={t('settings.mcp.headers.markSensitive')}
            title={t('settings.mcp.headers.markSensitive')}
            className={cn(
              ROW_ICON_BUTTON,
              row.sensitive ? 'text-accent' : 'text-muted hover:text-fg'
            )}
          >
            <SquareLock02Icon size={14} />
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(rows.filter((r) => r.rid !== row.rid))}
            aria-label={t('settings.mcp.headers.removeRow')}
            title={t('settings.mcp.headers.removeRow')}
            className={cn(ROW_ICON_BUTTON, 'text-muted hover:text-rose-500')}
          >
            <Delete02Icon size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange([...rows, makeHeaderRow()])}
        className={cn(
          TEXT_TOGGLE_BUTTON,
          'hover:bg-border/30 flex items-center gap-1.5 rounded-lg px-2 py-1.5'
        )}
      >
        <Add01Icon size={14} />
        <span>{t('settings.mcp.headers.addRow')}</span>
      </button>
    </div>
  )
}

// No ms-5 here: the inset lives on a wrapper div that inherits the page
// direction. These pres are dir="ltr", and logical margins resolve against
// the ELEMENT's own direction — an ms-5 on the pre itself would flip to the
// wrong side in RTL and misalign with the URL block above it.
const CODE_BLOCK =
  'bg-bg/60 border-border rounded-md border px-3 py-2 whitespace-pre-wrap wrap-break-word font-mono text-xs'

export function McpPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  // Seed from the module cache so the panel paints the last-known list on
  // the first frame instead of flashing a skeleton every open.
  const [servers, setServers] = useState<McpServerSnapshot[] | null>(() => cachedServers)
  const [target, setTarget] = useState('')
  const [name, setName] = useState('')
  const [envText, setEnvText] = useState('')
  const [showEnv, setShowEnv] = useState(false)
  const [addHeaderRows, setAddHeaderRows] = useState<HeaderRow[]>([])
  const [showAddHeaders, setShowAddHeaders] = useState(false)
  // Per-server headers editor — at most one open at a time, draft rows
  // held here until Save persists them (or Cancel throws them away).
  const [headerEdit, setHeaderEdit] = useState<{ id: string; rows: HeaderRow[] } | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [busy, setBusy] = useState<
    Record<string, 'test' | 'auth' | 'remove' | 'toggle' | 'headers'>
  >({})
  // Action errors (a failed Test / Sign-in) shown in the card's issue code
  // block, keyed by server id. A successful test is a toast, not an entry
  // here. Cleared when the server reconnects (see commit), on another
  // action, or on the next successful test.
  const [issues, setIssues] = useState<Record<string, string>>({})

  const clearIssue = useCallback((id: string) => {
    setIssues((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  // Update both the live state and the module cache in one place. A server
  // that is now connected has no outstanding issue, so drop any stale one.
  const commit = useCallback((list: McpServerSnapshot[]) => {
    cachedServers = list
    setServers(list)
    setIssues((prev) => {
      let changed = false
      const next = { ...prev }
      for (const s of list) {
        if (s.state === 'connected' && next[s.id]) {
          delete next[s.id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadServers().then((list) => {
      if (!cancelled) commit(list)
    })
    const off = window.api.mcp.onStatusChange((list) => commit(list))
    return () => {
      cancelled = true
      off()
    }
  }, [commit])

  const isStdio = useMemo(() => target.trim() !== '' && !looksLikeUrl(target), [target])
  const isHttp = useMemo(() => target.trim() !== '' && looksLikeUrl(target), [target])

  // Off/On, matching the segmented toggle used across the settings panels.
  const enabledOptions = useMemo(
    () => [
      { value: false, label: t('settings.mcp.toggle.off') },
      { value: true, label: t('settings.mcp.toggle.on') }
    ],
    [t]
  )

  const handleAdd = useCallback(async () => {
    const trimmed = target.trim()
    if (!trimmed || adding) return
    setAdding(true)
    setAddError(null)
    try {
      const env = isStdio ? parseEnvLines(envText) : undefined
      const headers = isHttp ? rowsToHeaders(addHeaderRows) : []
      const result = await window.api.mcp.add({
        target: trimmed,
        name: name.trim() || undefined,
        env: env && Object.keys(env).length > 0 ? env : undefined,
        headers: headers.length > 0 ? headers : undefined
      })
      if (result.ok) {
        setTarget('')
        setName('')
        setEnvText('')
        setShowEnv(false)
        setAddHeaderRows([])
        setShowAddHeaders(false)
        commit(await window.api.mcp.list())
      } else {
        setAddError(result.error)
      }
    } finally {
      setAdding(false)
    }
  }, [target, name, envText, addHeaderRows, isStdio, isHttp, adding, commit])

  const handleTest = useCallback(
    async (id: string) => {
      setBusy((prev) => ({ ...prev, [id]: 'test' }))
      try {
        const result = await window.api.mcp.test(id)
        if (result.ok) {
          clearIssue(id)
          toast.show({
            tone: 'success',
            message: t('settings.mcp.test.ok', {
              count: result.toolCount ?? 0,
              ms: result.durationMs ?? 0
            })
          })
        } else {
          setIssues((prev) => ({ ...prev, [id]: result.error ?? t('settings.mcp.test.failed') }))
        }
      } finally {
        setBusy((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    },
    [clearIssue, toast, t]
  )

  const handleSignIn = useCallback(
    async (id: string) => {
      setBusy((prev) => ({ ...prev, [id]: 'auth' }))
      try {
        const result = await window.api.mcp.authorize(id)
        if (result.ok) {
          clearIssue(id)
        } else if (result.error) {
          setIssues((prev) => ({ ...prev, [id]: result.error! }))
        }
      } finally {
        setBusy((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    },
    [clearIssue]
  )

  const openHeaderEditor = useCallback((server: McpServerSnapshot) => {
    const rows = (server.headers ?? []).map((header) => makeHeaderRow(header))
    setHeaderEdit({ id: server.id, rows: rows.length > 0 ? rows : [makeHeaderRow()] })
  }, [])

  const handleSaveHeaders = useCallback(
    async (id: string) => {
      if (!headerEdit || headerEdit.id !== id) return
      setBusy((prev) => ({ ...prev, [id]: 'headers' }))
      try {
        const result = await window.api.mcp.setHeaders(id, rowsToHeaders(headerEdit.rows))
        if (result.ok) {
          clearIssue(id)
          // Close only if the open editor still belongs to this server —
          // never discard a draft the user opened on another card since.
          setHeaderEdit((prev) => (prev?.id === id ? null : prev))
          commit(await window.api.mcp.list())
          toast.show({ tone: 'success', message: t('settings.mcp.headers.saved') })
        } else {
          setIssues((prev) => ({
            ...prev,
            [id]: result.error ?? t('settings.mcp.headers.failed')
          }))
        }
      } catch {
        setIssues((prev) => ({ ...prev, [id]: t('settings.mcp.headers.failed') }))
      } finally {
        setBusy((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    },
    [headerEdit, clearIssue, commit, toast, t]
  )

  const handleRemove = useCallback(
    async (id: string) => {
      setBusy((prev) => ({ ...prev, [id]: 'remove' }))
      clearIssue(id)
      try {
        await window.api.mcp.remove(id)
        commit(await window.api.mcp.list())
      } finally {
        setBusy((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    },
    [clearIssue, commit]
  )

  const handleToggleEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      setBusy((prev) => ({ ...prev, [id]: 'toggle' }))
      clearIssue(id)
      try {
        await window.api.mcp.setEnabled(id, enabled)
        commit(await window.api.mcp.list())
      } finally {
        setBusy((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }
    },
    [clearIssue, commit]
  )

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.mcp.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">{t('settings.mcp.subtitle')}</p>
        </header>

        {/* Connection list */}
        <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
          <span className="text-muted text-xs font-medium uppercase tracking-wider">
            {t('settings.mcp.connections.title')}
          </span>
          {servers === null ? (
            <div aria-hidden="true" className="bg-border/30 h-14 animate-pulse rounded-xl" />
          ) : servers.length === 0 ? (
            <p className="text-muted text-sm">{t('settings.mcp.connections.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {servers.map((server) => {
                const rowBusy = busy[server.id]
                return (
                  <li
                    key={server.id}
                    className="bg-bg/40 border-border flex flex-col gap-2 rounded-xl border px-4 py-3"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          aria-hidden="true"
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            STATUS_DOT[server.state],
                            server.state === 'connecting' && 'animate-pulse'
                          )}
                        />
                        <span className="text-fg truncate text-sm font-medium">{server.name}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {server.enabled && server.state !== 'disabled' && (
                          <button
                            type="button"
                            disabled={rowBusy != null}
                            onClick={() => void handleTest(server.id)}
                            aria-label={t('settings.mcp.actions.test')}
                            title={t('settings.mcp.actions.test')}
                            className={cn(ICON_BUTTON, 'text-muted hover:text-fg')}
                          >
                            <RefreshIcon size={16} />
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={rowBusy != null}
                          onClick={() => void handleRemove(server.id)}
                          aria-label={t('settings.mcp.actions.remove')}
                          title={t('settings.mcp.actions.remove')}
                          className={cn(ICON_BUTTON, 'text-muted hover:text-rose-500')}
                        >
                          <Delete02Icon size={16} />
                        </button>
                        <div
                          role="tablist"
                          aria-label={t('settings.mcp.toggle.label')}
                          className="border-border bg-bg/40 inline-flex shrink-0 items-center rounded-lg border p-0.5"
                        >
                          {enabledOptions.map((opt) => {
                            const active = opt.value === server.enabled
                            return (
                              <button
                                key={String(opt.value)}
                                role="tab"
                                type="button"
                                aria-selected={active}
                                disabled={rowBusy != null}
                                onClick={() => {
                                  if (opt.value !== server.enabled)
                                    void handleToggleEnabled(server.id, opt.value)
                                }}
                                className={cn(
                                  'rounded-md px-3 py-1 text-xs font-medium',
                                  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                                  active
                                    ? 'bg-primary text-primary-fg shadow-sm'
                                    : 'text-muted hover:text-fg cursor-pointer'
                                )}
                              >
                                {opt.label}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                    {/* Meta line — always rendered, single line, so the card
                        height stays constant as status flips. Every state
                        carries a short label; connected also shows its tool
                        count as the success confirmation. */}
                    <div className="text-muted flex items-center gap-2 ps-5 text-xs">
                      <span
                        className={cn('shrink-0', server.state === 'connecting' && 'animate-pulse')}
                      >
                        {t(STATUS_LABEL_KEY[server.state])}
                      </span>
                      {server.state === 'connected' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="shrink-0">
                            {t('settings.mcp.toolCount', { count: server.toolCount })}
                          </span>
                        </>
                      )}
                    </div>
                    {/* The connection's address (command or URL) as a
                        single-line code block with a hover-revealed copy
                        overlay — full width, no reserved gutter (the icon
                        floats above the text and disappears off-hover).
                        Always present, so it also anchors the card height. */}
                    <div className="group/url relative ms-5">
                      <code
                        dir="ltr"
                        title={server.target}
                        className="bg-bg/60 border-border text-muted block truncate rounded-md border px-3 py-2 font-mono text-xs"
                      >
                        {server.target}
                      </code>
                      <CopyButton
                        text={server.target}
                        variant="overlay"
                        ariaLabelKey="chat.copy"
                        className="absolute inset-e-1.5 top-1/2 -translate-y-1/2 opacity-0 group-hover/url:opacity-100 focus-visible:opacity-100"
                      />
                    </div>
                    {/* Custom headers (remote servers) — a quiet text
                        affordance under the URL that expands into the rows
                        editor. Draft rows live in headerEdit until Save. */}
                    {server.transport === 'http' && headerEdit?.id !== server.id && (
                      <button
                        type="button"
                        disabled={rowBusy != null}
                        onClick={() => openHeaderEditor(server)}
                        className={cn(TEXT_TOGGLE_BUTTON, 'ms-5 rounded-md py-0.5')}
                      >
                        {server.headers?.length
                          ? t('settings.mcp.headers.editWithCount', {
                              count: server.headers.length
                            })
                          : t('settings.mcp.headers.toggle')}
                      </button>
                    )}
                    {server.transport === 'http' && headerEdit?.id === server.id && (
                      <div className="ms-5 flex flex-col gap-2">
                        <span className="text-muted text-xs font-medium">
                          {t('settings.mcp.headers.label')}
                        </span>
                        <HeadersEditor
                          rows={headerEdit.rows}
                          onChange={(rows) => setHeaderEdit({ id: server.id, rows })}
                          disabled={rowBusy === 'headers'}
                        />
                        <p className="text-muted/80 text-xs">{t('settings.mcp.headers.hint')}</p>
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            disabled={rowBusy === 'headers'}
                            onClick={() => setHeaderEdit(null)}
                            className={SMALL_CANCEL_BUTTON}
                          >
                            {t('settings.mcp.headers.cancel')}
                          </button>
                          <button
                            type="button"
                            disabled={rowBusy != null}
                            onClick={() => void handleSaveHeaders(server.id)}
                            className={SMALL_SAVE_BUTTON}
                          >
                            {t('settings.mcp.headers.save')}
                          </button>
                        </div>
                      </div>
                    )}
                    {/* Sign-in alert — a filled warning card under the URL
                        (the app's amber idiom, like the warning Badge), away
                        from the row actions: a short prompt + the one button.
                        With headers configured the wording points at them
                        too — an expired header value is the likelier fix. */}
                    {server.state === 'needs-auth' && (
                      <div className="ms-5 flex items-center justify-between gap-3 rounded-md bg-amber-500/15 px-3 py-2 ring-1 ring-amber-500/30">
                        <span className="flex min-w-0 items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                          <Alert02Icon size={16} className="shrink-0" />
                          <span className="truncate">
                            {t(
                              server.headers?.length
                                ? 'settings.mcp.auth.promptHeaders'
                                : 'settings.mcp.auth.prompt'
                            )}
                          </span>
                        </span>
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={rowBusy != null}
                          onClick={() => void handleSignIn(server.id)}
                        >
                          {t('settings.mcp.actions.signIn')}
                        </Button>
                      </div>
                    )}
                    {/* Below the URL: while connecting, the live handshake
                        progress; otherwise errors and issues — a failed
                        Test / Sign-in, or an offline server's error —
                        verbatim. A *successful* test is a toast instead. */}
                    {(() => {
                      if (server.state === 'connecting') {
                        return (
                          <div className="ms-5">
                            <pre dir="ltr" className={cn(CODE_BLOCK, 'text-muted')}>
                              {server.progress ?? t('settings.mcp.progress.generic')}
                            </pre>
                          </div>
                        )
                      }
                      const issue =
                        issues[server.id] ?? (server.state === 'offline' ? server.error : undefined)
                      if (!issue) return null
                      return (
                        <div className="ms-5">
                          <pre dir="ltr" className={cn(CODE_BLOCK, 'text-rose-500')}>
                            {issue}
                          </pre>
                        </div>
                      )
                    })()}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* Add a connection */}
        <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
          <div className="flex flex-col gap-1">
            <span className="text-muted text-xs font-medium uppercase tracking-wider">
              {t('settings.mcp.add.title')}
            </span>
            <p className="text-muted text-xs">{t('settings.mcp.add.subtitle')}</p>
          </div>
          <Input
            label={t('settings.mcp.add.targetLabel')}
            placeholder={t('settings.mcp.add.targetPlaceholder')}
            value={target}
            dir="ltr"
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd()
            }}
          />
          <Input
            label={t('settings.mcp.add.nameLabel')}
            placeholder={t('settings.mcp.add.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd()
            }}
          />
          {isStdio && !showEnv && (
            <button
              type="button"
              onClick={() => setShowEnv(true)}
              className="text-muted hover:text-fg self-start text-xs font-medium focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              {t('settings.mcp.add.envToggle')}
            </button>
          )}
          {isHttp && !showAddHeaders && (
            <button
              type="button"
              onClick={() => {
                setShowAddHeaders(true)
                setAddHeaderRows((rows) => (rows.length > 0 ? rows : [makeHeaderRow()]))
              }}
              className={TEXT_TOGGLE_BUTTON}
            >
              {t('settings.mcp.headers.toggle')}
            </button>
          )}
          {isHttp && showAddHeaders && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted text-sm font-medium">
                {t('settings.mcp.headers.label')}
              </span>
              <HeadersEditor rows={addHeaderRows} onChange={setAddHeaderRows} disabled={adding} />
              <p className="text-muted/80 text-xs">{t('settings.mcp.headers.hint')}</p>
            </div>
          )}
          {isStdio && showEnv && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted text-sm font-medium">
                {t('settings.mcp.add.envLabel')}
              </span>
              <textarea
                value={envText}
                dir="ltr"
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={t('settings.mcp.add.envPlaceholder')}
                rows={3}
                spellCheck={false}
                className="border-border bg-bg text-fg placeholder:text-muted/60 w-full rounded-lg border px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted/80 min-w-0 truncate text-xs">
              {addError ??
                (target.trim()
                  ? isStdio
                    ? t('settings.mcp.add.hintStdio')
                    : t('settings.mcp.add.hintHttp')
                  : '')}
            </p>
            <Button size="sm" disabled={!target.trim() || adding} onClick={() => void handleAdd()}>
              {t('settings.mcp.add.button')}
            </Button>
          </div>
        </section>

        {/* How this works — a calm explainer, kept at the bottom. */}
        <section className="bg-surface border-border flex flex-col gap-2 rounded-2xl border p-6">
          <span className="text-muted text-xs font-medium uppercase tracking-wider">
            {t('settings.mcp.how.title')}
          </span>
          <p className="text-muted text-sm leading-relaxed">{t('settings.mcp.how.add')}</p>
          <p className="text-muted text-sm leading-relaxed">{t('settings.mcp.how.tools')}</p>
          <p className="text-muted text-sm leading-relaxed">{t('settings.mcp.how.background')}</p>
          <p className="text-muted text-sm leading-relaxed">{t('settings.mcp.how.offline')}</p>
        </section>
      </div>
    </div>
  )
}
