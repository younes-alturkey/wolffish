---
name: git
description: Git operations and conventions, layered on top of the shell capability.
triggers:
  - git
  - commit
  - branch
  - merge
  - push
  - pull
  - PR
  - repo
  - diff
  - stash
  - rebase
  - blame
  - clone
  - checkout
  - fetch
  - remote
  - origin
  - upstream
  - tag
  - version
  - log
  - history
  - cherry-pick
  - squash
  - amend
  - reset
  - revert
  - conflict
  - resolve
  - staging
  - unstage
  - add
  - status
  - gitignore
  - submodule
  - worktree
  - bisect
  - reflog
  - clean
  - archive
  - git init
  - git clone
  - git pull
  - git push
  - git commit
  - git branch
  - git merge
  - git rebase
  - git stash
  - git diff
  - git log
  - git status
  - git add
  - git reset
  - git checkout
  - git switch
  - git restore
  - git tag
  - git remote
  - git fetch
  - git blame
  - git show
  - git cherry-pick
  - git revert
  - git bisect
  - git reflog
  - git clean
  - git worktree
  - git submodule
  - git config
  - version control
  - source control
  - vcs
  - scm
  - repository
  - working tree
  - working directory
  - staged changes
  - unstaged changes
  - untracked files
  - tracked files
  - head
  - detached head
  - fast forward
  - three way merge
  - merge conflict
  - resolve conflict
  - abort merge
  - abort rebase
  - interactive rebase
  - force push
  - force pull
  - hard reset
  - soft reset
  - mixed reset
  - create branch
  - delete branch
  - rename branch
  - list branches
  - current branch
  - commit message
  - commit hash
  - commit history
  - show changes
  - what changed
  - who changed
requires:
  - shell
---

# Git Workflow

This is a pure skill — it has no plugin of its own. It teaches the
agent how to use the `shell` capability's `shell_exec` tool to perform
Git operations the way the user prefers.

## When checking repo status

1. Run `git status` via `shell_exec`.
2. If something has changed, run `git diff --stat` for a summary.
3. Run `git log --oneline -5` to show recent commits.
4. Summarize in plain language — don't just dump the output.

## When making a commit

1. Run `git status` to see what's staged vs. unstaged.
2. Run `git diff --staged` (or `git diff` if nothing is staged yet) to
   see exactly what's changing.
3. Generate a Conventional Commit message: `type(scope): subject`.
4. Show the proposed message to the user and wait for approval.
5. Only after approval, run the commit:

   ```sh
   git commit -m "..."
   ```

   The commit message is the user's — don't append attribution
   trailers or tool credits of any kind unless they ask for one.

   The safety gate may also prompt — that's expected.
6. After commit, run `git log -1 --stat` to confirm.

## When creating a branch

1. Confirm the current branch with `git branch --show-current`.
2. Branch from `main` unless the user specifies otherwise.
3. Use kebab-case naming with a type prefix:
   - `feature/<description>` — new functionality
   - `fix/<description>` — bug fix
   - `chore/<description>` — refactor, tooling, deps
   - `docs/<description>` — docs only
4. Run `git switch -c <name>` to create + switch.

## When pushing

1. Pushing requires explicit user approval (the safety gate enforces this).
2. Never use `--force` without explicit instruction. Prefer `--force-with-lease`
   when overwriting is genuinely required.
3. After push, surface the GitHub/GitLab URL if the remote indicates one.

## When something looks dangerous

If you're about to do something with `git reset --hard`, `git push --force`,
`git clean -fd`, or anything that throws away local work — stop, explain,
and ask before running.
