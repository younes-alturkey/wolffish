import { cn } from '@lib/utils/cn'
import type { Variable } from '@preload/index'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Add01Icon, Delete02Icon, ViewIcon, ViewOffIcon } from 'hugeicons-react'

export function VariablesPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const [variables, setVariables] = useState<Variable[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editName, setEditName] = useState('')
  const [editValue, setEditValue] = useState('')
  const [editSensitive, setEditSensitive] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [revealedIndices, setRevealedIndices] = useState<Set<number>>(new Set())
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingValue, setEditingValue] = useState('')
  /** Name of the row being value-edited — lets an external update re-anchor
   *  the edit after rows shift, without capturing stale state in the
   *  subscription closure below. */
  const editingNameRef = useRef<string | null>(null)

  useEffect(() => {
    let stale = false
    let pushed = false
    window.api.variables.list().then((list) => {
      // A change push that lands while list() is in flight is strictly newer
      // than what list() read — the slow answer must not overwrite it.
      if (!stale && !pushed) {
        setVariables(list)
        setLoaded(true)
      }
    })
    // A save from anywhere else — another window, or the paired phone — lands
    // here with the array that now holds. Apply it as-is (last write wins,
    // same as the desktop's own saves), and re-anchor an in-progress value
    // edit onto the row's new position; if the row is gone, the edit is over.
    const unsubscribe = window.api.variables.onChanged(({ variables: next }) => {
      pushed = true
      setVariables(next)
      setLoaded(true)
      setEditingIndex((prev) => {
        if (prev === null) return null
        const name = editingNameRef.current
        const at = name === null ? -1 : next.findIndex((v) => v.name === name)
        return at === -1 ? null : at
      })
    })
    return () => {
      stale = true
      unsubscribe()
    }
  }, [])

  const persist = async (next: Variable[]): Promise<void> => {
    setSaving(true)
    try {
      await window.api.variables.save(next)
      setVariables(next)
    } finally {
      setSaving(false)
    }
  }

  const addVariable = async (): Promise<void> => {
    const name = editName.trim()
    const value = editValue.trim()
    if (!name || !value) return
    if (variables.some((v) => v.name === name)) return
    const next = [...variables, { name, value, sensitive: editSensitive }]
    await persist(next)
    setEditName('')
    setEditValue('')
    setEditSensitive(false)
    setShowAddForm(false)
  }

  const removeVariable = async (index: number): Promise<void> => {
    const next = variables.filter((_, i) => i !== index)
    await persist(next)
    setRevealedIndices((prev) => {
      const copy = new Set(prev)
      copy.delete(index)
      return copy
    })
  }

  const toggleReveal = (index: number): void => {
    setRevealedIndices((prev) => {
      const copy = new Set(prev)
      if (copy.has(index)) copy.delete(index)
      else copy.add(index)
      return copy
    })
  }

  const startEditValue = (index: number): void => {
    editingNameRef.current = variables[index].name
    setEditingIndex(index)
    setEditingValue(variables[index].value)
  }

  const saveEditValue = async (): Promise<void> => {
    if (editingIndex === null) return
    const trimmed = editingValue.trim()
    if (!trimmed || trimmed === variables[editingIndex].value) {
      setEditingIndex(null)
      return
    }
    const next = variables.map((v, i) => (i === editingIndex ? { ...v, value: trimmed } : v))
    await persist(next)
    setEditingIndex(null)
  }

  const cancelEdit = (): void => {
    setEditingIndex(null)
  }

  const handleAddKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      addVariable()
    } else if (e.key === 'Escape') {
      setShowAddForm(false)
    }
  }

  const handleEditKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveEditValue()
    } else if (e.key === 'Escape') {
      cancelEdit()
    }
  }

  const duplicateName =
    editName.trim().length > 0 && variables.some((v) => v.name === editName.trim())

  if (!loaded) {
    return (
      <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
        <p className="text-muted text-sm">{t('settings.variables.loading')}</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-full w-full items-start justify-center px-6 py-10">
      <div className="flex w-full max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-fg text-2xl font-semibold tracking-tight">
            {t('settings.variables.title')}
          </h1>
          <p className="text-muted text-sm leading-relaxed">{t('settings.variables.subtitle')}</p>
        </header>

        <section className="bg-surface border-border flex flex-col gap-4 rounded-2xl border p-6">
          {variables.length === 0 && !showAddForm && (
            <p className="text-muted text-sm">{t('settings.variables.empty')}</p>
          )}

          {variables.map((v, i) => (
            <div key={v.name} className="flex flex-col gap-1.5">
              {i > 0 && <div className="border-border/60 -mt-1 mb-1 border-t" />}
              <div className="flex items-center gap-2">
                <span className="text-fg text-sm font-medium">{v.name}</span>
                {v.sensitive && (
                  <span className="bg-border/50 text-muted rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
                    {t('settings.variables.sensitive')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  {editingIndex === i ? (
                    <input
                      type={v.sensitive ? 'password' : 'text'}
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onKeyDown={handleEditKeyDown}
                      onBlur={saveEditValue}
                      autoFocus
                      className={cn(
                        'bg-bg border-border text-fg block w-full rounded-lg border px-3 py-1.5 font-mono text-xs leading-5',
                        'focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg focus:outline-none'
                      )}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startEditValue(i)}
                      className={cn(
                        'text-muted hover:text-fg hover:bg-bg/50 block w-full cursor-pointer truncate rounded-lg border border-transparent px-3 py-1.5 text-start font-mono text-xs leading-5'
                      )}
                    >
                      {v.sensitive && !revealedIndices.has(i)
                        ? '•'.repeat(Math.min(v.value.length, 24))
                        : v.value}
                    </button>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {v.sensitive && (
                    <button
                      type="button"
                      onClick={() => toggleReveal(i)}
                      className="text-muted hover:text-fg cursor-pointer rounded-lg p-1.5"
                      aria-label={
                        revealedIndices.has(i)
                          ? t('settings.variables.hide')
                          : t('settings.variables.reveal')
                      }
                    >
                      {revealedIndices.has(i) ? <ViewOffIcon size={14} /> : <ViewIcon size={14} />}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => removeVariable(i)}
                    disabled={saving}
                    className="text-muted hover:text-red-400 cursor-pointer rounded-lg p-1.5 disabled:cursor-not-allowed disabled:opacity-60"
                    aria-label={t('settings.variables.remove')}
                  >
                    <Delete02Icon size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}

          {showAddForm && (
            <>
              {variables.length > 0 && <div className="border-border/60 border-t" />}
              <div className="flex flex-col gap-3">
                <div className="flex gap-3">
                  <input
                    type="text"
                    placeholder={t('settings.variables.namePlaceholder')}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={handleAddKeyDown}
                    autoFocus
                    className={cn(
                      'bg-bg border-border text-fg placeholder:text-muted/60 flex-1 rounded-lg border px-3 py-2 text-sm',
                      'focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg focus:outline-none',
                      duplicateName && 'border-red-400/60'
                    )}
                  />
                  <input
                    type={editSensitive ? 'password' : 'text'}
                    placeholder={t('settings.variables.valuePlaceholder')}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={handleAddKeyDown}
                    className={cn(
                      'bg-bg border-border text-fg placeholder:text-muted/60 flex-1 rounded-lg border px-3 py-2 text-sm',
                      'focus:ring-2 focus:ring-accent focus:ring-offset-1 focus:ring-offset-bg focus:outline-none'
                    )}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={editSensitive}
                      onChange={(e) => setEditSensitive(e.target.checked)}
                      className="accent-primary h-3.5 w-3.5 rounded"
                    />
                    <span className="text-muted text-xs">
                      {t('settings.variables.markSensitive')}
                    </span>
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowAddForm(false)}
                      className={cn(
                        'border-border text-fg hover:bg-border/40 cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-medium',
                        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg'
                      )}
                    >
                      {t('settings.variables.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={addVariable}
                      disabled={saving || !editName.trim() || !editValue.trim() || duplicateName}
                      className={cn(
                        'bg-primary text-primary-fg rounded-lg px-3 py-1.5 text-xs font-medium shadow-sm cursor-pointer',
                        'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
                        'disabled:cursor-not-allowed disabled:opacity-60'
                      )}
                    >
                      {t('settings.variables.save')}
                    </button>
                  </div>
                </div>
                {duplicateName && (
                  <p className="text-xs text-red-400">{t('settings.variables.duplicate')}</p>
                )}
              </div>
            </>
          )}

          {!showAddForm && (
            <button
              type="button"
              onClick={() => setShowAddForm(true)}
              className={cn(
                'text-muted hover:text-fg flex cursor-pointer items-center gap-1.5 self-start rounded-lg px-2 py-1.5 text-sm',
                'hover:bg-border/30'
              )}
            >
              <Add01Icon size={14} />
              <span>{t('settings.variables.add')}</span>
            </button>
          )}
        </section>

        <p className="text-muted text-xs leading-relaxed px-1">{t('settings.variables.hint')}</p>
      </div>
    </div>
  )
}
