import { useEffect, useMemo, useState } from 'react'
import {
  FaApple,
  FaBook,
  FaCheck,
  FaCopy,
  FaGithub,
  FaLinux,
  FaScaleBalanced,
  FaTag,
  FaTerminal,
  FaWindows
} from 'react-icons/fa6'
import type { IconType } from 'react-icons'
import icon from './assets/icon.png'
import { initialLocale, saveLocale, translator, type Locale } from './i18n'
import {
  ALL_RELEASES_URL,
  DOCS_URL,
  fetchLatestRelease,
  INSTALL_PS1,
  INSTALL_SH,
  LICENSE_URL,
  RELEASES_URL,
  REPO_URL,
  type Release
} from './release'

type OS = 'macos' | 'windows' | 'linux'

function clientOS(): OS | null {
  const ua = navigator.userAgent
  if (/Android|iPhone|iPad/.test(ua)) return null
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos'
  if (/Windows/.test(ua)) return 'windows'
  if (/Linux/.test(ua)) return 'linux'
  return null
}

const USER_OS = clientOS()

const LINUX_FORMATS = [
  { key: 'deb', label: '.deb' },
  { key: 'rpm', label: '.rpm' },
  { key: 'appimage', label: '.AppImage' }
] as const

const DOWNLOADS: { os: OS; Icon: IconType }[] = [
  { os: 'macos', Icon: FaApple },
  { os: 'windows', Icon: FaWindows },
  { os: 'linux', Icon: FaLinux }
]

const stripExt = (filename: string): string => filename.replace(/\.(AppImage|deb|rpm)$/, '')

export default function App(): React.JSX.Element {
  const [locale, setLocale] = useState<Locale>(initialLocale)
  const t = useMemo(() => translator(locale), [locale])
  const release = useLatestRelease()

  useEffect(() => {
    const root = document.documentElement
    root.lang = locale
    root.dir = locale === 'ar' ? 'rtl' : 'ltr'
    document.title = t('meta.title')
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', t('meta.description'))
  }, [locale, t])

  const switchLocale = (): void => {
    const next = locale === 'en' ? 'ar' : 'en'
    saveLocale(next)
    setLocale(next)
  }

  const footerLinks = [
    { href: REPO_URL, Icon: FaGithub, label: t('footer.github') },
    { href: ALL_RELEASES_URL, Icon: FaTag, label: t('footer.releases') },
    { href: DOCS_URL, Icon: FaBook, label: t('footer.docs') },
    { href: LICENSE_URL, Icon: FaScaleBalanced, label: t('footer.license') }
  ]

  return (
    <div className="relative z-10 min-h-screen flex flex-col pointer-events-none">
      <div className="fixed top-5 inset-e-6 pointer-events-auto z-20">
        <button
          onClick={switchLocale}
          className="px-3 py-1.5 text-xs font-medium rounded-full bg-white/5 border border-white/10 text-white/80 hover:bg-white/10 hover:text-white transition-all backdrop-blur-sm cursor-pointer"
        >
          {locale === 'en' ? 'عربي' : 'EN'}
        </button>
      </div>

      <main className="flex-1 flex flex-col items-center justify-center px-6 py-16 md:py-0">
        <div className="flex items-center gap-2.5 md:gap-4">
          <img
            src={icon}
            alt=""
            width={96}
            height={96}
            className="w-12 h-12 md:w-16 md:h-16 drop-shadow-[0_0_40px_rgba(40,80,180,0.4)]"
          />
          <h1
            className="text-4xl md:text-7xl font-bold text-white tracking-tight"
            style={{ textShadow: '0 0 80px rgba(40,80,180,0.3), 0 2px 30px rgba(0,0,0,0.5)' }}
          >
            {t('hero.name')}
          </h1>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="pointer-events-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/4 border border-white/6 hover:bg-white/10 transition-colors self-center"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] text-white/60 font-medium" dir="ltr">
              {release ? `v${release.version}` : t('hero.version')}
            </span>
          </a>
        </div>

        <p className="mt-4 text-sm md:text-lg text-white/80 font-light tracking-wide text-center">
          {t('hero.tagline')}
        </p>

        <p className="mt-2 text-xs md:text-[13px] text-white/50 max-w-xl text-center leading-relaxed">
          {t('hero.subtitle')}
        </p>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-5xl">
          {(['local', 'brain', 'extensible'] as const).map((key) => (
            <div
              key={key}
              className="backdrop-blur-md bg-white/5 border border-white/8 rounded-2xl px-5 py-4 text-center"
            >
              <div className="text-[11px] font-semibold text-white/90 mb-1.5">
                {t(`features.${key}`)}
              </div>
              <div className="text-[11px] text-white/50 leading-relaxed">
                {t(`features.${key}Desc`)}
              </div>
            </div>
          ))}
        </div>

        <InstallCommands t={t} />

        <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4 w-full max-w-5xl pointer-events-auto">
          {DOWNLOADS.map(({ os, Icon }) => (
            <DownloadCard key={os} os={os} Icon={Icon} release={release} t={t} />
          ))}
        </div>
      </main>

      <footer className="pb-5 pt-8 flex justify-center">
        <div className="grid grid-cols-2 justify-items-center gap-x-6 gap-y-3 sm:flex sm:items-center sm:gap-6 text-xs text-white/40 pointer-events-auto">
          {footerLinks.map(({ href, Icon, label }) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 hover:text-white/70 transition-colors"
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </a>
          ))}
        </div>
      </footer>
    </div>
  )
}

// The build bakes in the release that was latest at deploy time; the live lookup replaces it
// so a release published after the last deploy shows up without a rebuild.
function useLatestRelease(): Release | null {
  const [release, setRelease] = useState<Release | null>(__RELEASE__)
  useEffect(() => {
    let cancelled = false
    fetchLatestRelease()
      .then((latest) => {
        if (latest && !cancelled) setRelease(latest)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return release
}

type T = ReturnType<typeof translator>

function DownloadCard({
  os,
  Icon,
  release,
  t
}: {
  os: OS
  Icon: IconType
  release: Release | null
  t: T
}): React.JSX.Element {
  const match = USER_OS === os
  const dimmed = USER_OS !== null && !match

  const badge = match && (
    <span className="absolute top-2.5 inset-e-2.5 flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/30">
      <span className="w-1 h-1 rounded-full bg-emerald-400" />
      <span className="text-[8px] text-emerald-300 font-medium">{t('download.compatible')}</span>
    </span>
  )
  const label = (
    <div className="text-[10px] text-white/40 uppercase tracking-wider font-medium">
      {t(`download.${os}`)}
    </div>
  )

  // Linux ships three installers, so the card itself isn't a link; each format is.
  if (os === 'linux') {
    const linux = release?.files.linux
    const name = stripExt(
      (linux?.appimage ?? linux?.deb ?? linux?.rpm)?.filename ?? t('download.linuxFile')
    )
    return (
      <div
        className={`relative flex items-center gap-3 px-5 py-3.5 rounded-2xl backdrop-blur-md transition-all ${
          dimmed
            ? 'bg-white/3 border border-white/5 opacity-50'
            : 'bg-white/6 border border-white/8'
        }`}
      >
        {badge}
        <Icon className={`w-5 h-5 shrink-0 ${dimmed ? 'text-white/30' : 'text-white/50'}`} />
        <div className="text-start min-w-0">
          {label}
          <div className="text-xs text-white font-medium mt-0.5 truncate" dir="ltr">
            {name}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {LINUX_FORMATS.map(({ key, label }) => (
              <a
                key={key}
                href={linux?.[key]?.url ?? RELEASES_URL}
                dir="ltr"
                className="px-2 py-0.5 rounded-md text-[10px] leading-none font-medium bg-white/8 border border-white/10 text-white/70 hover:bg-white/16 hover:text-white hover:border-white/20 transition-colors"
              >
                {label}
              </a>
            ))}
          </div>
        </div>
      </div>
    )
  }

  const file = release?.files[os]
  return (
    <a
      href={file?.url ?? RELEASES_URL}
      className={`group relative flex items-center gap-3 px-5 py-3.5 rounded-2xl backdrop-blur-md transition-all ${
        dimmed
          ? 'bg-white/3 border border-white/5 opacity-50 hover:opacity-80 hover:bg-white/6'
          : 'bg-white/6 border border-white/8 hover:bg-white/12 hover:border-white/18'
      }`}
    >
      {badge}
      <Icon
        className={`w-5 h-5 shrink-0 transition-colors ${dimmed ? 'text-white/30' : 'text-white/50 group-hover:text-white'}`}
      />
      <div className="text-start min-w-0">
        {label}
        <div className="text-xs text-white font-medium mt-0.5 truncate" dir="ltr">
          {file?.filename ?? t(`download.${os}File`)}
        </div>
      </div>
    </a>
  )
}

function InstallCommands({ t }: { t: T }): React.JSX.Element {
  const platforms = {
    macos: t('download.macos'),
    windows: t('download.windows'),
    linux: t('download.linux')
  }
  const commands = [
    { label: t('install.shell', platforms), command: INSTALL_SH, Icon: FaTerminal },
    { label: t('install.powershell', platforms), command: INSTALL_PS1, Icon: FaWindows }
  ]

  return (
    <div
      dir="ltr"
      className="mt-6 w-full max-w-5xl pointer-events-auto rounded-2xl backdrop-blur-md bg-white/4 border border-white/8 px-4 py-3 font-mono divide-y divide-white/8"
    >
      {commands.map(({ label, command, Icon }) => (
        <div key={command} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
          <Icon className="w-3.5 h-3.5 text-white/30 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] text-emerald-400/60 mb-0.5"># {label}</div>
            <code className="text-[11px] text-white/80 block truncate">{command}</code>
          </div>
          <CopyButton text={command} label={t('install.copy')} />
        </div>
      ))}
    </div>
  )
}

function CopyButton({ text, label }: { text: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      },
      () => {}
    )
  }

  return (
    <button
      onClick={copy}
      className="shrink-0 p-2 rounded-lg hover:bg-white/10 transition-colors cursor-pointer"
      aria-label={label}
      title={label}
    >
      {copied ? (
        <FaCheck className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <FaCopy className="w-3.5 h-3.5 text-white/40 hover:text-white/70" />
      )}
    </button>
  )
}
