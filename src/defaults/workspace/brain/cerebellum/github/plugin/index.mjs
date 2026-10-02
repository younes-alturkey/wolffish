import { Octokit } from 'octokit'
import fs from 'node:fs/promises'
import path from 'node:path'

let workspaceRoot = null
let cachedOctokit = null
let cachedToken = null

// Read every labeled GitHub connection from config.json. The user can link
// several accounts (each with a user-assigned label like "Personal" or
// "Work"); the model picks one per call via the `connection` param. Tolerates
// the legacy single-token shape so a call right after an update — before
// migrateConnections() rewrites config.json — still resolves.
async function readConnections() {
  if (!workspaceRoot) return []
  try {
    const raw = await fs.readFile(path.join(workspaceRoot, 'config.json'), 'utf8')
    const cfg = JSON.parse(raw)
    const github = cfg?.github
    if (Array.isArray(github?.connections)) {
      return github.connections
        .map((c) => ({
          label: String(c?.label ?? '').trim() || 'Default',
          token: String(c?.token ?? '').trim(),
          login: String(c?.login ?? ''),
          name: String(c?.name ?? '')
        }))
        .filter((c) => c.token)
    }
    // Legacy single-token shape.
    const token = String(github?.token ?? '').trim()
    if (token) {
      return [
        {
          label: String(github?.label ?? '').trim() || 'Default',
          token,
          login: String(github?.login ?? ''),
          name: String(github?.name ?? '')
        }
      ]
    }
    return []
  } catch {
    return []
  }
}

// Resolve which connection a tool call should use. Returns { connection } or
// { error } (a ready-to-return tool failure). Rules: 0 connections → not
// configured; explicit `connection` label → exact (case-insensitive) match or
// an error listing the available labels; no label with exactly one connection
// → use it; no label with several → force the model to disambiguate.
function resolveConnection(connections, args) {
  if (connections.length === 0) {
    return {
      error: {
        success: false,
        error:
          'GitHub is not configured. Go to Settings → Services → GitHub and add a connection (a label plus a Personal Access Token).'
      }
    }
  }
  const wanted = String(args?.connection ?? '').trim()
  if (wanted) {
    const matches = connections.filter((c) => c.label.toLowerCase() === wanted.toLowerCase())
    if (matches.length === 0) {
      const labels = connections.map((c) => `"${c.label}"`).join(', ')
      return {
        error: {
          success: false,
          error: `No GitHub connection labeled "${wanted}". Available connections: ${labels}. Pass one of these labels as \`connection\`.`
        }
      }
    }
    if (matches.length > 1) {
      // Never silently pick one of two same-labeled connections for a write.
      return {
        error: {
          success: false,
          error: `More than one GitHub connection is labeled "${wanted}". Labels must be unique — rename them in Settings → Services → GitHub so this one can be selected unambiguously.`
        }
      }
    }
    return { connection: matches[0] }
  }
  if (connections.length === 1) return { connection: connections[0] }
  const labels = connections.map((c) => `"${c.label}"`).join(', ')
  return {
    error: {
      success: false,
      error: `Multiple GitHub connections are configured: ${labels}. Specify which one to use by passing its label as the \`connection\` parameter.`
    }
  }
}

// Build (or reuse) an Octokit client for the connection selected by `args`.
// Returns { client } or { error }. Cached per token so repeated calls to the
// same connection don't rebuild it.
async function resolveClient(args) {
  const connections = await readConnections()
  const resolved = resolveConnection(connections, args)
  if (resolved.error) return { error: resolved.error }
  const token = resolved.connection.token
  if (cachedOctokit && cachedToken === token) return { client: cachedOctokit }
  cachedOctokit = new Octokit({ auth: token })
  cachedToken = token
  return { client: cachedOctokit }
}

function ok(data) {
  return { success: true, output: typeof data === 'string' ? data : JSON.stringify(data) }
}

function fail(err) {
  const status = err?.status
  const message = err?.response?.data?.message ?? err?.message ?? String(err)
  if (status === 401)
    return {
      success: false,
      error: `GitHub authentication failed (401). Check your token in Settings → Services → GitHub.`
    }
  if (status === 403)
    return {
      success: false,
      error: `GitHub permission denied (403): ${message}. Your token may lack the required scope.`
    }
  if (status === 404)
    return { success: false, error: `GitHub resource not found (404): ${message}` }
  if (status === 422) return { success: false, error: `GitHub validation error (422): ${message}` }
  return { success: false, error: status ? `GitHub API error (${status}): ${message}` : message }
}

function clampPerPage(val) {
  return Math.max(1, Number(val) || 10)
}

// --- Tool handlers ---

async function listRepos(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  try {
    const { data } = await client.rest.repos.listForAuthenticatedUser({
      type: args?.type ?? 'owner',
      sort: args?.sort ?? 'updated',
      per_page: clampPerPage(args?.per_page),
      direction: 'desc'
    })
    const lines = data.map(
      (r) =>
        `${r.full_name} (${r.private ? 'private' : 'public'}) — ${r.description || 'no description'} | default: ${r.default_branch} | pushed: ${r.pushed_at?.slice(0, 10) ?? '?'} | ★${r.stargazers_count}`
    )
    return ok(lines.length > 0 ? lines.join('\n') : 'No repositories found.')
  } catch (e) {
    return fail(e)
  }
}

async function getRepo(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const { data: r } = await client.rest.repos.get({ owner: args.owner, repo: args.repo })
    return ok(
      [
        `${r.full_name} (${r.private ? 'private' : 'public'})`,
        `Description: ${r.description || 'none'}`,
        `Language: ${r.language || 'none'} | License: ${r.license?.spdx_id || 'none'}`,
        `Stars: ${r.stargazers_count} | Forks: ${r.forks_count} | Open issues: ${r.open_issues_count}`,
        `Default branch: ${r.default_branch}`,
        `Topics: ${r.topics?.join(', ') || 'none'}`,
        `Created: ${r.created_at?.slice(0, 10)} | Updated: ${r.updated_at?.slice(0, 10)}`,
        `URL: ${r.html_url}`
      ].join('\n')
    )
  } catch (e) {
    return fail(e)
  }
}

async function createRepo(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.name) return { success: false, error: 'name is required' }
  try {
    const { data: r } = await client.rest.repos.createForAuthenticatedUser({
      name: args.name,
      description: args.description ?? '',
      private: args.private !== false,
      auto_init: args.auto_init ?? false
    })
    return ok(`Created ${r.full_name} (${r.private ? 'private' : 'public'})\nURL: ${r.html_url}`)
  } catch (e) {
    return fail(e)
  }
}

async function listIssues(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const params = {
      owner: args.owner,
      repo: args.repo,
      state: args.state ?? 'open',
      per_page: clampPerPage(args?.per_page)
    }
    if (args?.labels) params.labels = args.labels
    if (args?.assignee) params.assignee = args.assignee
    const { data } = await client.rest.issues.listForRepo(params)
    const issues = data.filter((i) => !i.pull_request)
    const lines = issues.map(
      (i) =>
        `#${i.number}: ${i.title} (${i.state}) — ${i.labels.map((l) => l.name).join(', ') || 'no labels'} | assignee: ${i.assignee?.login ?? 'none'} | ${i.created_at.slice(0, 10)}`
    )
    return ok(lines.length > 0 ? lines.join('\n') : 'No issues found.')
  } catch (e) {
    return fail(e)
  }
}

async function getIssue(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.issue_number) {
    return { success: false, error: 'owner, repo, and issue_number are required' }
  }
  try {
    const { data: i } = await client.rest.issues.get({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number
    })
    const lines = [
      `#${i.number}: ${i.title} (${i.state})`,
      `Author: @${i.user?.login ?? '?'} | Created: ${i.created_at.slice(0, 10)}`,
      `Labels: ${i.labels.map((l) => (typeof l === 'string' ? l : l.name)).join(', ') || 'none'}`,
      `Assignees: ${i.assignees?.map((a) => '@' + a.login).join(', ') || 'none'}`,
      `URL: ${i.html_url}`,
      '',
      i.body ?? '(no body)'
    ]

    const { data: comments } = await client.rest.issues.listComments({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number,
      per_page: 20
    })
    if (comments.length > 0) {
      lines.push('', `--- ${comments.length} comment(s) ---`)
      for (const c of comments) {
        lines.push(`\n@${c.user?.login ?? '?'} (${c.created_at.slice(0, 10)}):`)
        lines.push(c.body ?? '(empty)')
      }
    }
    return ok(lines.join('\n'))
  } catch (e) {
    return fail(e)
  }
}

async function createIssue(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.title) {
    return { success: false, error: 'owner, repo, and title are required' }
  }
  try {
    const params = { owner: args.owner, repo: args.repo, title: args.title }
    if (args.body) params.body = args.body
    if (args.labels) params.labels = args.labels
    if (args.assignees) params.assignees = args.assignees
    const { data: i } = await client.rest.issues.create(params)
    return ok(`Created issue #${i.number}: ${i.title}\nURL: ${i.html_url}`)
  } catch (e) {
    return fail(e)
  }
}

async function closeIssue(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.issue_number) {
    return { success: false, error: 'owner, repo, and issue_number are required' }
  }
  try {
    const { data: i } = await client.rest.issues.update({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number,
      state: 'closed'
    })
    return ok(`Closed issue #${i.number}: ${i.title}\nURL: ${i.html_url}`)
  } catch (e) {
    return fail(e)
  }
}

async function listPRs(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const params = {
      owner: args.owner,
      repo: args.repo,
      state: args.state ?? 'open',
      per_page: clampPerPage(args?.per_page)
    }
    if (args?.head) params.head = args.head
    if (args?.base) params.base = args.base
    const { data } = await client.rest.pulls.list(params)
    const lines = data.map(
      (pr) =>
        `#${pr.number}: ${pr.title} (${pr.state}${pr.draft ? ', draft' : ''}) — ${pr.head.label} → ${pr.base.ref} | by @${pr.user?.login ?? '?'} | ${pr.created_at.slice(0, 10)}`
    )
    return ok(lines.length > 0 ? lines.join('\n') : 'No pull requests found.')
  } catch (e) {
    return fail(e)
  }
}

async function getPR(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.pull_number) {
    return { success: false, error: 'owner, repo, and pull_number are required' }
  }
  try {
    const { data: pr } = await client.rest.pulls.get({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number
    })
    const { data: reviews } = await client.rest.pulls.listReviews({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number
    })
    const reviewSummary =
      reviews.length > 0
        ? reviews.map((r) => `@${r.user?.login ?? '?'}: ${r.state}`).join(', ')
        : 'no reviews'

    return ok(
      [
        `#${pr.number}: ${pr.title} (${pr.state}${pr.draft ? ', draft' : ''})`,
        `Author: @${pr.user?.login ?? '?'} | Created: ${pr.created_at.slice(0, 10)}`,
        `${pr.head.label} → ${pr.base.ref} | Mergeable: ${pr.mergeable ?? '?'}`,
        `Changed files: ${pr.changed_files} | +${pr.additions} -${pr.deletions}`,
        `Reviews: ${reviewSummary}`,
        `URL: ${pr.html_url}`,
        '',
        pr.body ?? '(no body)'
      ].join('\n')
    )
  } catch (e) {
    return fail(e)
  }
}

async function createPR(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.title || !args?.head || !args?.base) {
    return { success: false, error: 'owner, repo, title, head, and base are required' }
  }
  try {
    const params = {
      owner: args.owner,
      repo: args.repo,
      title: args.title,
      head: args.head,
      base: args.base
    }
    if (args.body) params.body = args.body
    if (args.draft) params.draft = true
    const { data: pr } = await client.rest.pulls.create(params)
    return ok(
      `Created PR #${pr.number}: ${pr.title}\n${pr.head.label} → ${pr.base.ref}\nURL: ${pr.html_url}`
    )
  } catch (e) {
    return fail(e)
  }
}

async function mergePR(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.pull_number) {
    return { success: false, error: 'owner, repo, and pull_number are required' }
  }
  try {
    const { data } = await client.rest.pulls.merge({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number,
      merge_method: args.merge_method ?? 'merge'
    })
    return ok(`Merged PR #${args.pull_number} (${args.merge_method ?? 'merge'})\nSHA: ${data.sha}`)
  } catch (e) {
    return fail(e)
  }
}

async function listBranches(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const { data } = await client.rest.repos.listBranches({
      owner: args.owner,
      repo: args.repo,
      per_page: 30
    })
    const lines = data.map((b) => `${b.name}${b.protected ? ' (protected)' : ''}`)
    return ok(lines.length > 0 ? lines.join('\n') : 'No branches found.')
  } catch (e) {
    return fail(e)
  }
}

async function deleteBranch(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.branch) {
    return { success: false, error: 'owner, repo, and branch are required' }
  }
  try {
    await client.rest.git.deleteRef({
      owner: args.owner,
      repo: args.repo,
      ref: `heads/${args.branch}`
    })
    return ok(`Deleted branch: ${args.branch}`)
  } catch (e) {
    return fail(e)
  }
}

async function getWorkflowRuns(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const params = { owner: args.owner, repo: args.repo, per_page: 10 }
    if (args?.workflow_id) params.workflow_id = args.workflow_id
    if (args?.branch) params.branch = args.branch
    if (args?.status) params.status = args.status
    const { data } = await client.rest.actions.listWorkflowRunsForRepo(params)
    const lines = data.workflow_runs.map(
      (r) =>
        `Run #${r.id}: ${r.name ?? r.workflow_id} (${r.status}${r.conclusion ? '/' + r.conclusion : ''}) — ${r.event} on ${r.head_branch ?? '?'} | ${r.created_at.slice(0, 16).replace('T', ' ')}`
    )
    return ok(lines.length > 0 ? lines.join('\n') : 'No workflow runs found.')
  } catch (e) {
    return fail(e)
  }
}

async function getWorkflowRunLogs(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.run_id) {
    return { success: false, error: 'owner, repo, and run_id are required' }
  }
  try {
    const { data: jobs } = await client.rest.actions.listJobsForWorkflowRun({
      owner: args.owner,
      repo: args.repo,
      run_id: args.run_id
    })
    const lines = []
    for (const job of jobs.jobs) {
      lines.push(`Job: ${job.name} (${job.status}/${job.conclusion ?? 'pending'})`)
      for (const step of job.steps ?? []) {
        const icon = step.conclusion === 'success' ? '✓' : step.conclusion === 'failure' ? '✗' : '○'
        lines.push(`  ${icon} ${step.name} (${step.conclusion ?? step.status})`)
      }
    }
    return ok(lines.length > 0 ? lines.join('\n') : 'No jobs found for this run.')
  } catch (e) {
    return fail(e)
  }
}

async function createRelease(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.tag_name || !args?.name) {
    return { success: false, error: 'owner, repo, tag_name, and name are required' }
  }
  try {
    const params = {
      owner: args.owner,
      repo: args.repo,
      tag_name: args.tag_name,
      name: args.name
    }
    if (args.body) params.body = args.body
    if (args.draft) params.draft = true
    if (args.prerelease) params.prerelease = true
    if (args.target_commitish) params.target_commitish = args.target_commitish
    const { data: r } = await client.rest.repos.createRelease(params)
    return ok(`Created release: ${r.name} (${r.tag_name})\nURL: ${r.html_url}`)
  } catch (e) {
    return fail(e)
  }
}

async function searchCode(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.query) return { success: false, error: 'query is required' }
  try {
    const { data } = await client.rest.search.code({
      q: args.query,
      per_page: clampPerPage(args?.per_page)
    })
    const lines = data.items.map(
      (item) => `${item.repository.full_name}/${item.path} (score: ${item.score.toFixed(1)})`
    )
    return ok(
      lines.length > 0 ? `${data.total_count} result(s):\n${lines.join('\n')}` : 'No results found.'
    )
  } catch (e) {
    return fail(e)
  }
}

async function getFileContent(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.path) {
    return { success: false, error: 'owner, repo, and path are required' }
  }
  try {
    const params = { owner: args.owner, repo: args.repo, path: args.path }
    if (args?.ref) params.ref = args.ref
    const { data } = await client.rest.repos.getContent(params)
    if (Array.isArray(data)) {
      const entries = data.map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('\n')
      return ok(`Directory: ${args.path}\n${entries}`)
    }
    if (data.type !== 'file') {
      return ok(`${args.path} is a ${data.type}, not a file.`)
    }
    const content =
      data.encoding === 'base64'
        ? Buffer.from(data.content, 'base64').toString('utf8')
        : data.content
    const truncated =
      content.length > 50000
        ? content.slice(0, 50000) + '\n\n[truncated — file is ' + content.length + ' chars]'
        : content
    return ok(`File: ${args.path} (${data.size} bytes)\n\n${truncated}`)
  } catch (e) {
    return fail(e)
  }
}

async function listGists(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  try {
    const { data } = await client.rest.gists.list({
      per_page: clampPerPage(args?.per_page)
    })
    const lines = data.map((g) => {
      const files = Object.keys(g.files ?? {}).join(', ')
      return `${g.id}: ${g.description || '(no description)'} | ${g.public ? 'public' : 'private'} | files: ${files} | ${g.created_at.slice(0, 10)}`
    })
    return ok(lines.length > 0 ? lines.join('\n') : 'No gists found.')
  } catch (e) {
    return fail(e)
  }
}

async function createGist(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.files || typeof args.files !== 'object') {
    return { success: false, error: 'files object is required (mapping filename to content)' }
  }
  try {
    const gistFiles = {}
    for (const [name, content] of Object.entries(args.files)) {
      gistFiles[name] = { content: String(content) }
    }
    const { data: g } = await client.rest.gists.create({
      description: args.description ?? '',
      public: args.public ?? false,
      files: gistFiles
    })
    return ok(`Created gist: ${g.id}\nURL: ${g.html_url}`)
  } catch (e) {
    return fail(e)
  }
}

async function deleteRepo(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    await client.rest.repos.delete({ owner: args.owner, repo: args.repo })
    return ok(`Deleted repository: ${args.owner}/${args.repo}`)
  } catch (e) {
    return fail(e)
  }
}

// --- New tool handlers ---

async function listUserOrgs(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  try {
    const { data } = await client.rest.orgs.listForAuthenticatedUser({ per_page: 30 })
    const lines = data.map(
      (o) =>
        `${o.login} — ${o.description || 'no description'} | ${o.url.replace('api.github.com/orgs', 'github.com')}`
    )
    return ok(
      lines.length > 0
        ? lines.join('\n')
        : 'No organizations returned. If you belong to organizations, your token likely needs the "read:org" scope — add it in your GitHub token settings and update it in Settings → Services → GitHub.'
    )
  } catch (e) {
    return fail(e)
  }
}

async function listOrgRepos(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.org) return { success: false, error: 'org is required' }
  try {
    const { data } = await client.rest.repos.listForOrg({
      org: args.org,
      type: args?.type ?? 'all',
      sort: args?.sort ?? 'updated',
      per_page: clampPerPage(args?.per_page),
      direction: 'desc'
    })
    const lines = data.map(
      (r) =>
        `${r.full_name} (${r.private ? 'private' : 'public'}) — ${r.description || 'no description'} | default: ${r.default_branch} | pushed: ${r.pushed_at?.slice(0, 10) ?? '?'} | ★${r.stargazers_count}`
    )
    return ok(lines.length > 0 ? lines.join('\n') : `No repositories found for ${args.org}.`)
  } catch (e) {
    return fail(e)
  }
}

async function getAuthenticatedUser(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  try {
    const { data: u } = await client.rest.users.getAuthenticated()
    return ok(
      [
        `Username: @${u.login}`,
        `Name: ${u.name || 'not set'}`,
        `Email: ${u.email || 'not public'}`,
        `Bio: ${u.bio || 'none'}`,
        `Public repos: ${u.public_repos}`,
        `Followers: ${u.followers} | Following: ${u.following}`,
        `Created: ${u.created_at?.slice(0, 10)}`,
        `URL: ${u.html_url}`
      ].join('\n')
    )
  } catch (e) {
    return fail(e)
  }
}

async function listCollaborators(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const params = {
      owner: args.owner,
      repo: args.repo,
      affiliation: args?.affiliation ?? 'all',
      per_page: clampPerPage(args?.per_page)
    }
    const { data } = await client.rest.repos.listCollaborators(params)
    const lines = data.map((c) => {
      const perms = c.permissions
        ? Object.entries(c.permissions)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(', ')
        : '?'
      return `@${c.login} — role: ${c.role_name ?? '?'} | permissions: ${perms}`
    })
    return ok(lines.length > 0 ? lines.join('\n') : 'No collaborators found.')
  } catch (e) {
    return fail(e)
  }
}

async function addCollaborator(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.username) {
    return { success: false, error: 'owner, repo, and username are required' }
  }
  try {
    const { data } = await client.rest.repos.addCollaborator({
      owner: args.owner,
      repo: args.repo,
      username: args.username,
      permission: args.permission ?? 'push'
    })
    const status = data?.id ? 'Invitation sent' : 'Collaborator added (already had access)'
    return ok(
      `${status}: @${args.username} → ${args.owner}/${args.repo} (${args.permission ?? 'push'})`
    )
  } catch (e) {
    return fail(e)
  }
}

async function removeCollaborator(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.username) {
    return { success: false, error: 'owner, repo, and username are required' }
  }
  try {
    await client.rest.repos.removeCollaborator({
      owner: args.owner,
      repo: args.repo,
      username: args.username
    })
    return ok(`Removed @${args.username} from ${args.owner}/${args.repo}`)
  } catch (e) {
    return fail(e)
  }
}

async function listCommentsOnIssue(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.issue_number) {
    return { success: false, error: 'owner, repo, and issue_number are required' }
  }
  try {
    const { data } = await client.rest.issues.listComments({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number,
      per_page: clampPerPage(args?.per_page)
    })
    const lines = data.map(
      (c) => `@${c.user?.login ?? '?'} (${c.created_at.slice(0, 10)}):\n${c.body ?? '(empty)'}`
    )
    return ok(lines.length > 0 ? lines.join('\n\n') : 'No comments found.')
  } catch (e) {
    return fail(e)
  }
}

async function addComment(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.issue_number || !args?.body) {
    return { success: false, error: 'owner, repo, issue_number, and body are required' }
  }
  try {
    const { data: c } = await client.rest.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number,
      body: args.body
    })
    return ok(`Comment added (ID: ${c.id})\nURL: ${c.html_url}`)
  } catch (e) {
    return fail(e)
  }
}

async function listLabels(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const { data } = await client.rest.issues.listLabelsForRepo({
      owner: args.owner,
      repo: args.repo,
      per_page: clampPerPage(args?.per_page)
    })
    const lines = data.map((l) => `${l.name} (#${l.color}) — ${l.description || 'no description'}`)
    return ok(lines.length > 0 ? lines.join('\n') : 'No labels found.')
  } catch (e) {
    return fail(e)
  }
}

async function createLabel(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.name) {
    return { success: false, error: 'owner, repo, and name are required' }
  }
  try {
    const params = { owner: args.owner, repo: args.repo, name: args.name }
    if (args.color) params.color = args.color
    if (args.description) params.description = args.description
    const { data: l } = await client.rest.issues.createLabel(params)
    return ok(`Created label: ${l.name} (#${l.color})`)
  } catch (e) {
    return fail(e)
  }
}

async function addLabelsToIssue(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.issue_number || !args?.labels) {
    return { success: false, error: 'owner, repo, issue_number, and labels are required' }
  }
  try {
    const { data } = await client.rest.issues.addLabels({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.issue_number,
      labels: args.labels
    })
    const names = data.map((l) => l.name).join(', ')
    return ok(`Labels on #${args.issue_number}: ${names}`)
  } catch (e) {
    return fail(e)
  }
}

async function listMilestones(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const { data } = await client.rest.issues.listMilestones({
      owner: args.owner,
      repo: args.repo,
      state: args?.state ?? 'open',
      per_page: clampPerPage(args?.per_page)
    })
    const lines = data.map(
      (m) =>
        `#${m.number}: ${m.title} (${m.state}) — ${m.description || 'no description'} | due: ${m.due_on?.slice(0, 10) ?? 'none'} | open: ${m.open_issues} closed: ${m.closed_issues}`
    )
    return ok(lines.length > 0 ? lines.join('\n') : 'No milestones found.')
  } catch (e) {
    return fail(e)
  }
}

async function createMilestone(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.title) {
    return { success: false, error: 'owner, repo, and title are required' }
  }
  try {
    const params = { owner: args.owner, repo: args.repo, title: args.title }
    if (args.description) params.description = args.description
    if (args.due_on) params.due_on = args.due_on
    if (args.state) params.state = args.state
    const { data: m } = await client.rest.issues.createMilestone(params)
    return ok(`Created milestone #${m.number}: ${m.title}\nURL: ${m.html_url}`)
  } catch (e) {
    return fail(e)
  }
}

async function listPRReviews(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.pull_number) {
    return { success: false, error: 'owner, repo, and pull_number are required' }
  }
  try {
    const { data } = await client.rest.pulls.listReviews({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number,
      per_page: clampPerPage(args?.per_page)
    })
    const lines = data.map(
      (r) =>
        `@${r.user?.login ?? '?'}: ${r.state} (${r.submitted_at?.slice(0, 10) ?? '?'})${r.body ? '\n  ' + r.body : ''}`
    )
    return ok(lines.length > 0 ? lines.join('\n') : 'No reviews found.')
  } catch (e) {
    return fail(e)
  }
}

async function requestReviewers(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.pull_number || !args?.reviewers) {
    return { success: false, error: 'owner, repo, pull_number, and reviewers are required' }
  }
  try {
    const params = {
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number,
      reviewers: args.reviewers
    }
    if (args.team_reviewers) params.team_reviewers = args.team_reviewers
    await client.rest.pulls.requestReviewers(params)
    const who = [...args.reviewers, ...(args.team_reviewers ?? [])].join(', ')
    return ok(`Requested reviews from: ${who} on PR #${args.pull_number}`)
  } catch (e) {
    return fail(e)
  }
}

async function listPRFiles(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.pull_number) {
    return { success: false, error: 'owner, repo, and pull_number are required' }
  }
  try {
    const { data } = await client.rest.pulls.listFiles({
      owner: args.owner,
      repo: args.repo,
      pull_number: args.pull_number,
      per_page: clampPerPage(args?.per_page)
    })
    const lines = data.map((f) => {
      const stats = `+${f.additions} -${f.deletions}`
      const patch = f.patch ? `\n  ${f.patch.split('\n').slice(0, 5).join('\n  ')}` : ''
      return `${f.filename} (${f.status}) ${stats}${patch}`
    })
    return ok(lines.length > 0 ? lines.join('\n\n') : 'No files changed.')
  } catch (e) {
    return fail(e)
  }
}

async function updatePR(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.pull_number) {
    return { success: false, error: 'owner, repo, and pull_number are required' }
  }
  try {
    const params = { owner: args.owner, repo: args.repo, pull_number: args.pull_number }
    if (args.title !== undefined) params.title = args.title
    if (args.body !== undefined) params.body = args.body
    if (args.state) params.state = args.state
    if (args.base) params.base = args.base
    const { data: pr } = await client.rest.pulls.update(params)
    return ok(`Updated PR #${pr.number}: ${pr.title} (${pr.state})\nURL: ${pr.html_url}`)
  } catch (e) {
    return fail(e)
  }
}

async function listReleases(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const { data } = await client.rest.repos.listReleases({
      owner: args.owner,
      repo: args.repo,
      per_page: clampPerPage(args?.per_page)
    })
    const lines = data.map((r) => {
      const flags = [r.draft ? 'draft' : '', r.prerelease ? 'prerelease' : '']
        .filter(Boolean)
        .join(', ')
      const assets = r.assets?.length ?? 0
      return `${r.tag_name}: ${r.name || '(untitled)'} (${r.published_at?.slice(0, 10) ?? 'unpublished'})${flags ? ' [' + flags + ']' : ''} | ${assets} asset(s)`
    })
    return ok(lines.length > 0 ? lines.join('\n') : 'No releases found.')
  } catch (e) {
    return fail(e)
  }
}

async function getRelease(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  if (!args?.release_id && !args?.tag)
    return { success: false, error: 'release_id or tag is required' }
  try {
    let data
    if (args.tag) {
      ;({ data } = await client.rest.repos.getReleaseByTag({
        owner: args.owner,
        repo: args.repo,
        tag: args.tag
      }))
    } else {
      ;({ data } = await client.rest.repos.getRelease({
        owner: args.owner,
        repo: args.repo,
        release_id: args.release_id
      }))
    }
    const flags = [data.draft ? 'draft' : '', data.prerelease ? 'prerelease' : '']
      .filter(Boolean)
      .join(', ')
    const lines = [
      `${data.tag_name}: ${data.name || '(untitled)'}${flags ? ' [' + flags + ']' : ''}`,
      `Author: @${data.author?.login ?? '?'} | Published: ${data.published_at?.slice(0, 10) ?? 'unpublished'}`,
      `URL: ${data.html_url}`,
      '',
      data.body ?? '(no body)'
    ]
    if (data.assets?.length > 0) {
      lines.push('', `--- ${data.assets.length} asset(s) ---`)
      for (const a of data.assets) {
        lines.push(`${a.name} (${(a.size / 1024).toFixed(1)} KB) — ${a.browser_download_url}`)
      }
    }
    return ok(lines.join('\n'))
  } catch (e) {
    return fail(e)
  }
}

async function listRepoTopics(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const { data } = await client.rest.repos.getAllTopics({
      owner: args.owner,
      repo: args.repo
    })
    return ok(data.names?.length > 0 ? data.names.join(', ') : 'No topics set.')
  } catch (e) {
    return fail(e)
  }
}

async function replaceRepoTopics(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.names) {
    return { success: false, error: 'owner, repo, and names are required' }
  }
  try {
    const { data } = await client.rest.repos.replaceAllTopics({
      owner: args.owner,
      repo: args.repo,
      names: args.names
    })
    return ok(`Topics updated: ${data.names.join(', ') || 'none'}`)
  } catch (e) {
    return fail(e)
  }
}

async function getCommit(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.ref) {
    return { success: false, error: 'owner, repo, and ref are required' }
  }
  try {
    const { data: c } = await client.rest.repos.getCommit({
      owner: args.owner,
      repo: args.repo,
      ref: args.ref
    })
    const lines = [
      `SHA: ${c.sha}`,
      `Author: ${c.commit.author?.name ?? '?'} <${c.commit.author?.email ?? '?'}> (${c.commit.author?.date?.slice(0, 10) ?? '?'})`,
      `Message: ${c.commit.message}`,
      `Stats: +${c.stats?.additions ?? 0} -${c.stats?.deletions ?? 0} in ${c.files?.length ?? 0} file(s)`,
      `URL: ${c.html_url}`
    ]
    if (c.files?.length > 0) {
      lines.push('', '--- Files ---')
      for (const f of c.files.slice(0, 20)) {
        lines.push(`${f.filename} (${f.status}) +${f.additions} -${f.deletions}`)
      }
      if (c.files.length > 20) lines.push(`... and ${c.files.length - 20} more`)
    }
    return ok(lines.join('\n'))
  } catch (e) {
    return fail(e)
  }
}

async function compareCommits(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.base || !args?.head) {
    return { success: false, error: 'owner, repo, base, and head are required' }
  }
  try {
    const { data } = await client.rest.repos.compareCommits({
      owner: args.owner,
      repo: args.repo,
      base: args.base,
      head: args.head
    })
    const lines = [
      `${args.base}...${args.head}`,
      `Status: ${data.status} | Ahead: ${data.ahead_by} | Behind: ${data.behind_by}`,
      `Total commits: ${data.total_commits} | Files changed: ${data.files?.length ?? 0}`,
      `URL: ${data.html_url}`
    ]
    if (data.commits?.length > 0) {
      lines.push('', '--- Commits ---')
      for (const c of data.commits.slice(0, 15)) {
        lines.push(
          `${c.sha.slice(0, 7)}: ${c.commit.message.split('\n')[0]} (@${c.author?.login ?? '?'})`
        )
      }
      if (data.commits.length > 15) lines.push(`... and ${data.commits.length - 15} more`)
    }
    if (data.files?.length > 0) {
      lines.push('', '--- Files ---')
      for (const f of data.files.slice(0, 20)) {
        lines.push(`${f.filename} (${f.status}) +${f.additions} -${f.deletions}`)
      }
      if (data.files.length > 20) lines.push(`... and ${data.files.length - 20} more`)
    }
    return ok(lines.join('\n'))
  } catch (e) {
    return fail(e)
  }
}

async function listNotifications(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  try {
    const params = { per_page: clampPerPage(args?.per_page) }
    if (args?.all) params.all = true
    if (args?.participating) params.participating = true
    const { data } = await client.rest.activity.listNotificationsForAuthenticatedUser(params)
    const lines = data.map(
      (n) =>
        `${n.unread ? '●' : '○'} [${n.subject.type}] ${n.subject.title} — ${n.repository.full_name} | reason: ${n.reason} | ${n.updated_at.slice(0, 16).replace('T', ' ')}`
    )
    return ok(lines.length > 0 ? lines.join('\n') : 'No notifications.')
  } catch (e) {
    return fail(e)
  }
}

async function markNotificationsRead(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  try {
    const params = {}
    if (args?.last_read_at) params.last_read_at = args.last_read_at
    await client.rest.activity.markNotificationsAsRead(params)
    return ok('All notifications marked as read.')
  } catch (e) {
    return fail(e)
  }
}

async function listStargazers(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const { data } = await client.rest.activity.listStargazersForRepo({
      owner: args.owner,
      repo: args.repo,
      per_page: clampPerPage(args?.per_page)
    })
    const lines = data.map((u) => `@${u.login}`)
    return ok(lines.length > 0 ? lines.join('\n') : 'No stargazers.')
  } catch (e) {
    return fail(e)
  }
}

async function starRepo(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    await client.rest.activity.starRepoForAuthenticatedUser({
      owner: args.owner,
      repo: args.repo
    })
    return ok(`Starred ${args.owner}/${args.repo}`)
  } catch (e) {
    return fail(e)
  }
}

async function unstarRepo(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    await client.rest.activity.unstarRepoForAuthenticatedUser({
      owner: args.owner,
      repo: args.repo
    })
    return ok(`Unstarred ${args.owner}/${args.repo}`)
  } catch (e) {
    return fail(e)
  }
}

async function forkRepo(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo) return { success: false, error: 'owner and repo are required' }
  try {
    const params = { owner: args.owner, repo: args.repo }
    if (args.organization) params.organization = args.organization
    const { data: r } = await client.rest.repos.createFork(params)
    return ok(`Forked ${args.owner}/${args.repo} → ${r.full_name}\nURL: ${r.html_url}`)
  } catch (e) {
    return fail(e)
  }
}

async function rerunWorkflow(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.run_id) {
    return { success: false, error: 'owner, repo, and run_id are required' }
  }
  try {
    await client.rest.actions.reRunWorkflow({
      owner: args.owner,
      repo: args.repo,
      run_id: args.run_id
    })
    return ok(`Re-running workflow run #${args.run_id}`)
  } catch (e) {
    return fail(e)
  }
}

async function cancelWorkflowRun(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.run_id) {
    return { success: false, error: 'owner, repo, and run_id are required' }
  }
  try {
    await client.rest.actions.cancelWorkflowRun({
      owner: args.owner,
      repo: args.repo,
      run_id: args.run_id
    })
    return ok(`Cancelled workflow run #${args.run_id}`)
  } catch (e) {
    return fail(e)
  }
}

async function dispatchWorkflow(args) {
  const { client, error } = await resolveClient(args)
  if (error) return error
  if (!args?.owner || !args?.repo || !args?.workflow_id || !args?.ref) {
    return { success: false, error: 'owner, repo, workflow_id, and ref are required' }
  }
  try {
    const params = {
      owner: args.owner,
      repo: args.repo,
      workflow_id: args.workflow_id,
      ref: args.ref
    }
    if (args.inputs) params.inputs = args.inputs
    await client.rest.actions.createWorkflowDispatch(params)
    return ok(`Dispatched workflow ${args.workflow_id} on ${args.ref}`)
  } catch (e) {
    return fail(e)
  }
}

async function listConnections() {
  const connections = await readConnections()
  const payload = {
    connections: connections.map((c) => ({
      label: c.label,
      login: c.login || null,
      name: c.name || null
    })),
    note:
      connections.length === 0
        ? 'No GitHub connections are configured. Ask the user to add one in Settings → Services → GitHub (each has a label and a Personal Access Token).'
        : 'Each connection is one GitHub account the user linked, identified by a user-assigned label (e.g. "Personal", "Work"). Pass the matching label as the `connection` parameter on every github_* tool call. You may omit it only when exactly one connection exists. Match the label to the user\'s intent — e.g. "my work github" → the connection labeled "Work".'
  }
  return ok(payload)
}

// --- Tool map ---

const TOOL_MAP = {
  github_connections: listConnections,
  github_list_repos: listRepos,
  github_get_repo: getRepo,
  github_create_repo: createRepo,
  github_list_issues: listIssues,
  github_get_issue: getIssue,
  github_create_issue: createIssue,
  github_close_issue: closeIssue,
  github_list_prs: listPRs,
  github_get_pr: getPR,
  github_create_pr: createPR,
  github_merge_pr: mergePR,
  github_list_branches: listBranches,
  github_delete_branch: deleteBranch,
  github_get_workflow_runs: getWorkflowRuns,
  github_get_workflow_run_logs: getWorkflowRunLogs,
  github_create_release: createRelease,
  github_search_code: searchCode,
  github_get_file_content: getFileContent,
  github_list_gists: listGists,
  github_create_gist: createGist,
  github_delete_repo: deleteRepo,
  github_list_user_orgs: listUserOrgs,
  github_list_org_repos: listOrgRepos,
  github_get_authenticated_user: getAuthenticatedUser,
  github_list_collaborators: listCollaborators,
  github_add_collaborator: addCollaborator,
  github_remove_collaborator: removeCollaborator,
  github_list_comments_on_issue: listCommentsOnIssue,
  github_add_comment: addComment,
  github_list_labels: listLabels,
  github_create_label: createLabel,
  github_add_labels_to_issue: addLabelsToIssue,
  github_list_milestones: listMilestones,
  github_create_milestone: createMilestone,
  github_list_pr_reviews: listPRReviews,
  github_request_reviewers: requestReviewers,
  github_list_pr_files: listPRFiles,
  github_update_pr: updatePR,
  github_list_releases: listReleases,
  github_get_release: getRelease,
  github_list_repo_topics: listRepoTopics,
  github_replace_repo_topics: replaceRepoTopics,
  github_get_commit: getCommit,
  github_compare_commits: compareCommits,
  github_list_notifications: listNotifications,
  github_mark_notifications_read: markNotificationsRead,
  github_list_stargazers: listStargazers,
  github_star_repo: starRepo,
  github_unstar_repo: unstarRepo,
  github_fork_repo: forkRepo,
  github_rerun_workflow: rerunWorkflow,
  github_cancel_workflow_run: cancelWorkflowRun,
  github_dispatch_workflow: dispatchWorkflow
}

// --- Tool definitions for WolffishPlugin interface ---

const CONNECTION_PARAM = {
  type: 'string',
  description:
    'Which linked GitHub connection (account) to use, by its user-assigned label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list labels.'
}

const toolDefinitions = [
  {
    name: 'github_connections',
    description:
      'List the configured GitHub connections (their labels and connected account) so you know which `connection` to pass on other github_* tools. Does not expose tokens.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'github_list_repos',
    description: "List the authenticated user's repositories.",
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        type: { type: 'string' },
        sort: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: []
    }
  },
  {
    name: 'github_get_repo',
    description: 'Get details for a specific repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_create_repo',
    description: 'Create a new repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        auto_init: { type: 'boolean' }
      },
      required: ['name']
    }
  },
  {
    name: 'github_list_issues',
    description: 'List issues for a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
        labels: { type: 'string' },
        assignee: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_get_issue',
    description: 'Get a single issue with full body and comments.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'number' }
      },
      required: ['owner', 'repo', 'issue_number']
    }
  },
  {
    name: 'github_create_issue',
    description: 'Create a new issue.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        labels: { type: 'array' },
        assignees: { type: 'array' }
      },
      required: ['owner', 'repo', 'title']
    }
  },
  {
    name: 'github_close_issue',
    description: 'Close an issue.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'number' }
      },
      required: ['owner', 'repo', 'issue_number']
    }
  },
  {
    name: 'github_list_prs',
    description: 'List pull requests.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_get_pr',
    description: 'Get a single pull request with diff stats and reviews.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' }
      },
      required: ['owner', 'repo', 'pull_number']
    }
  },
  {
    name: 'github_create_pr',
    description: 'Create a pull request.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
        draft: { type: 'boolean' }
      },
      required: ['owner', 'repo', 'title', 'head', 'base']
    }
  },
  {
    name: 'github_merge_pr',
    description: 'Merge a pull request.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
        merge_method: { type: 'string' }
      },
      required: ['owner', 'repo', 'pull_number']
    }
  },
  {
    name: 'github_list_branches',
    description: 'List branches.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_delete_branch',
    description: 'Delete a branch.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' }
      },
      required: ['owner', 'repo', 'branch']
    }
  },
  {
    name: 'github_get_workflow_runs',
    description: 'Get recent CI/Actions workflow runs.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        workflow_id: { type: 'string' },
        branch: { type: 'string' },
        status: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_get_workflow_run_logs',
    description: 'Get logs for a workflow run.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        run_id: { type: 'number' }
      },
      required: ['owner', 'repo', 'run_id']
    }
  },
  {
    name: 'github_create_release',
    description: 'Create a release.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        tag_name: { type: 'string' },
        name: { type: 'string' },
        body: { type: 'string' },
        draft: { type: 'boolean' },
        prerelease: { type: 'boolean' },
        target_commitish: { type: 'string' }
      },
      required: ['owner', 'repo', 'tag_name', 'name']
    }
  },
  {
    name: 'github_search_code',
    description: 'Search code across GitHub.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        query: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: ['query']
    }
  },
  {
    name: 'github_get_file_content',
    description: 'Get file contents from a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        path: { type: 'string' },
        ref: { type: 'string' }
      },
      required: ['owner', 'repo', 'path']
    }
  },
  {
    name: 'github_list_gists',
    description: "List the user's gists.",
    parameters: {
      type: 'object',
      properties: { connection: CONNECTION_PARAM, per_page: { type: 'number' } },
      required: []
    }
  },
  {
    name: 'github_create_gist',
    description: 'Create a gist.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        description: { type: 'string' },
        files: { type: 'object' },
        public: { type: 'boolean' }
      },
      required: ['files']
    }
  },
  {
    name: 'github_delete_repo',
    description: 'Permanently delete a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_list_user_orgs',
    description: 'List organizations the authenticated user belongs to.',
    parameters: { type: 'object', properties: { connection: CONNECTION_PARAM }, required: [] }
  },
  {
    name: 'github_list_org_repos',
    description: 'List repositories for an organization.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        org: { type: 'string' },
        type: { type: 'string' },
        sort: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: ['org']
    }
  },
  {
    name: 'github_get_authenticated_user',
    description: "Get the authenticated user's profile.",
    parameters: { type: 'object', properties: { connection: CONNECTION_PARAM }, required: [] }
  },
  {
    name: 'github_list_collaborators',
    description: 'List collaborators on a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        affiliation: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_add_collaborator',
    description: 'Invite a collaborator to a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        username: { type: 'string' },
        permission: { type: 'string' }
      },
      required: ['owner', 'repo', 'username']
    }
  },
  {
    name: 'github_remove_collaborator',
    description: 'Remove a collaborator from a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        username: { type: 'string' }
      },
      required: ['owner', 'repo', 'username']
    }
  },
  {
    name: 'github_list_comments_on_issue',
    description: 'List comments on an issue or PR.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'number' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo', 'issue_number']
    }
  },
  {
    name: 'github_add_comment',
    description: 'Add a comment to an issue or PR.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'number' },
        body: { type: 'string' }
      },
      required: ['owner', 'repo', 'issue_number', 'body']
    }
  },
  {
    name: 'github_list_labels',
    description: 'List labels for a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_create_label',
    description: 'Create a label in a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        name: { type: 'string' },
        color: { type: 'string' },
        description: { type: 'string' }
      },
      required: ['owner', 'repo', 'name']
    }
  },
  {
    name: 'github_add_labels_to_issue',
    description: 'Add labels to an issue or PR.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        issue_number: { type: 'number' },
        labels: { type: 'array' }
      },
      required: ['owner', 'repo', 'issue_number', 'labels']
    }
  },
  {
    name: 'github_list_milestones',
    description: 'List milestones for a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_create_milestone',
    description: 'Create a milestone in a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        due_on: { type: 'string' },
        state: { type: 'string' }
      },
      required: ['owner', 'repo', 'title']
    }
  },
  {
    name: 'github_list_pr_reviews',
    description: 'List reviews on a pull request.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo', 'pull_number']
    }
  },
  {
    name: 'github_request_reviewers',
    description: 'Request reviewers on a pull request.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
        reviewers: { type: 'array' },
        team_reviewers: { type: 'array' }
      },
      required: ['owner', 'repo', 'pull_number', 'reviewers']
    }
  },
  {
    name: 'github_list_pr_files',
    description: 'List files changed in a pull request.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo', 'pull_number']
    }
  },
  {
    name: 'github_update_pr',
    description: "Update a PR's title, body, state, or base.",
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
        title: { type: 'string' },
        body: { type: 'string' },
        state: { type: 'string' },
        base: { type: 'string' }
      },
      required: ['owner', 'repo', 'pull_number']
    }
  },
  {
    name: 'github_list_releases',
    description: 'List releases for a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_get_release',
    description: 'Get a single release with full body and assets.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        release_id: { type: 'number' },
        tag: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_list_repo_topics',
    description: 'List topics for a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_replace_repo_topics',
    description: 'Replace all topics on a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        names: { type: 'array' }
      },
      required: ['owner', 'repo', 'names']
    }
  },
  {
    name: 'github_get_commit',
    description: 'Get details for a specific commit.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        ref: { type: 'string' }
      },
      required: ['owner', 'repo', 'ref']
    }
  },
  {
    name: 'github_compare_commits',
    description: 'Compare two commits, branches, or tags.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        base: { type: 'string' },
        head: { type: 'string' }
      },
      required: ['owner', 'repo', 'base', 'head']
    }
  },
  {
    name: 'github_list_notifications',
    description: "List the authenticated user's notifications.",
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        all: { type: 'boolean' },
        participating: { type: 'boolean' },
        per_page: { type: 'number' }
      },
      required: []
    }
  },
  {
    name: 'github_mark_notifications_read',
    description: 'Mark all notifications as read.',
    parameters: {
      type: 'object',
      properties: { connection: CONNECTION_PARAM, last_read_at: { type: 'string' } },
      required: []
    }
  },
  {
    name: 'github_list_stargazers',
    description: 'List stargazers for a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        per_page: { type: 'number' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_star_repo',
    description: 'Star a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_unstar_repo',
    description: 'Unstar a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_fork_repo',
    description: 'Fork a repository.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        organization: { type: 'string' }
      },
      required: ['owner', 'repo']
    }
  },
  {
    name: 'github_rerun_workflow',
    description: 'Re-run a workflow run.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        run_id: { type: 'number' }
      },
      required: ['owner', 'repo', 'run_id']
    }
  },
  {
    name: 'github_cancel_workflow_run',
    description: 'Cancel a workflow run.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        run_id: { type: 'number' }
      },
      required: ['owner', 'repo', 'run_id']
    }
  },
  {
    name: 'github_dispatch_workflow',
    description: 'Manually trigger a workflow.',
    parameters: {
      type: 'object',
      properties: {
        connection: CONNECTION_PARAM,
        owner: { type: 'string' },
        repo: { type: 'string' },
        workflow_id: { type: 'string' },
        ref: { type: 'string' },
        inputs: { type: 'object' }
      },
      required: ['owner', 'repo', 'workflow_id', 'ref']
    }
  }
]

// --- Plugin export ---

function describeActionBase(toolName, args) {
  const repo = args?.owner && args?.repo ? `${args.owner}/${args.repo}` : ''
  switch (toolName) {
    case 'github_connections':
      return {
        title: 'List GitHub connections',
        description: 'Listing configured connections',
        risk: 'low'
      }
    case 'github_list_repos':
      return { title: 'List GitHub repos', description: 'Listing your repositories', risk: 'low' }
    case 'github_get_repo':
      return { title: 'Get repo details', description: repo, risk: 'low' }
    case 'github_create_repo':
      return {
        title: 'Create GitHub repo',
        description: `Creating ${args?.name ?? '?'}`,
        risk: 'medium'
      }
    case 'github_list_issues':
      return { title: 'List issues', description: repo, risk: 'low' }
    case 'github_get_issue':
      return {
        title: 'Get issue',
        description: `${repo}#${args?.issue_number ?? '?'}`,
        risk: 'low'
      }
    case 'github_create_issue':
      return {
        title: 'Create issue',
        description: `"${args?.title ?? '?'}" on ${repo}`,
        risk: 'medium'
      }
    case 'github_close_issue':
      return {
        title: 'Close issue',
        description: `${repo}#${args?.issue_number ?? '?'}`,
        risk: 'medium'
      }
    case 'github_list_prs':
      return { title: 'List pull requests', description: repo, risk: 'low' }
    case 'github_get_pr':
      return { title: 'Get PR', description: `${repo}#${args?.pull_number ?? '?'}`, risk: 'low' }
    case 'github_create_pr':
      return {
        title: 'Create PR',
        description: `"${args?.title ?? '?'}" on ${repo}`,
        risk: 'medium'
      }
    case 'github_merge_pr':
      return {
        title: 'Merge PR',
        description: `${repo}#${args?.pull_number ?? '?'} (${args?.merge_method ?? 'merge'})`,
        risk: 'high'
      }
    case 'github_list_branches':
      return { title: 'List branches', description: repo, risk: 'low' }
    case 'github_delete_branch':
      return {
        title: 'Delete branch',
        description: `${args?.branch ?? '?'} on ${repo}`,
        risk: 'high'
      }
    case 'github_get_workflow_runs':
      return { title: 'Get CI runs', description: repo, risk: 'low' }
    case 'github_get_workflow_run_logs':
      return {
        title: 'Get CI logs',
        description: `Run #${args?.run_id ?? '?'} on ${repo}`,
        risk: 'low'
      }
    case 'github_create_release':
      return {
        title: 'Create release',
        description: `${args?.tag_name ?? '?'} on ${repo}`,
        risk: 'high'
      }
    case 'github_search_code':
      return { title: 'Search code', description: `"${args?.query ?? '?'}"`, risk: 'low' }
    case 'github_get_file_content':
      return { title: 'Read file', description: `${repo}/${args?.path ?? '?'}`, risk: 'low' }
    case 'github_list_gists':
      return { title: 'List gists', description: 'Listing your gists', risk: 'low' }
    case 'github_create_gist':
      return { title: 'Create gist', description: args?.description ?? 'new gist', risk: 'medium' }
    case 'github_delete_repo':
      return { title: 'DELETE REPO', description: `⚠️ Permanently deleting ${repo}`, risk: 'high' }
    case 'github_list_user_orgs':
      return { title: 'List user orgs', description: 'Listing your organizations', risk: 'low' }
    case 'github_list_org_repos':
      return { title: 'List org repos', description: args?.org ?? '?', risk: 'low' }
    case 'github_get_authenticated_user':
      return { title: 'Get user profile', description: 'Fetching authenticated user', risk: 'low' }
    case 'github_list_collaborators':
      return { title: 'List collaborators', description: repo, risk: 'low' }
    case 'github_add_collaborator':
      return {
        title: 'Add collaborator',
        description: `@${args?.username ?? '?'} → ${repo}`,
        risk: 'medium'
      }
    case 'github_remove_collaborator':
      return {
        title: 'Remove collaborator',
        description: `@${args?.username ?? '?'} from ${repo}`,
        risk: 'high'
      }
    case 'github_list_comments_on_issue':
      return {
        title: 'List comments',
        description: `${repo}#${args?.issue_number ?? '?'}`,
        risk: 'low'
      }
    case 'github_add_comment':
      return {
        title: 'Add comment',
        description: `${repo}#${args?.issue_number ?? '?'}`,
        risk: 'medium'
      }
    case 'github_list_labels':
      return { title: 'List labels', description: repo, risk: 'low' }
    case 'github_create_label':
      return {
        title: 'Create label',
        description: `"${args?.name ?? '?'}" on ${repo}`,
        risk: 'low'
      }
    case 'github_add_labels_to_issue':
      return {
        title: 'Add labels',
        description: `${repo}#${args?.issue_number ?? '?'}`,
        risk: 'low'
      }
    case 'github_list_milestones':
      return { title: 'List milestones', description: repo, risk: 'low' }
    case 'github_create_milestone':
      return {
        title: 'Create milestone',
        description: `"${args?.title ?? '?'}" on ${repo}`,
        risk: 'low'
      }
    case 'github_list_pr_reviews':
      return {
        title: 'List PR reviews',
        description: `${repo}#${args?.pull_number ?? '?'}`,
        risk: 'low'
      }
    case 'github_request_reviewers':
      return {
        title: 'Request reviewers',
        description: `${repo}#${args?.pull_number ?? '?'}`,
        risk: 'medium'
      }
    case 'github_list_pr_files':
      return {
        title: 'List PR files',
        description: `${repo}#${args?.pull_number ?? '?'}`,
        risk: 'low'
      }
    case 'github_update_pr':
      return {
        title: 'Update PR',
        description: `${repo}#${args?.pull_number ?? '?'}`,
        risk: 'medium'
      }
    case 'github_list_releases':
      return { title: 'List releases', description: repo, risk: 'low' }
    case 'github_get_release':
      return {
        title: 'Get release',
        description: `${args?.tag ?? args?.release_id ?? '?'} on ${repo}`,
        risk: 'low'
      }
    case 'github_list_repo_topics':
      return { title: 'List topics', description: repo, risk: 'low' }
    case 'github_replace_repo_topics':
      return { title: 'Replace topics', description: repo, risk: 'medium' }
    case 'github_get_commit':
      return {
        title: 'Get commit',
        description: `${args?.ref?.slice(0, 7) ?? '?'} on ${repo}`,
        risk: 'low'
      }
    case 'github_compare_commits':
      return {
        title: 'Compare commits',
        description: `${args?.base ?? '?'}...${args?.head ?? '?'} on ${repo}`,
        risk: 'low'
      }
    case 'github_list_notifications':
      return { title: 'List notifications', description: 'Checking notifications', risk: 'low' }
    case 'github_mark_notifications_read':
      return { title: 'Mark notifications read', description: 'Marking all as read', risk: 'low' }
    case 'github_list_stargazers':
      return { title: 'List stargazers', description: repo, risk: 'low' }
    case 'github_star_repo':
      return { title: 'Star repo', description: repo, risk: 'low' }
    case 'github_unstar_repo':
      return { title: 'Unstar repo', description: repo, risk: 'low' }
    case 'github_fork_repo':
      return {
        title: 'Fork repo',
        description: `${repo}${args?.organization ? ' → ' + args.organization : ''}`,
        risk: 'medium'
      }
    case 'github_rerun_workflow':
      return {
        title: 'Re-run workflow',
        description: `Run #${args?.run_id ?? '?'} on ${repo}`,
        risk: 'medium'
      }
    case 'github_cancel_workflow_run':
      return {
        title: 'Cancel workflow',
        description: `Run #${args?.run_id ?? '?'} on ${repo}`,
        risk: 'medium'
      }
    case 'github_dispatch_workflow':
      return {
        title: 'Dispatch workflow',
        description: `${args?.workflow_id ?? '?'} on ${repo}`,
        risk: 'medium'
      }
    default:
      return null
  }
}

export default {
  name: 'github',
  tools: toolDefinitions,

  async init(context) {
    workspaceRoot = context?.workspaceRoot ?? null
  },

  describeAction(toolName, args) {
    const base = describeActionBase(toolName, args)
    // Surface which connection the action targets on the approval card, so a
    // user with several linked accounts can tell "Personal" from "Work".
    if (base && args?.connection) {
      base.description = base.description
        ? `${base.description} · ${args.connection}`
        : String(args.connection)
    }
    return base
  },

  async execute(toolName, args) {
    const handler = TOOL_MAP[toolName]
    if (!handler) return { success: false, error: `github: unknown tool ${toolName}` }
    return handler(args)
  },

  async destroy() {}
}
