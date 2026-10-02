import type { EngineInstallPhase } from '@preload/index'
import { useCallback, useEffect, useRef, useState } from 'react'

type Progress = { phase: EngineInstallPhase; percent: number }
type Cached = { installing: boolean; progress: Progress | null; installed: boolean | null }

export type EngineInstallState = {
  /** null ONLY on the very first check of the session, before status resolves. */
  installed: boolean | null
  installing: boolean
  progress: Progress | null
  error: string | null
  install: () => void
}

// Main owns the real install state; these module-level snapshots mirror it so a
// panel remounted after navigation paints its real state INSTANTLY — including
// the installed flag, so the Install/Reinstall button no longer flashes through
// a "checking"/"Install" state before the async status check resolves. Registered
// once at import and never torn down — the same pattern UpdatesPanel uses.
const cache: Record<'tts' | 'stt', Cached> = {
  tts: { installing: false, progress: null, installed: null },
  stt: { installing: false, progress: null, installed: null }
}

function startMirror(kind: 'tts' | 'stt'): void {
  window.api[kind].onInstallProgress((evt) => {
    if (evt.phase === 'done') {
      cache[kind] = { ...cache[kind], installing: false, progress: null }
      // Refresh the cached installed flag even with no panel mounted, so the
      // next remount shows the correct button with no flash.
      void window.api[kind].installStatus().then((s) => {
        cache[kind] = { ...cache[kind], installed: s.installed }
      })
    } else {
      cache[kind] = { ...cache[kind], installing: true, progress: evt }
    }
  })
}
startMirror('tts')
startMirror('stt')

/**
 * Drives the manual install + readiness state for a local voice engine
 * (Kokoro TTS or faster-whisper STT). The install runs in the main process and
 * keeps going regardless of the UI, so this hook treats main as the source of
 * truth: it seeds instantly from the module cache (installing, progress AND
 * installed), recovers authoritative in-flight progress via getInstallState() on
 * every (re)mount, and streams live updates while mounted. Navigating away and
 * back — or even reloading the renderer — neither resets a running install nor
 * flashes the button.
 */
export function useEngineInstall(kind: 'tts' | 'stt'): EngineInstallState {
  const [installed, setInstalled] = useState<boolean | null>(cache[kind].installed)
  const [installing, setInstalling] = useState(cache[kind].installing)
  const [progress, setProgress] = useState<Progress | null>(cache[kind].progress)
  const [error, setError] = useState<string | null>(null)
  // Flipped once a live progress event lands, so the async getInstallState seed
  // never clobbers fresher state.
  const liveSeen = useRef(false)

  // Set `installed` in both React state and the module cache so a later remount
  // seeds the correct button state with no flash.
  const applyInstalled = useCallback(
    (value: boolean) => {
      cache[kind].installed = value
      setInstalled(value)
    },
    [kind]
  )

  useEffect(() => {
    let cancelled = false
    liveSeen.current = false

    // Reconcile in-flight progress with main (authoritative; survives a full
    // renderer reload, since main keeps the install running and broadcasts to
    // every window). We do NOT seed `error` here: a stale failure from a
    // much-earlier attempt shouldn't reappear on a later remount.
    void window.api[kind].getInstallState().then((s) => {
      if (cancelled || liveSeen.current) return
      setInstalling(s.installing)
      setProgress(s.progress)
      cache[kind] = { ...cache[kind], installing: s.installing, progress: s.progress }
    })
    void window.api[kind]
      .installStatus()
      .then((s) => {
        if (!cancelled) applyInstalled(s.installed)
      })
      .catch(() => {
        if (!cancelled) applyInstalled(false)
      })

    // Live stream while mounted.
    const unsubscribe = window.api[kind].onInstallProgress((evt) => {
      if (cancelled) return
      liveSeen.current = true
      if (evt.phase === 'done') {
        // Resolve status FIRST, then flip installing→false and installed
        // together, so the card never flashes a transient "Not installed"
        // between clearing the bar and the status check resolving.
        void window.api[kind].installStatus().then((s) => {
          if (cancelled) return
          applyInstalled(s.installed)
          setInstalling(false)
          setProgress(null)
        })
      } else {
        setInstalling(true)
        setProgress(evt)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [kind, applyInstalled])

  const install = useCallback(() => {
    setError(null)
    setInstalling(true)
    setProgress({ phase: 'python', percent: 0 })
    cache[kind] = { ...cache[kind], installing: true, progress: { phase: 'python', percent: 0 } }
    // The install() promise resolves in main even if this component unmounts
    // mid-flight; its .then/.finally update the module cache so a later remount
    // is correct. Status re-checks reconcile partial installs.
    void window.api[kind]
      .install()
      .then(async (res) => {
        if (res.ok) {
          applyInstalled(true)
        } else {
          setError(res.error)
          const s = await window.api[kind].installStatus().catch(() => ({ installed: false }))
          applyInstalled(s.installed)
        }
      })
      .catch(async (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
        const s = await window.api[kind].installStatus().catch(() => ({ installed: false }))
        applyInstalled(s.installed)
      })
      .finally(() => {
        setInstalling(false)
        setProgress(null)
        cache[kind] = { ...cache[kind], installing: false, progress: null }
      })
  }, [kind, applyInstalled])

  return { installed, installing, progress, error, install }
}
