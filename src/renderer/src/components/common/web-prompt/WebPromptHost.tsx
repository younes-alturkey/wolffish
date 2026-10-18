import { Button } from '@components/core/Button'
import { Input } from '@components/core/Input'
import { Modal } from '@components/core/Modal'
import { ToggleSwitch } from '@components/common/toggle-switch/ToggleSwitch'
import { cn } from '@lib/utils/cn'
import { registerWebPrompt, type WebPromptOptions } from '@lib/web-bridge/prompt'
import type { DirectoryListing } from '@preload/index'
import { ArrowUp02Icon, Folder01Icon, FolderOpenIcon } from 'hugeicons-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

type Pending = { options: WebPromptOptions; resolve: (value: string | null) => void }

/**
 * Renders the web bridge's prompt as the app's own sheet. Mounted once at app
 * level on the web; registers itself as the prompt handler for its lifetime.
 *
 * A plain prompt is a field and a button. A folder prompt is a browser of the
 * machine the agent runs on — home, the workspace and the root as starting
 * points, a breadcrumb to climb, one level of folders to tap into — with the
 * field still there for anyone who would rather type the path.
 */
export function WebPromptHost(): React.JSX.Element | null {
  const { t } = useTranslation()
  const [pending, setPending] = useState<Pending | null>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [hidden, setHidden] = useState(false)

  const navigate = useCallback(async (target: string, showHidden: boolean): Promise<void> => {
    setLoading(true)
    try {
      const next = await window.api.paths.listDirectories(target, { hidden: showHidden })
      setListing(next)
      setValue(next.path)
      setError(next.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    registerWebPrompt(
      (options) =>
        new Promise<string | null>((resolve) => {
          setValue(options.defaultValue ?? '')
          setError(null)
          setListing(null)
          setHidden(false)
          setPending({ options, resolve })
          if (options.browse === 'directory') void navigate(options.defaultValue ?? '~', false)
        })
    )
    return () => registerWebPrompt(null)
  }, [navigate])

  const close = (result: string | null): void => {
    pending?.resolve(result)
    setPending(null)
  }

  const submit = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    try {
      const problem = pending.options.validate ? await pending.options.validate(value) : null
      if (problem) {
        setError(problem)
        return
      }
      close(value.trim())
    } finally {
      setBusy(false)
    }
  }

  if (!pending) return null
  const browse = pending.options.browse === 'directory'
  const action = pending.options.action
  const go = (target: string): void => void navigate(target, hidden)
  const toggleHidden = (next: boolean): void => {
    setHidden(next)
    void navigate(listing?.path ?? value, next)
  }

  return (
    <Modal
      open
      onClose={() => close(null)}
      title={pending.options.title}
      footer={
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="flex-1" onClick={() => close(null)}>
            {t('common.cancel')}
          </Button>
          {action ? (
            <Button
              size="sm"
              className="flex-1"
              onClick={() => {
                action.run()
                close('')
              }}
            >
              {action.label}
            </Button>
          ) : (
            <Button
              size="sm"
              className="flex-1"
              disabled={busy || loading || (browse && !value.trim())}
              onClick={() => void submit()}
            >
              {browse ? t('web.prompt.folder.use') : t('web.prompt.confirm')}
            </Button>
          )}
        </div>
      }
    >
      {pending.options.description && (
        <p className={cn('text-muted', action && 'break-all')}>{pending.options.description}</p>
      )}
      {!action && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            // In the browser, Enter in the field goes to that path; the button confirms.
            if (browse) go(value)
            else void submit()
          }}
        >
          {browse && listing && (
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['home', listing.home],
                  ['workspace', listing.workspace],
                  ['root', listing.crumbs[0]?.path ?? '/']
                ] as const
              ).map(([key, target]) => (
                <Button
                  key={key}
                  type="button"
                  variant={listing.path === target ? 'primary' : 'outline'}
                  size="sm"
                  disabled={loading}
                  onClick={() => go(target)}
                >
                  {t(`web.prompt.folder.${key}`)}
                </Button>
              ))}
            </div>
          )}
          <Input
            autoFocus={!browse}
            dir="ltr"
            value={value}
            placeholder={pending.options.placeholder}
            onChange={(e) => {
              setValue(e.target.value)
              setError(null)
            }}
            className="font-mono text-xs"
          />
          {browse && listing && (
            <nav
              aria-label={t('web.prompt.folder.breadcrumb')}
              dir="ltr"
              className="text-muted flex items-center gap-1 overflow-x-auto text-xs whitespace-nowrap [scrollbar-width:thin]"
            >
              {listing.crumbs.map((crumb, i) => (
                <span key={crumb.path} className="flex items-center gap-1">
                  {i > 0 && <span className="text-muted/60">/</span>}
                  <button
                    type="button"
                    disabled={loading || crumb.path === listing.path}
                    onClick={() => go(crumb.path)}
                    className={cn(
                      'cursor-pointer rounded px-1 py-0.5 font-mono hover:text-fg disabled:cursor-default',
                      crumb.path === listing.path && 'text-fg font-medium'
                    )}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </nav>
          )}
          {browse && (
            <ul
              className={cn(
                'border-border bg-bg/40 max-h-64 overflow-auto rounded-xl border',
                loading && 'opacity-60'
              )}
              aria-busy={loading}
            >
              {listing?.parent && (
                <li>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => go(listing.parent!)}
                    className="text-muted hover:bg-bg hover:text-fg flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-start text-sm"
                  >
                    <ArrowUp02Icon size={16} className="shrink-0" />
                    <span>{t('web.prompt.folder.up')}</span>
                  </button>
                </li>
              )}
              {listing?.entries.map((entry) => (
                <li key={entry.path} className="border-border border-t">
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => go(entry.path)}
                    className="text-fg hover:bg-bg flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-start text-sm"
                  >
                    {entry.hidden ? (
                      <Folder01Icon size={16} className="text-muted/70 shrink-0" />
                    ) : (
                      <FolderOpenIcon size={16} className="text-muted shrink-0" />
                    )}
                    <span dir="ltr" className="min-w-0 flex-1 truncate font-mono text-xs">
                      {entry.name}
                    </span>
                  </button>
                </li>
              ))}
              {listing && !listing.error && listing.entries.length === 0 && (
                <li className="text-muted border-border border-t px-3 py-3 text-xs">
                  {t('web.prompt.folder.none')}
                </li>
              )}
              {listing?.truncated && (
                <li className="text-muted border-border border-t px-3 py-2 text-xs">
                  {t('web.prompt.folder.truncated')}
                </li>
              )}
              {!listing && (
                <li className="text-muted px-3 py-3 text-xs">{t('web.prompt.folder.loading')}</li>
              )}
            </ul>
          )}
          {browse && (
            <div className="-ms-1.5 flex items-center gap-0">
              <ToggleSwitch
                on={hidden}
                iconSize={22}
                className="h-8 w-8"
                labelOn={t('web.prompt.folder.hiddenOn')}
                labelOff={t('web.prompt.folder.hiddenOff')}
                onToggle={toggleHidden}
              />
              <button
                type="button"
                onClick={() => toggleHidden(!hidden)}
                className="text-muted hover:text-fg cursor-pointer text-xs"
              >
                {t('web.prompt.folder.hidden')}
              </button>
            </div>
          )}
        </form>
      )}
      {error && <p className="text-xs text-rose-500">{error}</p>}
    </Modal>
  )
}
