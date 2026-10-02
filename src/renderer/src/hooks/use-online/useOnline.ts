import { useEffect, useState } from 'react'

/** Tracks `navigator.onLine` via the `online`/`offline` window events. */
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() => navigator.onLine)
  useEffect(() => {
    const on = (): void => setOnline(true)
    const off = (): void => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}
