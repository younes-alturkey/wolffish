---
name: github
description: GitHub integration — repos, issues, pull requests, branches, CI/Actions, code search, releases, gists, collaborators, labels, milestones, reviews, notifications, stars, forks, and more via the GitHub API
triggers:
  - github
  - pull request
  - PR
  - issue
  - repo
  - repository
  - branch
  - merge
  - CI
  - actions
  - workflow
  - commit history
  - code review
  - release
  - gist
  - organization
  - org
  - collaborator
  - invite
  - comment
  - label
  - milestone
  - review
  - reviewer
  - notification
  - star
  - fork
  - compare
  - dispatch
  - topic
  - clone
  - commit
  - push
  - deploy
  - pipeline
  - build status
  - check
  - assignee
  - assign
  - tag
  - version
  - changelog
  - open issue
  - close issue
  - create issue
  - list issues
  - list PRs
  - merge PR
  - approve
  - request changes
  - dependabot
  - security
  - vulnerability
  - contributor
  - readme
  - license
  - gitignore
  - webhook
  - secret
  - environment
  - pages
  - discussion
  - sponsorship
  - git remote
  - origin url
  - upstream repo
  - base branch
  - head branch
  - draft PR
  - squash merge
  - rebase merge
  - auto merge
  - branch protection
  - required checks
  - status check
  - failing CI
  - passing CI
  - green build
  - red build
  - test failure
  - code owner
  - codeowners
  - blame
  - contributors
  - insights
  - traffic
  - clones
  - package
  - registry
  - artifact
  - matrix
  - runner
  - self hosted
  - github api
  - octokit
  - personal access token
  - pat
  - ssh key
  - deploy key
  - my repos
  - my issues
  - my PRs
  - assigned to me
  - review requested
  - open PRs
  - closed issues
  - file changed
  - lines changed
requires:
  - shell
  - node
tools:
  - name: github_connections
    description: 'List the configured GitHub connections (their labels and connected account) so you know which `connection` to pass on other github_* tools. Never exposes tokens.'
    parameters: {}
  - name: github_list_repos
    readOnly: true
    description: List the authenticated user's repositories. Returns name, description, visibility, default branch, and last pushed date.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      type:
        type: string
        required: false
        description: '"all", "owner", or "member". Default "owner".'
        enum:
          - all
          - owner
          - member
      sort:
        type: string
        required: false
        description: '"created", "updated", "pushed", or "full_name". Default "updated".'
        enum:
          - created
          - updated
          - pushed
          - full_name
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_get_repo
    readOnly: true
    description: Get details for a specific repository including open issues count, stars, forks, default branch, language, and topics.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner (username or org)
      repo:
        type: string
        description: Repository name
  - name: github_create_repo
    description: Create a new repository for the authenticated user.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      name:
        type: string
        description: Repository name
      description:
        type: string
        required: false
        description: Short description
      private:
        type: boolean
        required: false
        description: Whether the repo is private (default true)
      auto_init:
        type: boolean
        required: false
        description: Initialize with a README (default false)
  - name: github_list_issues
    readOnly: true
    description: List issues for a repository. Returns issue number, title, state, labels, assignee, and created date.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      state:
        type: string
        required: false
        description: '"open", "closed", or "all". Default "open".'
        enum:
          - open
          - closed
          - all
      labels:
        type: string
        required: false
        description: Comma-separated list of label names to filter by
      assignee:
        type: string
        required: false
        description: Username to filter by assignee
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_get_issue
    readOnly: true
    description: Get a single issue with full body and comments.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      issue_number:
        type: number
        description: Issue number
  - name: github_create_issue
    description: Create a new issue in a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      title:
        type: string
        description: Issue title
      body:
        type: string
        required: false
        description: Issue body (markdown)
      labels:
        type: array
        required: false
        description: Array of label names to apply
      assignees:
        type: array
        required: false
        description: Array of usernames to assign
  - name: github_close_issue
    description: Close an issue.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      issue_number:
        type: number
        description: Issue number
  - name: github_list_prs
    readOnly: true
    description: List pull requests for a repository. Returns PR number, title, state, head/base branches, author, and review status.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      state:
        type: string
        required: false
        description: '"open", "closed", or "all". Default "open".'
        enum:
          - open
          - closed
          - all
      head:
        type: string
        required: false
        description: Filter by head branch (user:branch format)
      base:
        type: string
        required: false
        description: Filter by base branch name
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_get_pr
    readOnly: true
    description: Get a single pull request with full body, diff stats, and review status.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      pull_number:
        type: number
        description: Pull request number
  - name: github_create_pr
    description: Create a new pull request.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      title:
        type: string
        description: PR title
      body:
        type: string
        required: false
        description: PR description (markdown)
      head:
        type: string
        description: Head branch (the branch with your changes)
      base:
        type: string
        description: Base branch (the branch you want to merge into)
      draft:
        type: boolean
        required: false
        description: Create as draft PR (default false)
  - name: github_merge_pr
    description: Merge a pull request.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      pull_number:
        type: number
        description: Pull request number
      merge_method:
        type: string
        required: false
        description: '"merge", "squash", or "rebase". Default "merge".'
        enum:
          - merge
          - squash
          - rebase
  - name: github_list_branches
    readOnly: true
    description: List branches for a repository. Returns branch names and whether they are protected.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
  - name: github_delete_branch
    description: Delete a branch from a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      branch:
        type: string
        description: Branch name to delete
  - name: github_get_workflow_runs
    description: Get recent CI/Actions workflow runs for a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      workflow_id:
        type: string
        required: false
        description: Workflow file name or ID to filter by (e.g. "ci.yml")
      branch:
        type: string
        required: false
        description: Branch to filter by
      status:
        type: string
        required: false
        description: Filter by status (queued, in_progress, completed, etc.)
  - name: github_get_workflow_run_logs
    description: Get logs for a specific workflow run. Returns log content truncated for context.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      run_id:
        type: number
        description: Workflow run ID
  - name: github_create_release
    description: Create a new release on a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      tag_name:
        type: string
        description: Tag name for the release (e.g. "v1.0.0")
      name:
        type: string
        description: Release title
      body:
        type: string
        required: false
        description: Release notes (markdown)
      draft:
        type: boolean
        required: false
        description: Create as draft (default false)
      prerelease:
        type: boolean
        required: false
        description: Mark as prerelease (default false)
      target_commitish:
        type: string
        required: false
        description: Branch or commit SHA for the tag (default repo default branch)
  - name: github_search_code
    readOnly: true
    description: Search code across GitHub repositories.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      query:
        type: string
        description: Search query (GitHub code search syntax)
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_get_file_content
    readOnly: true
    description: Get the contents of a file from a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      path:
        type: string
        description: File path within the repository
      ref:
        type: string
        required: false
        description: Branch, tag, or commit SHA (default repo default branch)
  - name: github_list_gists
    readOnly: true
    description: List the authenticated user's gists.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_create_gist
    description: Create a new gist.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      description:
        type: string
        required: false
        description: Gist description
      files:
        type: object
        description: 'Object mapping filename to content, e.g. { "hello.py": "print(\"hello\")" }'
      public:
        type: boolean
        required: false
        description: Whether the gist is public (default false)
  - name: github_delete_repo
    description: Permanently delete a repository. This action is irreversible.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
  - name: github_list_user_orgs
    readOnly: true
    description: List organizations the authenticated user belongs to. Returns org login, description, and URL. Use this to discover org names before calling github_list_org_repos.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
  - name: github_list_org_repos
    readOnly: true
    description: List repositories for a specific organization. Returns name, description, visibility, default branch, and last pushed date.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      org:
        type: string
        description: Organization name
      type:
        type: string
        required: false
        description: '"all", "public", "private", "forks", "sources", or "member". Default "all".'
        enum:
          - all
          - public
          - private
          - forks
          - sources
          - member
      sort:
        type: string
        required: false
        description: '"created", "updated", "pushed", or "full_name". Default "updated".'
        enum:
          - created
          - updated
          - pushed
          - full_name
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_get_authenticated_user
    readOnly: true
    description: Get the authenticated user's profile. Returns username, name, email, bio, public repos count, followers, and created date.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
  - name: github_list_collaborators
    readOnly: true
    description: List collaborators on a repository. Returns username, role, and permissions.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      affiliation:
        type: string
        required: false
        description: '"outside", "direct", or "all". Default "all".'
        enum:
          - outside
          - direct
          - all
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_add_collaborator
    description: Invite a collaborator to a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      username:
        type: string
        description: Username to invite
      permission:
        type: string
        required: false
        description: '"pull", "push", or "admin". Default "push".'
        enum:
          - pull
          - push
          - admin
  - name: github_remove_collaborator
    description: Remove a collaborator from a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      username:
        type: string
        description: Username to remove
  - name: github_list_comments_on_issue
    readOnly: true
    description: List comments on an issue or PR. Returns comment author, body, and created date.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      issue_number:
        type: number
        description: Issue or PR number
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_add_comment
    description: Add a comment to an issue or PR.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      issue_number:
        type: number
        description: Issue or PR number
      body:
        type: string
        description: Comment body (markdown)
  - name: github_list_labels
    readOnly: true
    description: List labels for a repository. Returns label name, color, and description.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_create_label
    description: Create a label in a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      name:
        type: string
        description: Label name
      color:
        type: string
        required: false
        description: Hex color without # (e.g. "ff0000"). Default random.
      description:
        type: string
        required: false
        description: Label description
  - name: github_add_labels_to_issue
    description: Add labels to an issue or PR.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      issue_number:
        type: number
        description: Issue or PR number
      labels:
        type: array
        description: Array of label names to add
  - name: github_list_milestones
    readOnly: true
    description: List milestones for a repository. Returns title, description, due date, and open/closed issue counts.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      state:
        type: string
        required: false
        description: '"open", "closed", or "all". Default "open".'
        enum:
          - open
          - closed
          - all
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_create_milestone
    description: Create a milestone in a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      title:
        type: string
        description: Milestone title
      description:
        type: string
        required: false
        description: Milestone description
      due_on:
        type: string
        required: false
        description: Due date (ISO 8601 format, e.g. "2025-12-31T00:00:00Z")
      state:
        type: string
        required: false
        description: '"open" or "closed". Default "open".'
        enum:
          - open
          - closed
  - name: github_list_pr_reviews
    readOnly: true
    description: List reviews on a pull request. Returns reviewer, state, body, and submitted date.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      pull_number:
        type: number
        description: Pull request number
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_request_reviewers
    description: Request reviewers on a pull request.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      pull_number:
        type: number
        description: Pull request number
      reviewers:
        type: array
        description: Array of usernames to request review from
      team_reviewers:
        type: array
        required: false
        description: Array of team slugs to request review from
  - name: github_list_pr_files
    readOnly: true
    description: List files changed in a pull request. Returns filename, status, additions, deletions, and patch snippet.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      pull_number:
        type: number
        description: Pull request number
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_update_pr
    description: Update a pull request's title, body, state, or base branch.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      pull_number:
        type: number
        description: Pull request number
      title:
        type: string
        required: false
        description: New title
      body:
        type: string
        required: false
        description: New body (markdown)
      state:
        type: string
        required: false
        description: '"open" or "closed".'
        enum:
          - open
          - closed
      base:
        type: string
        required: false
        description: New base branch
  - name: github_list_releases
    readOnly: true
    description: List releases for a repository. Returns tag name, release name, published date, draft/prerelease flags, and asset count.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_get_release
    readOnly: true
    description: Get a single release with full body and asset download URLs.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      release_id:
        type: number
        required: false
        description: Release ID (use this or tag, not both)
      tag:
        type: string
        required: false
        description: Tag name (e.g. "v1.0.0") — alternative to release_id
  - name: github_list_repo_topics
    readOnly: true
    description: List topics (tags) for a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
  - name: github_replace_repo_topics
    description: Replace all topics on a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      names:
        type: array
        description: Array of topic strings to set
  - name: github_get_commit
    readOnly: true
    description: Get details for a specific commit. Returns SHA, author, message, date, and files changed.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      ref:
        type: string
        description: Commit SHA, branch name, or tag
  - name: github_compare_commits
    description: Compare two commits, branches, or tags. Returns ahead/behind counts, commit list, and files changed.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      base:
        type: string
        description: Base commit/branch/tag
      head:
        type: string
        description: Head commit/branch/tag
  - name: github_list_notifications
    readOnly: true
    description: List the authenticated user's notifications.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      all:
        type: boolean
        required: false
        description: Include read notifications (default false)
      participating:
        type: boolean
        required: false
        description: Only show notifications where user is participating (default false)
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_mark_notifications_read
    description: Mark all notifications as read.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      last_read_at:
        type: string
        required: false
        description: ISO 8601 timestamp — marks notifications before this time as read. Defaults to now.
  - name: github_list_stargazers
    readOnly: true
    description: List users who have starred a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      per_page:
        type: number
        required: false
        description: Results per page (default 10, max 100)
  - name: github_star_repo
    description: Star a repository for the authenticated user.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
  - name: github_unstar_repo
    description: Unstar a repository for the authenticated user.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
  - name: github_fork_repo
    description: Fork a repository.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      organization:
        type: string
        required: false
        description: Organization to fork into (default personal account)
  - name: github_rerun_workflow
    description: Re-run a failed or completed workflow run.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      run_id:
        type: number
        description: Workflow run ID
  - name: github_cancel_workflow_run
    description: Cancel an in-progress workflow run.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      run_id:
        type: number
        description: Workflow run ID
  - name: github_dispatch_workflow
    description: Manually trigger a workflow via workflow_dispatch event.
    parameters:
      connection:
        type: string
        required: false
        description: 'Which linked GitHub connection (account) to use, by its label (e.g. "Personal", "Work"). Optional when only one connection is configured; required to disambiguate when several exist. Call github_connections to list the labels.'
      owner:
        type: string
        description: Repository owner
      repo:
        type: string
        description: Repository name
      workflow_id:
        type: string
        description: Workflow file name (e.g. "deploy.yml") or workflow ID
      ref:
        type: string
        description: Branch or tag to run the workflow on
      inputs:
        type: object
        required: false
        description: Key-value pairs for workflow inputs
danger_patterns:
  - pattern: 'github_delete_repo'
    level: block
    reason: Repository deletion is permanently destructive and blocked by default
confirm_patterns:
  - pattern: 'github_close_issue'
    reason: Closing a GitHub issue
  - pattern: 'github_merge_pr'
    reason: Merging a pull request
  - pattern: 'github_create_release'
    reason: Creating a GitHub release
  - pattern: 'github_delete_branch'
    reason: Deleting a branch from a repository
  - pattern: 'github_create_repo'
    reason: Creating a new GitHub repository
  - pattern: 'github_create_pr'
    reason: Creating a pull request
  - pattern: 'github_create_issue'
    reason: Creating a GitHub issue
  - pattern: 'github_create_gist'
    reason: Creating a gist
  - pattern: 'github_add_collaborator'
    reason: Inviting a collaborator to a repository
  - pattern: 'github_remove_collaborator'
    reason: Removing a collaborator from a repository
  - pattern: 'github_replace_repo_topics'
    reason: Replacing all topics on a repository
  - pattern: 'github_fork_repo'
    reason: Forking a repository
  - pattern: 'github_rerun_workflow'
    reason: Re-running a workflow
  - pattern: 'github_cancel_workflow_run'
    reason: Cancelling a workflow run
  - pattern: 'github_dispatch_workflow'
    reason: Manually triggering a workflow
---

# GitHub

Interact with GitHub repositories, issues, pull requests, branches, CI, releases, gists, collaborators, labels, milestones, reviews, notifications, stars, forks, and more.

## Connections

GitHub access is organized into **connections**. Each connection is one GitHub account the user linked, identified by a **label** they chose (for example `Work` or `Personal`). The label is how you — and the user — tell one account apart from another.

- Call `github_connections` to see the configured labels and which account each points to. It never returns tokens.
- Pass the chosen label as the `connection` parameter on every other `github_*` tool call.
- You may omit `connection` only when exactly one connection is configured. When several exist and you don't pass one, the tool returns an error listing the available labels — read it and retry with the right label.
- Match the label to the user's intent: "my work github" → the connection labeled `Work`; "my personal account" → `Personal`. If it is genuinely ambiguous which the user means, ask them before acting.

## Authentication

Set your Personal Access Token (PAT) in Settings > Services > GitHub. The token needs the `repo` scope for full repository access. For public repos only, `public_repo` is sufficient. For gists, add `gist`. For deleting repos, add `delete_repo`. For notifications, add `notifications`. For listing organization membership (`github_list_user_orgs`), add `read:org`.

## When to use each tool

- **Repos**: `github_list_repos` to browse your repos, `github_list_user_orgs` to see which orgs you belong to, `github_list_org_repos` to browse an org's repos, `github_get_repo` for details, `github_create_repo` to create
- **User**: `github_get_authenticated_user` to find out who the token belongs to — useful to resolve "my" repos or as the owner arg
- **Issues**: `github_list_issues` to browse, `github_get_issue` for full detail + comments, `github_create_issue` to file, `github_close_issue` to close
- **Comments**: `github_list_comments_on_issue` for just the discussion thread (lighter than github_get_issue), `github_add_comment` to post a comment
- **Labels**: `github_list_labels` to see available labels, `github_create_label` to add one, `github_add_labels_to_issue` to tag issues/PRs
- **Milestones**: `github_list_milestones` to see project milestones, `github_create_milestone` to add one
- **PRs**: `github_list_prs` to browse, `github_get_pr` for full detail + diff stats, `github_create_pr` to open, `github_update_pr` to edit title/body/state/base, `github_merge_pr` to merge
- **PR reviews**: `github_list_pr_reviews` for review status, `github_request_reviewers` to request reviews
- **PR files**: `github_list_pr_files` for the file-level diff summary (pairs well with github_get_pr for a full review picture)
- **Branches**: `github_list_branches` to see all, `github_delete_branch` to remove merged branches
- **CI**: `github_get_workflow_runs` for run status, `github_get_workflow_run_logs` for failure details, `github_rerun_workflow` to retry, `github_cancel_workflow_run` to stop, `github_dispatch_workflow` to trigger manually
- **Releases**: `github_list_releases` to browse, `github_get_release` for full detail + assets, `github_create_release` to publish
- **Commits**: `github_get_commit` for details on a specific commit, `github_compare_commits` to see the diff between two refs
- **Code**: `github_search_code` to find code across GitHub, `github_get_file_content` to read a specific file
- **Collaborators**: `github_list_collaborators` to see who has access, `github_add_collaborator` to invite, `github_remove_collaborator` to revoke
- **Topics**: `github_list_repo_topics` to see tags, `github_replace_repo_topics` to update them
- **Gists**: `github_list_gists` to browse, `github_create_gist` to share snippets
- **Notifications**: `github_list_notifications` to check what needs attention, `github_mark_notifications_read` to clear
- **Stars**: `github_list_stargazers` to see who starred a repo, `github_star_repo` / `github_unstar_repo` to manage stars
- **Forks**: `github_fork_repo` to fork a repo into your account or an org

## Common tool chains

- **Full PR review**: `github_get_pr` + `github_list_pr_files` + `github_list_pr_reviews` gives you the description, changed files, and review status
- **Before creating a PR**: `github_compare_commits` with base and head to preview what will be in the PR
- **Triage notifications**: `github_list_notifications` to see what's new, then fetch individual issues/PRs as needed
- **Project setup**: `github_create_label` + `github_create_milestone` to set up tracking before filing issues
- **Investigate a CI failure**: `github_get_workflow_runs` to find the run, `github_get_workflow_run_logs` for details, `github_rerun_workflow` to retry

## When to use shell instead

For local git operations (commit, push, pull, diff, log, status, stash, rebase, etc.), use `shell_exec` with git commands. GitHub tools are for the remote API — things you'd do on github.com, not in your terminal.

## Response formatting

Always include actionable links in responses:
- Issues: `https://github.com/{owner}/{repo}/issues/{number}`
- PRs: `https://github.com/{owner}/{repo}/pull/{number}`
- Repos: `https://github.com/{owner}/{repo}`
- Releases: include the release URL from the API response
- Commits: `https://github.com/{owner}/{repo}/commit/{sha}`

## Pagination

`per_page` is accepted by most list tools. The GitHub API hard-caps it at **100** — requesting more than 100 returns a validation error. For large result sets, page through with multiple calls rather than requesting an impossibly large single page.

## Rate limits

GitHub's API allows 5,000 requests/hour for authenticated users. The plugin handles rate limiting automatically — if you hit the limit, wait and retry.
