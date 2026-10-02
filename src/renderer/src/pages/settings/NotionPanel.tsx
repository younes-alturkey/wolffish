import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { NotionLogo } from '@components/core/ProviderLogos'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import { PanelBackChevron } from '@pages/settings/drillNav'
import type { NotionConnection, NotionErrorKind } from '@preload/index'
import {
  AlertCircleIcon,
  Delete02Icon,
  EyeIcon,
  LinkSquare02Icon,
  PlusSignIcon,
  ViewOffIcon
} from 'hugeicons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { CapabilityGateBody, CapabilityGateCard, useCapabilityGate } from './capabilityGate'

const NOTION_CONNECTIONS_URL = 'https://app.notion.com/developers/connections'

// A connection row as edited in the UI: the persisted shape plus transient
// view state (token visibility, in-flight test, last test failure). The error
// is stored as a kind (not translated text) so it re-renders on language
// switch.
type TestError = { kind: NotionErrorKind; message?: string | null }
type Row = NotionConnection & { tokenVisible: boolean; busy: boolean; testError: TestError | null }

function newRow(): Row {
  return {
    id: crypto.randomUUID(),
    label: '',
    token: '',
    name: '',
    email: '',
    tokenVisible: false,
    busy: false,
    testError: null
  }
}

function toRow(c: NotionConnection): Row {
  return { ...c, tokenVisible: false, busy: false, testError: null }
}

// Strip transient view fields before persisting. Only connections carrying a
// token are kept — a label with no token can't be used by the model.
function toStored(rows: Row[]): NotionConnection[] {
  return rows
    .filter((r) => r.token.trim().length > 0)
    .map((r) => ({
      id: r.id,
      label: r.label.trim(),
      token: r.token.trim(),
      name: r.name,
      email: r.email
    }))
}

function normLabel(label: string): string {
  return label.trim().toLowerCase()
}

// Module-level cache of the persisted connections, warmed once at app start
// (this panel is eagerly imported, so the load below runs during startup). By
// the time the user opens the panel the connections are already in memory and
// paint on the first frame — no IPC round-trip, no empty-list flash. Kept in
// sync on every persist. `null` means "not loaded yet".
let cachedConnections: NotionConnection[] | null = null
let loadPromise: Promise<NotionConnection[]> | null = null

function loadConnections(): Promise<NotionConnection[]> {
  if (cachedConnections) return Promise.resolve(cachedConnections)
  if (!loadPromise) {
    const api = window.api?.notion
    if (!api) return Promise.resolve([]) // preload not ready yet; retry on mount
    loadPromise = api
      .getConfig()
      .then((cfg) => {
        cachedConnections = toStored(cfg.connections.map(toRow))
        return cachedConnections
      })
      .catch(() => {
        cachedConnections = []
        return cachedConnections
      })
  }
  return loadPromise
}

// Prefill the cache at app start.
void loadConnections()

export function NotionPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const gate = useCapabilityGate('notion')

  // Seed from the module cache so the panel paints connections immediately.
  const [rows, setRows] = useState<Row[]>(() => (cachedConnections ?? []).map(toRow))
  // JSON snapshot of the last-persisted array, to detect unsaved edits.
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(cachedConnections ?? []))
  // Gate the empty-state placeholder on the first config load so it doesn't
  // flash before the cache is warm.
  const [ready, setReady] = useState(cachedConnections !== null)
  // Mirror of `rows` readable after an await, so async handlers reconcile
  // against the latest committed state instead of a stale render closure.
  const rowsRef = useRef(rows)
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Usually already warm from app start; seed here only if we mounted
      // before that finished.
      const conns = await loadConnections()
      if (cancelled) return
      if (!ready) {
        setRows(conns.map(toRow))
        setSavedJson(JSON.stringify(conns))
        setReady(true)
      }

      // Silent revalidation on open (like the models panel): re-verify each
      // token and refresh the resolved account. No toasts, no busy state, and
      // it only touches state when something actually changed — so a
      // still-valid connected account never flashes.
      const tokened = conns.filter((c) => c.token.trim().length > 0)
      if (tokened.length === 0) return
      const results = await Promise.all(
        tokened.map(async (c) => ({
          id: c.id,
          token: c.token,
          res: await window.api.notion.test(c.token)
        }))
      )
      if (cancelled) return
      const byId = new Map(results.map((x) => [x.id, x]))
      let changed = false
      const next = rowsRef.current.map((r) => {
        const hit = byId.get(r.id)
        if (!hit || r.token.trim() !== hit.token) return r
        if (hit.res.ok) {
          const email = hit.res.email ?? ''
          if (r.name === hit.res.name && r.email === email && !r.testError) return r
          changed = true
          return { ...r, name: hit.res.name, email, testError: null }
        }
        // Only a definitively invalid token clears the cached identity and
        // raises the card alert — a transient network/rate-limit blip must
        // not drop the chip.
        if (hit.res.kind !== 'invalid_token') return r
        changed = true
        return { ...r, name: '', email: '', testError: { kind: 'invalid_token' as const } }
      })
      if (changed) {
        setRows(next)
        cachedConnections = toStored(next)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const translateError = useCallback(
    (kind: NotionErrorKind, message?: string | null): string => {
      if (kind === 'unknown') {
        return t('settings.services.notion.errors.unknown', { message: message ?? '' })
      }
      return t(`settings.services.notion.errors.${kind}`)
    },
    [t]
  )

  const persist = useCallback(async (next: Row[]) => {
    const stored = toStored(next)
    cachedConnections = stored
    await window.api.notion.setConfig(stored)
    setSavedJson(JSON.stringify(stored))
  }, [])

  const patchRow = useCallback((id: string, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }, [])

  const dirty = useMemo(() => JSON.stringify(toStored(rows)) !== savedJson, [rows, savedJson])

  // Per-row label problem: required when the row has a token, and must be
  // unique among all tokened rows (case-insensitive).
  const labelError = useCallback(
    (row: Row): 'required' | 'duplicate' | null => {
      const hasToken = row.token.trim().length > 0
      const label = row.label.trim()
      if (hasToken && label.length === 0) return 'required'
      if (label.length === 0) return null
      const dup = rows.some(
        (r) => r.id !== row.id && r.token.trim() && normLabel(r.label) === normLabel(label)
      )
      return dup ? 'duplicate' : null
    },
    [rows]
  )

  const handleAdd = useCallback(() => {
    setRows((rs) => [...rs, newRow()])
  }, [])

  const handleRemove = useCallback(
    async (id: string) => {
      const next = rows.filter((r) => r.id !== id)
      setRows(next)
      await persist(next)
    },
    [rows, persist]
  )

  // Editing the token invalidates the previously resolved account — a new
  // token may belong to a different workspace, so clear the cached identity
  // and any stale test failure.
  const handleTokenChange = useCallback((id: string, value: string) => {
    setRows((rs) =>
      rs.map((r) =>
        r.id === id ? { ...r, token: value, name: '', email: '', testError: null } : r
      )
    )
  }, [])

  const handleTest = useCallback(
    async (id: string) => {
      const row = rows.find((r) => r.id === id)
      if (!row) return
      const label = row.label.trim()
      const token = row.token.trim()
      if (label.length === 0) {
        toast.show({
          message: t('settings.services.notion.connections.labelRequired'),
          tone: 'error'
        })
        return
      }
      if (token.length === 0) {
        toast.show({
          message: t('settings.services.notion.validation.tokenRequired'),
          tone: 'error'
        })
        return
      }
      if (
        rows.some((r) => r.id !== id && r.token.trim() && normLabel(r.label) === normLabel(label))
      ) {
        toast.show({
          message: t('settings.services.notion.connections.labelDuplicate'),
          tone: 'error'
        })
        return
      }
      patchRow(id, { busy: true })
      try {
        const result = await window.api.notion.test(token)
        if (result.ok) {
          // Reconcile against the latest committed rows (not the stale closure
          // captured before the network round-trip), so edits the user made to
          // other rows while the test was in flight aren't clobbered. Only the
          // tested row's resolved identity is written, and only if its token
          // still matches what we tested.
          const next = rowsRef.current.map((r) =>
            r.id === id && r.token.trim() === token
              ? { ...r, name: result.name, email: result.email ?? '', busy: false, testError: null }
              : r
          )
          setRows(next)
          await persist(next)
          toast.show({
            message: t('settings.services.notion.testSuccess', {
              name: result.name,
              email: result.email ?? ''
            }),
            tone: 'success'
          })
        } else {
          patchRow(id, {
            busy: false,
            name: '',
            email: '',
            testError: { kind: result.kind, message: result.message ?? null }
          })
          toast.show({
            message: t('settings.services.notion.testFailure', {
              message: translateError(result.kind, result.message)
            }),
            tone: 'error'
          })
        }
      } finally {
        patchRow(id, { busy: false })
      }
    },
    [rows, persist, patchRow, t, toast, translateError]
  )

  const handleSaveAll = useCallback(async () => {
    // Block save while any tokened row has an invalid label.
    for (const r of rows) {
      const err = labelError(r)
      if (err === 'required') {
        toast.show({
          message: t('settings.services.notion.connections.labelRequired'),
          tone: 'error'
        })
        return
      }
      if (err === 'duplicate') {
        toast.show({
          message: t('settings.services.notion.connections.labelDuplicate'),
          tone: 'error'
        })
        return
      }
    }
    // Ids that were persisted before this save. A row whose token was cleared
    // is dropped from disk by toStored; drop it from the visible list too so
    // the UI matches what's stored. Fresh drafts (ids not yet saved) stay.
    const savedIds = new Set<string>()
    try {
      for (const c of JSON.parse(savedJson) as NotionConnection[]) savedIds.add(c.id)
    } catch {
      // savedJson is always our own JSON; ignore a malformed snapshot.
    }

    // Saving verifies every connection against the API and resolves its
    // account, not just writing tokens blindly.
    const tokened = rows.filter((r) => r.token.trim().length > 0)
    setRows((rs) => rs.map((r) => (r.token.trim().length > 0 ? { ...r, busy: true } : r)))
    const results = await Promise.all(
      tokened.map(async (r) => ({
        id: r.id,
        label: r.label.trim(),
        token: r.token.trim(),
        res: await window.api.notion.test(r.token.trim())
      }))
    )
    const byId = new Map(results.map((x) => [x.id, x]))
    const next = rowsRef.current
      .map((r) => {
        const hit = byId.get(r.id)
        if (!hit || r.token.trim() !== hit.token) return { ...r, busy: false }
        return hit.res.ok
          ? { ...r, name: hit.res.name, email: hit.res.email ?? '', busy: false, testError: null }
          : {
              ...r,
              name: '',
              email: '',
              busy: false,
              testError: { kind: hit.res.kind, message: hit.res.message ?? null }
            }
      })
      .filter((r) => r.token.trim().length > 0 || !savedIds.has(r.id))
    setRows(next)
    await persist(next)

    let anyFailure = false
    for (const x of results) {
      if (x.res.ok) continue
      anyFailure = true
      toast.show({
        message: t('settings.services.notion.testFailure', {
          message: `${x.label}: ${translateError(x.res.kind, x.res.message)}`
        }),
        tone: 'error'
      })
    }
    if (!anyFailure) {
      toast.show({ message: t('settings.services.notion.saveSuccess'), tone: 'success' })
    }
  }, [rows, labelError, persist, savedJson, t, toast, translateError])

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <PanelBackChevron />
              <h1 className="text-fg text-2xl font-semibold tracking-tight">
                {t('settings.services.notion.title')}
              </h1>
            </div>
            <a
              href={NOTION_CONNECTIONS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                'text-muted hover:text-fg flex items-center gap-1.5 text-xs',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-md px-1.5 py-1'
              )}
            >
              <span>{t('settings.services.notion.platform')}</span>
              <LinkSquare02Icon size={13} className="shrink-0" />
            </a>
          </div>
          <p className="text-muted text-sm leading-relaxed">
            {t('settings.services.notion.subtitle')}
          </p>
        </header>

        <CapabilityGateCard gate={gate} label={t('settings.services.tabs.notion')} />

        <CapabilityGateBody gate={gate}>
          <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
            <div className="flex flex-col gap-1">
              <h2 className="text-fg text-sm font-medium">
                {t('settings.services.notion.connections.title')}
              </h2>
              <p className="text-muted text-xs leading-relaxed">
                {t('settings.services.notion.connections.subtitle')}
              </p>
            </div>

            {ready && rows.length === 0 && (
              <p className="text-muted bg-bg/40 border-border rounded-xl border border-dashed px-4 py-6 text-center text-sm">
                {t('settings.services.notion.connections.empty')}
              </p>
            )}

            <div className="flex flex-col gap-4">
              {rows.map((row, index) => (
                <ConnectionCard
                  key={row.id}
                  row={row}
                  index={index}
                  labelError={labelError(row)}
                  testErrorText={
                    row.testError ? translateError(row.testError.kind, row.testError.message) : null
                  }
                  onLabel={(v) => patchRow(row.id, { label: v })}
                  onToken={(v) => handleTokenChange(row.id, v)}
                  onToggleToken={() => patchRow(row.id, { tokenVisible: !row.tokenVisible })}
                  onTest={() => void handleTest(row.id)}
                  onRemove={() => void handleRemove(row.id)}
                />
              ))}
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={handleAdd}>
                <PlusSignIcon size={15} />
                {t('settings.services.notion.connections.add')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSaveAll()}
                disabled={!dirty || rows.some((r) => r.busy)}
              >
                {t('settings.services.notion.save')}
              </Button>
            </div>

            <p className="text-muted text-xs">{t('settings.services.notion.testHint')}</p>
          </section>

          <HowItWorksSection />
        </CapabilityGateBody>
      </div>
    </div>
  )
}

type CardProps = {
  row: Row
  index: number
  labelError: 'required' | 'duplicate' | null
  testErrorText: string | null
  onLabel: (v: string) => void
  onToken: (v: string) => void
  onToggleToken: () => void
  onTest: () => void
  onRemove: () => void
}

function ConnectionCard({
  row,
  index,
  labelError,
  testErrorText,
  onLabel,
  onToken,
  onToggleToken,
  onTest,
  onRemove
}: CardProps): React.JSX.Element {
  const { t } = useTranslation()
  const labelId = `notion-label-${row.id}`
  const tokenId = `notion-token-${row.id}`
  const connected = row.name.length > 0
  const testDisabled = row.busy || row.token.trim().length === 0 || row.label.trim().length === 0

  const errorText =
    labelError === 'required'
      ? t('settings.services.notion.connections.labelRequired')
      : labelError === 'duplicate'
        ? t('settings.services.notion.connections.labelDuplicate')
        : null

  return (
    <div className="bg-bg/40 border-border flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="bg-surface border-border flex h-8 w-8 shrink-0 items-center justify-center rounded-full border">
            <NotionLogo size={16} />
          </div>
          <span className="text-muted text-xs font-medium uppercase tracking-wider">
            {row.label.trim() ||
              t('settings.services.notion.connections.untitled', { index: index + 1 })}
          </span>
        </div>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('settings.services.notion.connections.remove')}
          className={cn(
            'text-muted hover:text-rose-500 flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md',
            'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
          )}
        >
          <Delete02Icon size={16} />
        </button>
      </div>

      {connected && (
        <div className="bg-surface/60 border-border flex items-center gap-2 rounded-lg border px-3 py-2">
          <span className="text-muted text-xs font-medium uppercase tracking-wider">
            {t('settings.services.notion.connectedAs')}
          </span>
          <span className="text-fg truncate text-sm font-medium">
            {row.email ? `${row.name} (${row.email})` : row.name}
          </span>
        </div>
      )}

      {!connected && testErrorText && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-900/40 dark:text-red-100"
        >
          <AlertCircleIcon size={16} className="mt-0.5 shrink-0" />
          <span>{testErrorText}</span>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={labelId} className="text-muted text-sm font-medium">
          {t('settings.services.notion.connections.label')}
        </label>
        <Input
          id={labelId}
          value={row.label}
          onChange={(e) => onLabel(e.target.value)}
          placeholder={t('settings.services.notion.connections.labelPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errorText ? true : undefined}
        />
        {errorText ? (
          <p className="text-xs text-rose-500" role="alert">
            {errorText}
          </p>
        ) : (
          <p className="text-muted text-xs">
            {t('settings.services.notion.connections.labelHint')}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={tokenId} className="text-muted text-sm font-medium">
          {t('settings.services.notion.token')}
        </label>
        <div className="relative w-full">
          <Input
            id={tokenId}
            type={row.tokenVisible ? 'text' : 'password'}
            value={row.token}
            onChange={(e) => onToken(e.target.value)}
            placeholder={t('settings.services.notion.tokenPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            className="pe-10 font-mono"
          />
          <button
            type="button"
            onClick={onToggleToken}
            aria-label={t(
              row.tokenVisible
                ? 'settings.services.notion.hideToken'
                : 'settings.services.notion.showToken'
            )}
            className={cn(
              'text-muted hover:text-fg absolute inset-e-2 top-1/2 -translate-y-1/2',
              'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
            )}
          >
            {row.tokenVisible ? <ViewOffIcon size={16} /> : <EyeIcon size={16} />}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-start">
        <button
          type="button"
          disabled={testDisabled}
          onClick={onTest}
          className={cn(
            'text-sm font-medium capitalize',
            row.busy
              ? 'text-muted animate-pulse cursor-wait'
              : testDisabled
                ? 'text-muted cursor-not-allowed'
                : 'text-primary hover:text-primary/80 cursor-pointer'
          )}
        >
          {t('settings.services.notion.testConnection')}
        </button>
      </div>
    </div>
  )
}

function HowItWorksSection(): React.JSX.Element {
  const { t } = useTranslation()
  const points: string[] = [
    t('settings.services.notion.howItWorks.integration'),
    t('settings.services.notion.howItWorks.pages'),
    t('settings.services.notion.howItWorks.databases'),
    t('settings.services.notion.howItWorks.privacy'),
    t('settings.services.notion.howItWorks.setup')
  ]
  return (
    <section className="bg-surface border-border flex flex-col gap-3 rounded-2xl border p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-fg text-sm font-medium">
          {t('settings.services.notion.howItWorksTitle')}
        </h2>
      </header>
      <ul className="text-muted flex flex-col gap-1.5 text-xs leading-relaxed">
        {points.map((line, i) => (
          <li key={i} className="flex gap-2">
            <span aria-hidden="true">•</span>
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
