import type { WolffishApi } from '@preload/index'

declare global {
  interface Window {
    api: WolffishApi
  }
}

export {}
