import { Badge } from '@components/core/Badge'
import { Button } from '@components/core/Button'
import { Modal } from '@components/core/Modal'
import { useToast } from '@components/core/toast/useToast'
import { cn } from '@lib/utils/cn'
import type { CapabilityEntry } from '@preload/index'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircleIcon,
  Archive02Icon,
  CheckmarkBadge01Icon,
  CloudUploadIcon,
  Delete02Icon,
  File01Icon,
  Folder01Icon,
  HelpCircleIcon,
  InformationCircleIcon,
  Loading03Icon,
  Refresh01Icon,
  SecurityCheckIcon,
  SparklesIcon,
  SquareLock02Icon,
  TestTube01Icon
} from 'hugeicons-react'

export function CapabilitiesPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [capabilities, setCapabilities] = useState<CapabilityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [resyncing, setResyncing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    let stale = false
    window.api.cerebellum
      .listCapabilities()
      .then((data) => {
        if (!stale) setCapabilities(data)
      })
      .finally(() => {
        if (!stale) setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [])

  // Follow toggles made anywhere else — the paired phone, the agent's skills
  // plugin. Main broadcasts the refreshed list on every capability write, so
  // a flip on the phone moves this panel's switch the moment it lands.
  useEffect(() => window.api.cerebellum.onCapabilitiesChanged(setCapabilities), [])

  const onResync = async (): Promise<void> => {
    setResyncing(true)
    try {
      const data = await window.api.cerebellum.reload()
      setCapabilities(data)
      toast.show({ tone: 'success', message: t('settings.capabilities.resyncSuccessToast') })
    } catch {
      toast.show({ tone: 'error', message: t('settings.capabilities.resyncErrorToast') })
    } finally {
      setResyncing(false)
    }
  }

  // Validate + import a dropped/picked path, then refresh the list so the new
  // capability shows up immediately (same machinery as Resync).
  const runImport = useCallback(
    async (sourcePath: string): Promise<void> => {
      if (importing) return
      setImporting(true)
      setImportError(null)
      try {
        const result = await window.api.cerebellum.importCapability(sourcePath)
        if (result.ok) {
          const fresh = await window.api.cerebellum.reload()
          setCapabilities(fresh)
          toast.show({
            tone: 'success',
            message: t('settings.capabilities.import.successToast', { name: result.name })
          })
        } else {
          setImportError(result.error)
          toast.show({ tone: 'error', message: t('settings.capabilities.import.errorToast') })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setImportError(message)
        toast.show({ tone: 'error', message: t('settings.capabilities.import.errorToast') })
      } finally {
        setImporting(false)
      }
    },
    [importing, t, toast]
  )

  const onBrowse = useCallback(async (): Promise<void> => {
    if (importing) return
    const picked = await window.api.cerebellum.pickImport({
      title: t('settings.capabilities.import.dialogTitle'),
      filterName: t('settings.capabilities.import.dialogFilter')
    })
    if (picked) await runImport(picked)
  }, [importing, runImport, t])

  // Confirmed delete — nukes the capability folder, then swaps in the fresh
  // list the main process returns.
  const runDelete = useCallback(
    async (name: string): Promise<void> => {
      setDeleting(true)
      try {
        const result = await window.api.cerebellum.deleteCapability(name)
        if (result.ok) {
          setCapabilities(result.capabilities)
          toast.show({
            tone: 'success',
            message: t('settings.capabilities.delete.successToast', { name })
          })
        } else {
          toast.show({ tone: 'error', message: result.error })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toast.show({ tone: 'error', message })
      } finally {
        setDeleting(false)
        setDeleteTarget(null)
      }
    },
    [t, toast]
  )

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h1 className="text-fg text-2xl font-semibold tracking-tight">
                {t('settings.capabilities.title')}
              </h1>
              {!loading && (
                <Badge variant="default" size="sm">
                  {capabilities.length}
                </Badge>
              )}
            </div>
            <p className="text-muted text-sm leading-relaxed">
              {t('settings.capabilities.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void onResync()}
            disabled={resyncing}
            aria-label={t('settings.capabilities.resync')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md text-xs cursor-pointer',
              'text-muted hover:text-fg px-1.5 py-0.5',
              'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
              'disabled:cursor-not-allowed disabled:opacity-40'
            )}
          >
            <Refresh01Icon size={14} />
            <span>{t('settings.capabilities.resync')}</span>
          </button>
        </header>

        <ImportSection
          importing={importing}
          error={importError}
          onImport={(p) => void runImport(p)}
          onBrowse={() => void onBrowse()}
          onDismissError={() => setImportError(null)}
        />

        {loading ? (
          <div className="text-muted py-12 text-center text-sm">
            {t('settings.capabilities.loading')}
          </div>
        ) : capabilities.length === 0 ? (
          <div className="text-muted py-12 text-center text-sm">
            {t('settings.capabilities.empty')}
          </div>
        ) : (
          <section className="bg-surface border-border flex flex-col rounded-2xl border">
            {[...capabilities]
              // Locked core capabilities sink to the very bottom; within each
              // group official caps sort after user-imported ones. (Array.sort
              // is stable, so same-key rows keep their load order.)
              .sort(
                (a, b) => Number(a.core) - Number(b.core) || Number(a.official) - Number(b.official)
              )
              .map((cap, i) => (
                <div key={cap.name}>
                  {i > 0 && <div className="border-border/60 border-t" />}
                  <CapabilityRow
                    cap={cap}
                    onToggle={(enabled) => {
                      void window.api.cerebellum.toggleCapability(cap.name, enabled)
                      setCapabilities((prev) =>
                        prev.map((c) => (c.name === cap.name ? { ...c, enabled } : c))
                      )
                    }}
                    onRequestDelete={() => setDeleteTarget(cap.name)}
                  />
                </div>
              ))}
          </section>
        )}
      </div>

      <DeleteCapabilityModal
        name={deleteTarget}
        deleting={deleting}
        onCancel={() => !deleting && setDeleteTarget(null)}
        onConfirm={() => deleteTarget && void runDelete(deleteTarget)}
      />
    </div>
  )
}

function DeleteCapabilityModal({
  name,
  deleting,
  onCancel,
  onConfirm
}: {
  name: string | null
  deleting: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Modal
      open={name !== null}
      onClose={onCancel}
      dismissable={!deleting}
      title={t('settings.capabilities.delete.title')}
      footer={
        <>
          <Button
            size="md"
            variant="primary"
            disabled={deleting}
            onClick={onConfirm}
            className="bg-red-600 text-white hover:bg-red-700"
          >
            {t('settings.capabilities.delete.cta')}
          </Button>
          <Button size="md" variant="ghost" onClick={onCancel} disabled={deleting}>
            {t('settings.capabilities.delete.cancel')}
          </Button>
        </>
      }
    >
      <p>{t('settings.capabilities.delete.warning', { name: name ?? '' })}</p>
    </Modal>
  )
}

function ImportSection({
  importing,
  error,
  onImport,
  onBrowse,
  onDismissError
}: {
  importing: boolean
  error: string | null
  onImport: (sourcePath: string) => void
  onBrowse: () => void
  onDismissError: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [dragActive, setDragActive] = useState(false)

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (importing) return
      // Only react to actual file/folder drags, not text selections.
      if (!Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      setDragActive(true)
    },
    [importing]
  )

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null
    if (related && (e.currentTarget as Node).contains(related)) return
    setDragActive(false)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setDragActive(false)
      if (importing) return
      const file = e.dataTransfer.files?.[0]
      if (!file) return
      // Resolve the real filesystem path — for a single file, a folder, or a
      // .zip alike. main does the rest (validate, unpack, copy).
      const sourcePath = window.api.upload.getPathForFile(file)
      if (!sourcePath) {
        toast.show({ tone: 'error', message: t('settings.capabilities.import.readError') })
        return
      }
      onImport(sourcePath)
    },
    [importing, onImport, t, toast]
  )

  return (
    <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
      <div className="flex flex-col gap-1.5">
        <span className="text-muted text-xs font-medium uppercase tracking-wider">
          {t('settings.capabilities.import.label')}
        </span>
        <p className="text-muted text-xs">{t('settings.capabilities.import.hint')}</p>
      </div>

      <div
        role="button"
        tabIndex={importing ? -1 : 0}
        aria-label={t('settings.capabilities.import.dropzone')}
        aria-disabled={importing}
        onClick={() => !importing && onBrowse()}
        onKeyDown={(e) => {
          if (importing) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onBrowse()
          }
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center',
          'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
          importing
            ? 'border-border pointer-events-none opacity-60'
            : dragActive
              ? 'border-primary bg-primary/5 cursor-copy'
              : 'border-border hover:border-muted cursor-pointer'
        )}
      >
        {importing ? (
          <>
            <Loading03Icon size={24} className="text-muted animate-spin" />
            <span className="text-muted text-sm">
              {t('settings.capabilities.import.importing')}
            </span>
          </>
        ) : (
          <>
            <CloudUploadIcon size={24} className={dragActive ? 'text-primary' : 'text-muted'} />
            <span className={cn('text-sm', dragActive ? 'text-primary' : 'text-muted')}>
              {dragActive
                ? t('settings.capabilities.import.dropzoneActive')
                : t('settings.capabilities.import.dropzone')}
            </span>
          </>
        )}
      </div>

      {error && <ImportErrorAlert message={error} onDismiss={onDismissError} />}

      <ImportGuide />
    </section>
  )
}

function ImportErrorAlert({
  message,
  onDismiss
}: {
  message: string
  onDismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertCircleIcon size={15} className="shrink-0 text-rose-500" />
          <span className="text-sm font-medium text-rose-500">
            {t('settings.capabilities.import.errorTitle')}
          </span>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className={cn(
            'rounded-md px-1.5 py-0.5 text-xs font-medium cursor-pointer',
            'text-rose-500 hover:bg-rose-500/10 hover:text-rose-600',
            'focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
          )}
        >
          {t('settings.capabilities.import.dismiss')}
        </button>
      </div>
      <pre className="bg-bg/60 border-border text-fg/90 whitespace-pre-wrap wrap-break-word rounded-md border px-3 py-2 font-mono text-xs leading-relaxed">
        {message}
      </pre>
    </div>
  )
}

const IMPORT_OPTIONS = [
  { key: 'skill', Icon: File01Icon },
  { key: 'folder', Icon: Folder01Icon },
  { key: 'zip', Icon: Archive02Icon }
] as const

function ImportGuide(): React.JSX.Element {
  const { t } = useTranslation()
  const base = 'settings.capabilities.import.guide'

  return (
    <div className="border-border/60 flex flex-col gap-3 border-t pt-4">
      <span className="text-muted text-xs font-medium">{t(`${base}.title`)}</span>
      <ul className="flex flex-col gap-2.5">
        {IMPORT_OPTIONS.map(({ key, Icon }) => (
          <li key={key} className="flex items-start gap-2.5">
            <Icon size={15} className="text-muted mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="text-fg text-xs font-medium">{t(`${base}.${key}Title`)}</span>
              <span className="text-muted text-xs leading-relaxed">{t(`${base}.${key}Desc`)}</span>
            </div>
          </li>
        ))}
      </ul>
      <div className="bg-bg/40 border-border flex items-start gap-2 rounded-md border px-3 py-2.5">
        <InformationCircleIcon size={13} className="text-muted mt-0.5 shrink-0" />
        <span className="text-muted text-xs leading-relaxed">{t(`${base}.tip`)}</span>
      </div>
    </div>
  )
}

function CapabilityRow({
  cap,
  onToggle,
  onRequestDelete
}: {
  cap: CapabilityEntry
  onToggle: (enabled: boolean) => void
  onRequestDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const isOk = cap.status === 'ok'

  return (
    <div className={cn('flex flex-col gap-3 p-5', !cap.enabled && 'opacity-50')}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-fg text-sm font-medium">{cap.name}</span>

          <div className="flex items-center gap-1.5">
            {cap.enabled ? (
              isOk ? (
                <Badge variant="success" size="sm">
                  <CheckmarkBadge01Icon size={11} />
                  {t('settings.capabilities.active')}
                </Badge>
              ) : (
                <Badge variant="danger" size="sm">
                  <AlertCircleIcon size={11} />
                  {t('settings.capabilities.error')}
                </Badge>
              )
            ) : (
              <Badge variant="default" size="sm">
                {t('settings.capabilities.inactive')}
              </Badge>
            )}

            {cap.enabled &&
              isOk &&
              (cap.core ? (
                <Badge
                  variant="default"
                  size="sm"
                  className="bg-primary/10! text-primary! ring-primary/30!"
                >
                  <SquareLock02Icon size={11} />
                  {t('settings.capabilities.core')}
                </Badge>
              ) : cap.official ? (
                <Badge
                  variant="default"
                  size="sm"
                  className="bg-primary/10! text-primary! ring-primary/30!"
                >
                  <SecurityCheckIcon size={11} />
                  {t('settings.capabilities.official')}
                </Badge>
              ) : cap.wolffish ? (
                // Authored by Wolffish itself via skill_create — its own badge,
                // neither Official (bundled) nor Unknown (hand-imported).
                <Badge
                  variant="default"
                  size="sm"
                  className="bg-primary/10! text-primary! ring-primary/30!"
                >
                  <SparklesIcon size={11} />
                  {t('settings.capabilities.wolffish')}
                </Badge>
              ) : (
                <Badge variant="default" size="sm">
                  <HelpCircleIcon size={11} />
                  {t('settings.capabilities.unknown')}
                </Badge>
              ))}

            {/* A Wolffish-authored skill that hasn't passed a real tool call
                since creation/last edit — clears automatically on the first
                successful call (cerebellum:capabilitiesChanged refreshes it). */}
            {cap.enabled && isOk && cap.wolffish && !cap.tested && (
              <Badge variant="warning" size="sm" title={t('settings.capabilities.untestedHint')}>
                <TestTube01Icon size={11} />
                {t('settings.capabilities.untested')}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Only user-imported capabilities can be deleted; official ones have
              no trash affordance at all. Shown before the toggle. */}
          {!cap.official && (
            <button
              type="button"
              onClick={onRequestDelete}
              title={t('settings.capabilities.delete.action')}
              aria-label={t('settings.capabilities.delete.action', { name: cap.name })}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-md cursor-pointer',
                'text-muted hover:bg-rose-500/10 hover:text-rose-500',
                'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
              )}
            >
              <Delete02Icon size={16} />
            </button>
          )}
          {cap.core ? (
            // Locked core capability — no toggle; it can never be turned off.
            <div
              title={t('settings.capabilities.lockedHint')}
              className="border-border bg-bg/40 text-muted inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium"
            >
              <SquareLock02Icon size={12} />
              {t('settings.capabilities.alwaysOn')}
            </div>
          ) : (
            <div
              role="tablist"
              className="border-border bg-bg/40 inline-flex items-center rounded-lg border p-0.5"
            >
              {[false, true].map((val) => {
                const active = val === cap.enabled
                return (
                  <button
                    key={String(val)}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    onClick={() => onToggle(val)}
                    className={cn(
                      'rounded-md px-3 py-1 text-xs font-medium',
                      'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                      active
                        ? 'bg-primary text-primary-fg shadow-sm'
                        : 'text-muted hover:text-fg cursor-pointer'
                    )}
                  >
                    {t(val ? 'settings.wolffish.toggle.on' : 'settings.wolffish.toggle.off')}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {cap.description && <p className="text-muted text-xs leading-relaxed">{cap.description}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {cap.hasPlugin && (
          <span className="text-muted bg-border/30 rounded px-1.5 py-0.5 text-[10px] font-medium">
            {t('settings.capabilities.plugin')}
          </span>
        )}
        {cap.toolCount > 0 && (
          <span className="text-muted bg-border/30 rounded px-1.5 py-0.5 text-[10px] font-medium">
            {t('settings.capabilities.tools', { count: cap.toolCount })}
          </span>
        )}
        {cap.requires.length > 0 && (
          <span className="text-muted bg-border/30 rounded px-1.5 py-0.5 text-[10px] font-medium">
            {t('settings.capabilities.requires', { deps: cap.requires.join(', ') })}
          </span>
        )}
      </div>

      {cap.error && <p className="text-xs text-red-500">{cap.error}</p>}
    </div>
  )
}
