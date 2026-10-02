/**
 * The library: projects, procedures, automations (with live run state),
 * and background tasks. Browsing and the common verbs are native; editing
 * bodies and attaching files hand off to the classic flows.
 */
import { createSignal, onMount, type JSX } from 'solid-js'
import { useApp } from '../context'
import { duration, plural, relativeTime, truncate } from '../format'
import { ask, confirm, DialogSelect } from '../ui/Dialog'
import { runClassic } from './classic'

type Project = {
  id: string
  title: string
  icon?: string
  description?: string
  files?: unknown[]
  workingFolders?: string[]
}

export function ProjectsDialog(): JSX.Element {
  const app = useApp()
  const [rows, setRows] = createSignal<Project[]>([])
  const [loading, setLoading] = createSignal(true)
  const reload = () =>
    app.client
      .invoke<Project[]>('projects:list')
      .then(setRows)
      .catch((e) => app.toast.error(e))
      .finally(() => setLoading(false))
  onMount(() => {
    app.dialog.setSize('large')
    void reload()
  })
  return (
    <DialogSelect
      title="Projects"
      options={rows().map((p) => ({
        title: `${p.icon ? p.icon + ' ' : ''}${p.title}`,
        value: p.id,
        description: p.description ? truncate(p.description, 48) : undefined,
        footer: `${plural((p.files ?? []).length, 'file')}${p.workingFolders?.length ? ' · ' + plural(p.workingFolders.length, 'folder') : ''}`
      }))}
      loading={loading()}
      emptyText="No projects — /project new <title>"
      onSelect={(o) => {
        app.dialog.clear()
        const hit = rows().find((p) => p.id === o.value)
        app.actions.setProject(o.value, hit?.title ?? null)
        app.toast.success(`project: ${hit?.title}`)
      }}
      actions={[
        {
          key: 'session_rename',
          title: 'edit',
          onTrigger: (o) => void runClassic(app, 'projects', ['edit', o.value])
        },
        {
          key: 'attach_file',
          title: 'files',
          onTrigger: (o) => void runClassic(app, 'projects', ['files', o.value])
        },
        {
          key: 'dialog_delete',
          title: 'delete',
          confirm: 'press delete again to confirm',
          onTrigger: (o) => {
            void app.client
              .invoke('projects:delete', o.value)
              .then(reload)
              .catch((e) => app.toast.error(e))
          }
        }
      ]}
      hints={['enter bind to this chat']}
    />
  )
}

type Procedure = {
  id: string
  title: string
  icon?: string
  prompt?: string
  mode?: string
  projectId?: string
}

export function ProceduresDialog(): JSX.Element {
  const app = useApp()
  const [rows, setRows] = createSignal<Procedure[]>([])
  const [loading, setLoading] = createSignal(true)
  const reload = () =>
    app.client
      .invoke<Procedure[]>('procedures:list')
      .then(setRows)
      .catch((e) => app.toast.error(e))
      .finally(() => setLoading(false))
  onMount(() => {
    app.dialog.setSize('large')
    void reload()
  })
  return (
    <DialogSelect
      title="Procedures"
      options={rows().map((p) => ({
        title: `${p.icon ? p.icon + ' ' : ''}${p.title}`,
        value: p.id,
        description: p.prompt ? truncate(p.prompt.replace(/\s+/g, ' '), 50) : undefined,
        footer: p.mode ?? undefined
      }))}
      loading={loading()}
      emptyText="No procedures — /procedures new"
      onSelect={(o) => {
        void (async () => {
          const hit = rows().find((p) => p.id === o.value)
          if (!hit) return
          const ok = await confirm(app, {
            title: 'Run procedure',
            message: `Run "${hit.title}" in a new conversation?`,
            confirmLabel: 'run'
          })
          if (!ok) return
          app.actions.newConversation()
          await app.actions.send(hit.prompt ?? hit.title, {})
        })()
      }}
      actions={[
        {
          key: 'session_rename',
          title: 'edit',
          onTrigger: (o) => void runClassic(app, 'procedures', ['edit', o.value])
        },
        {
          key: 'attach_file',
          title: 'files',
          onTrigger: (o) => void runClassic(app, 'procedures', ['files', o.value])
        },
        {
          key: 'dialog_delete',
          title: 'delete',
          confirm: 'press delete again to confirm',
          onTrigger: (o) =>
            void app.client
              .invoke('procedures:delete', o.value)
              .then(reload)
              .catch((e) => app.toast.error(e))
        }
      ]}
      hints={['enter run']}
    />
  )
}

type Job = {
  id?: string
  label: string
  schedule?: string
  cron?: string | null
  nextRunMs?: number | null
  prompt?: string
  enabled?: boolean
}
type Runs = {
  running: Array<{ id?: string; label?: string; startedAt?: number }>
  queued: Array<{ id?: string; label?: string }>
}

export function AutomationsDialog(): JSX.Element {
  const app = useApp()
  const [rows, setRows] = createSignal<Job[]>([])
  const [runs, setRuns] = createSignal<Runs>({ running: [], queued: [] })
  const [loading, setLoading] = createSignal(true)
  const reload = async () => {
    const [jobs, live] = await Promise.all([
      app.client.invoke<Job[] | { jobs: Job[] }>('heartbeat:getJobs').catch(() => []),
      app.client.invoke<Runs>('heartbeat:getRuns').catch(() => ({ running: [], queued: [] }))
    ])
    setRows(Array.isArray(jobs) ? jobs : (jobs?.jobs ?? []))
    setRuns(live ?? { running: [], queued: [] })
    setLoading(false)
  }
  onMount(() => {
    app.dialog.setSize('large')
    void reload()
  })
  const state = (job: Job) => {
    const key = job.label
    if (runs().running.some((r) => r.label === key || r.id === job.id)) return '● running'
    if (runs().queued.some((r) => r.label === key || r.id === job.id)) return '○ queued'
    return ''
  }
  return (
    <DialogSelect
      title="Automations"
      options={rows().map((job) => ({
        title: job.label,
        value: job.label,
        description: state(job) || (job.enabled === false ? 'off' : undefined),
        footer:
          typeof job.nextRunMs === 'number'
            ? `next in ${duration(job.nextRunMs)}`
            : (job.cron ?? job.schedule ?? ''),
        details: job.prompt ? [truncate(job.prompt.replace(/\s+/g, ' '), 76)] : undefined
      }))}
      loading={loading()}
      emptyText="No automations — /automations edit"
      onSelect={(o) => {
        void (async () => {
          const ok = await confirm(app, {
            title: 'Run automation',
            message: `Run "${o.value}" now?`,
            confirmLabel: 'run'
          })
          if (!ok) return
          await app.client.invoke('heartbeat:runJob', o.value).catch((e) => app.toast.error(e))
          app.toast.success(`queued ${o.value}`)
        })()
      }}
      actions={[
        {
          key: 'session_rename',
          title: 'edit',
          onTrigger: (o) => void runClassic(app, 'automations', ['edit', o.value])
        },
        {
          key: 'attach_file',
          title: 'files',
          onTrigger: (o) => void runClassic(app, 'automations', ['files', o.value])
        },
        {
          key: 'dialog_delete',
          title: 'delete',
          confirm: 'press delete again to confirm',
          onTrigger: (o) => void runClassic(app, 'automations', ['rm', o.value]).then(reload)
        }
      ]}
      hints={['enter run now', `${runs().running.length} running · ${runs().queued.length} queued`]}
    />
  )
}

export function RunsDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const [runs, setRuns] = createSignal<Runs>({ running: [], queued: [] })
  onMount(() => {
    void app.client
      .invoke<Runs>('heartbeat:getRuns')
      .then(setRuns)
      .catch(() => undefined)
  })
  const options = () => [
    ...state.runs.map((r) => ({
      title: r.title ?? r.conversationId.slice(0, 8),
      value: `conv:${r.conversationId}`,
      description: r.channel ?? 'app',
      category: 'Conversations',
      footer: r.conversationId === state.conversationId ? 'this one' : undefined
    })),
    ...runs().running.map((r) => ({
      title: r.label ?? r.id ?? 'job',
      value: `job:${r.label ?? r.id}`,
      category: 'Automations running',
      footer: r.startedAt ? relativeTime(r.startedAt) : undefined
    })),
    ...runs().queued.map((r) => ({
      title: r.label ?? r.id ?? 'job',
      value: `queued:${r.label ?? r.id}`,
      category: 'Automations queued'
    }))
  ]
  return (
    <DialogSelect
      title="Running now"
      options={options()}
      emptyText="Nothing is running"
      onSelect={(o) => {
        if (o.value.startsWith('conv:')) {
          app.dialog.clear()
          void app.actions.openConversation(o.value.slice(5))
        }
      }}
      actions={[
        {
          key: 'dialog_delete',
          title: 'stop',
          confirm: 'press again to stop',
          onTrigger: (o) => {
            if (o.value.startsWith('conv:'))
              void app.client
                .invoke('cli:cancel', o.value.slice(5))
                .then(() => app.toast.success('stopping'))
                .catch((e) => app.toast.error(e))
          }
        }
      ]}
      hints={['enter open']}
    />
  )
}

export function TasksDialog(): JSX.Element {
  const app = useApp()
  const [state] = app.store
  const tasks = () => {
    const out: Array<{ id: string; label: string; status: string }> = []
    for (const m of state.feed) {
      if (m.kind !== 'assistant') continue
      for (const part of m.parts) {
        if (part.kind !== 'task') continue
        const s = part.snapshot as Record<string, unknown>
        out.push({
          id: String(s.taskId ?? part.id),
          label: String(s.label ?? s.prompt ?? s.kind ?? 'task'),
          status: String(s.status ?? '')
        })
      }
    }
    return out
  }
  return (
    <DialogSelect
      title="Background tasks"
      options={tasks().map((t) => ({
        title: truncate(t.label, 60),
        value: t.id,
        description: t.status
      }))}
      emptyText="No tasks in this conversation"
      onSelect={() => app.dialog.clear()}
      actions={[
        {
          key: 'dialog_delete',
          title: 'cancel',
          confirm: 'press again to cancel',
          onTrigger: (o) =>
            void app.client
              .invoke('task:cancel', { taskId: o.value })
              .then(() => app.toast.success('cancel requested'))
              .catch((e) => app.toast.error(e))
        }
      ]}
    />
  )
}

export async function newProject(app: ReturnType<typeof useApp>): Promise<void> {
  const title = await ask(app, { title: 'New project', placeholder: 'Title' })
  if (!title) return
  await app.client.invoke('projects:create', { title }).catch((e) => app.toast.error(e))
  app.toast.success(`created ${title}`)
}
