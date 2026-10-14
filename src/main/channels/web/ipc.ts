/**
 * The `web:*` IPC channels — the Web UI's own settings and status, reached
 * from the desktop panel, from the Web UI itself (over its socket) and from
 * the CLI, all through the same handler map.
 *
 * The config that crosses to a renderer is the stored one minus its secrets:
 * the password hash becomes a boolean and the VAPID private key stays home.
 */
import { hashPassword, validatePassword } from '@main/channels/web/auth'
import { regenerateWebUiPassword } from '@main/channels/web/passphrase'
import type {
  HttpsEnableInput,
  HttpsEnableResult,
  WebServer,
  WebUiStatus
} from '@main/channels/web/server'
import { parseNotificationAction, type WebNotificationRecord } from '@main/channels/web/inbox'
import type { PublicShare } from '@main/channels/web/public'
import type { WebSession } from '@main/channels/web/state'
import type { IpcMainInvokeEvent } from 'electron'
import {
  getWebUiConfig,
  setWebUiConfig,
  type WebUiConfig,
  type WebUiConfigPatch
} from '@main/workspace/workspace'

/**
 * What the panel sees — no hash, no private key, and not the passphrase
 * either: that is fetched on demand by `web:revealPassword`, so it is not
 * carried along on every config read.
 */
export type WebUiPublicConfig = Omit<WebUiConfig, 'passwordHash' | 'password' | 'push'> & {
  passwordSet: boolean
  /** True while the password is the generated passphrase, which can be shown. */
  passwordGenerated: boolean
  /**
   * The generated passphrase with every letter a dot and its spaces kept, so
   * the hidden phrase takes exactly the room the revealed one does.
   */
  passwordMask: string | null
}

export function toPublicConfig(config: WebUiConfig): WebUiPublicConfig {
  return {
    enabled: config.enabled,
    port: config.port,
    bind: config.bind,
    https: config.https,
    notifications: config.notifications,
    publicOrigin: config.publicOrigin ?? null,
    verbose: config.verbose,
    passwordSet: typeof config.passwordHash === 'string' && config.passwordHash.length > 0,
    passwordGenerated: typeof config.password === 'string' && config.password.length > 0,
    passwordMask: config.password ? config.password.replace(/\S/g, '•') : null
  }
}

export type WebIpcDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any) => void
  server: WebServer
  broadcast: (channel: string, payload: unknown) => void
  /** Re-evaluate whether the notify_web capability should be registered. */
  syncCapability: () => void
}

export type WebSessionView = Pick<
  WebSession,
  'id' | 'createdAt' | 'lastSeenAt' | 'userAgent' | 'address'
>

/** A public link as the panel and the CLI see it — the token only inside the URL. */
export type WebPublicLinkView = Omit<PublicShare, 'token'> & { url: string }

/** The links without their tokens — the URL is the only place a token travels. */
export async function listPublicViews(server: WebServer): Promise<WebPublicLinkView[]> {
  return (await server.listPublicShares()).map((share) => {
    const { token, ...rest } = share
    void token
    return rest
  })
}

export function registerWebIpc(deps: WebIpcDeps): void {
  const { handle, server, broadcast } = deps

  const announce = async (): Promise<WebUiPublicConfig> => {
    const config = toPublicConfig(await getWebUiConfig())
    broadcast('web:configChange', config)
    deps.syncCapability()
    return config
  }

  handle(
    'web:getConfig',
    async (): Promise<WebUiPublicConfig> => toPublicConfig(await getWebUiConfig())
  )

  handle(
    'web:setConfig',
    async (
      _e,
      patch: WebUiConfigPatch
    ): Promise<{ ok: true; config: WebUiPublicConfig; status: WebUiStatus }> => {
      const safe: WebUiConfigPatch = { ...(patch ?? {}) }
      // Secrets are set through their own channels, never through a patch.
      delete (safe as { passwordHash?: unknown }).passwordHash
      delete (safe as { password?: unknown }).password
      delete (safe as { push?: unknown }).push
      if (safe.enabled === true) {
        const current = await getWebUiConfig()
        if (!current.passwordHash)
          throw new Error(
            'set a master password before enabling the Web UI — wolffish web password regenerate'
          )
      }
      await setWebUiConfig(safe)
      const config = await announce()
      await server.applyConfig()
      return { ok: true, config, status: await server.status() }
    }
  )

  /**
   * The event a call arrives with. Over the socket the server stamps the
   * browser session behind it; from the desktop window there is none.
   */
  type WebInvokeEvent = { sender?: unknown; webSessionId?: string }

  /**
   * A new master password signs every OTHER browser out — the sessions were
   * granted on the old one, but the browser that just typed it stays, or it
   * would never see the result — and the Web UI keeps running (or starts, if
   * it was waiting on a password). A password of the user's own is stored
   * hashed only, so the clear generated passphrase is dropped with it.
   */
  handle(
    'web:setPassword',
    async (
      e: WebInvokeEvent,
      password: string
    ): Promise<{ ok: true; config: WebUiPublicConfig; status: WebUiStatus }> => {
      const invalid = validatePassword(password)
      if (invalid) throw new Error(invalid)
      await setWebUiConfig({ passwordHash: await hashPassword(password), password: null })
      await server.revokeAllSessions({ except: e.webSessionId })
      const config = await announce()
      await server.applyConfig()
      return { ok: true, config, status: await server.status() }
    }
  )

  /** The generated passphrase, or null when the user set a password of their own. */
  handle('web:revealPassword', async (): Promise<{ password: string | null }> => {
    const config = await getWebUiConfig()
    return { password: config.password && config.passwordHash ? config.password : null }
  })

  /** A fresh twelve-word passphrase; like any password change it signs every browser out. */
  handle(
    'web:regeneratePassword',
    async (
      e: WebInvokeEvent
    ): Promise<{
      ok: true
      password: string
      config: WebUiPublicConfig
      status: WebUiStatus
    }> => {
      const password = await regenerateWebUiPassword()
      await server.revokeAllSessions({ except: e.webSessionId })
      const config = await announce()
      await server.applyConfig()
      return { ok: true, password, config, status: await server.status() }
    }
  )

  handle('web:status', (): Promise<WebUiStatus> => server.status())

  handle(
    'web:listSessions',
    async (): Promise<WebSessionView[]> =>
      (await server.listSessions()).map(({ id, createdAt, lastSeenAt, userAgent, address }) => ({
        id,
        createdAt,
        lastSeenAt,
        userAgent,
        address
      }))
  )

  handle('web:revokeSession', async (_e, id: string): Promise<{ ok: true }> => {
    await server.revokeSession(String(id))
    deps.syncCapability()
    return { ok: true }
  })

  handle('web:revokeAllSessions', async (): Promise<{ ok: true }> => {
    await server.revokeAllSessions()
    deps.syncCapability()
    return { ok: true }
  })

  const publicViews = (): Promise<WebPublicLinkView[]> => listPublicViews(server)

  handle('web:listPublic', (): Promise<WebPublicLinkView[]> => publicViews())

  handle('web:revokePublic', async (_e, id: string): Promise<{ ok: true }> => {
    await server.revokePublicShare(String(id))
    broadcast('web:publicChange', await publicViews())
    return { ok: true }
  })

  handle('web:revokeAllPublic', async (): Promise<{ ok: true; revoked: number }> => {
    const revoked = await server.revokeAllPublicShares()
    broadcast('web:publicChange', await publicViews())
    return { ok: true, revoked }
  })

  handle('web:notifications', (): Promise<WebNotificationRecord[]> => server.notifications())

  handle(
    'web:updateNotifications',
    async (_e, action: unknown): Promise<WebNotificationRecord[]> => {
      const parsed = parseNotificationAction(action)
      if (!parsed) throw new Error('unknown notification action')
      return server.updateNotifications(parsed)
    }
  )

  handle('web:testNotification', async () => {
    const result = await server.notify({
      title: 'Wolffish',
      body: 'Notifications from the Web UI are working.',
      phase: 'info',
      urgency: 'normal',
      url: '/',
      conversationId: null
    })
    return result
  })

  handle('web:renewCertificate', async (): Promise<WebUiStatus> => {
    await server.renewCertificate()
    return server.status()
  })

  /**
   * The one button. Everything it decides (mode, ports, identifier) is
   * written to the config by the server itself, so a reconnecting panel
   * reads the same truth the flow is acting on.
   */
  handle(
    'web:httpsEnable',
    async (_e, input: HttpsEnableInput | undefined): Promise<HttpsEnableResult> => {
      const result = await server.enableHttps(input ?? {})
      await announce()
      return result
    }
  )

  handle('web:httpsDisable', async (): Promise<WebUiStatus> => {
    const status = await server.disableHttps()
    await announce()
    return status
  })

  handle('web:restart', async (): Promise<WebUiStatus> => {
    await server.applyConfig()
    return server.status()
  })

  /**
   * The address the internet sees this box at — what a Let's Encrypt
   * certificate has to be issued for. An explicit action, never automatic:
   * it asks a third party, and the panel says which one.
   */
  handle('web:detectPublicIp', async (): Promise<{ ipv4: string | null; ipv6: string | null }> => {
    const ask = async (url: string): Promise<string | null> => {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 6000)
        const res = await fetch(url, { signal: controller.signal })
        clearTimeout(timer)
        if (!res.ok) return null
        const text = (await res.text()).trim()
        return /^[0-9a-fA-F.:]+$/.test(text) ? text : null
      } catch {
        return null
      }
    }
    const [ipv4, ipv6] = await Promise.all([
      ask('https://api4.ipify.org'),
      ask('https://api6.ipify.org')
    ])
    return { ipv4, ipv6: ipv6 && ipv6.includes(':') ? ipv6 : null }
  })
}
