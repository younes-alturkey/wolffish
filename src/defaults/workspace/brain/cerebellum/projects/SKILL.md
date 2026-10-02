---
name: projects
description: YOU OWN THIS. Manage the user's projects — shared instructions and file lists that fresh conversations start from — and see each project's conversations. Reach for it by INTENT whenever a need or issue touches a project, its instructions, or its files — even when the user never says "project".
triggers:
  - project
  - projects
  - my project
  - project files
  - project instructions
  - add to project
  - attach to project
  - project conversations
  - which project
  - create project
  - delete project
  - update project
  - rename project
  - project icon
  - this project
  - what project
  - which project
  - project context
  - instructions for this
  - its files
  - the project's files
  - add my files
  - change the instructions
  - project working folder
  - the work folder
tools:
  - name: project_list
    readOnly: true
    description: List every project — number, icon, title, file count, last-edited time. Use before viewing, editing, or deleting one so you reference it by the correct number, title, or id.
    parameters: {}
  - name: project_view
    readOnly: true
    description: Show one project in full — icon, title, complete instructions, and its file list with per-file existence and size. Identify it by the number from project_list, its exact title, or its id.
    parameters:
      identifier:
        type: string
        description: The project — its 1-based number from project_list, its exact title, or its id.
  - name: project_create
    description: Create a new project with a title, optional emoji icon, and optional instructions. Returns the created project and its id.
    parameters:
      title:
        type: string
        description: Project title
      icon:
        type: string
        description: Emoji icon (one emoji), e.g. "📚"
        required: false
      instructions:
        type: string
        description: Instructions every conversation in this project starts from
        required: false
  - name: project_update
    description: Edit a project's title, emoji icon, or instructions (omitted fields kept). For files use project_add_files / project_remove_file.
    parameters:
      identifier:
        type: string
        description: The project — number from project_list, exact title, or id.
      title:
        type: string
        description: New title
        required: false
      icon:
        type: string
        description: New emoji icon
        required: false
      instructions:
        type: string
        description: New instructions (replaces the old text)
        required: false
  - name: project_add_files
    description: Attach files to a project by absolute path (or ~ prefix). Each source is COPIED into the project's workspace folder (uploads/project-<id>/) so the project owns its files — the original stays where it was. Missing sources are refused; an already-attached name is skipped.
    parameters:
      identifier:
        type: string
        description: The project — number from project_list, exact title, or id.
      paths:
        type: array
        description: Absolute file paths to attach
  - name: project_remove_file
    description: Detach one file from a project by its path or file name. The project's own workspace copy is deleted; originals outside the workspace are never touched.
    parameters:
      identifier:
        type: string
        description: The project — number from project_list, exact title, or id.
      file:
        type: string
        description: The attached file's path or name to remove
  - name: project_delete
    description: Permanently delete a project. Its past conversations stay in history (they simply lose the project context on future turns).
    parameters:
      identifier:
        type: string
        description: The project — number from project_list, exact title, or id.
  - name: project_conversations
    description: List every conversation belonging to a project — title, id, message count, last activity, newest first. Follow up with conversation_read on an id to revisit what was discussed there.
    parameters:
      identifier:
        type: string
        description: The project — number from project_list, exact title, or id.
confirm_patterns:
  - pattern: '^project_delete\s'
    reason: Permanently deletes a project the user may want to keep
---

# Projects — shared bases for conversations

**You own this.** Reach for it by intent whenever a need or issue touches a
project, its shared instructions, or its files — even if the user never names
it. The `project_*` tools are the way to manage projects; read the filesystem
only when a path genuinely isn't a project attachment.

A project bundles instructions plus a referenced file list; every fresh conversation started
inside it gets that base as context (instructions verbatim, files as a model-led reference
list — content is read on demand with pdf/file/image tools, never injected).

## Interface

- Tools: `project_list`, `project_view`, `project_create`, `project_update`,
  `project_add_files`, `project_remove_file`, `project_delete`, `project_conversations`
- Identify a project by its 1-based number from `project_list`, its exact title, or its id.
- These tools operate on the same store as the app's Projects page — changes show there and
  apply to project conversations from their next turn.

## Rules

- If the current conversation runs inside a project, the system prompt's `<project>` block
  names it — that is "this project" when the user says so.
- "What did we discuss in this project?" → `project_conversations`, then `conversation_read`
  on the relevant id. Never guess from memory when the transcript is one call away.
- Before editing instructions, `project_view` first and modify from the CURRENT text —
  `project_update` replaces the whole instructions body, and a blind write erases the user's
  wording.
- When attaching files the user mentioned loosely ("add my thesis"), resolve the real path
  first (search the disk with your tools); `project_add_files` refuses paths that don't exist.
- Attaching COPIES the file into the project's workspace folder — the project owns its copy,
  so later edits to the user's original are NOT reflected; re-attach to refresh a stale copy.
- A project can also carry WORKING FOLDERS (`project_view` shows them). Those are references,
  not copies: every turn inside the project gets a FRESH listing of each one, so the folder is
  seen as it is right now. Do the project's file work in them, and treat paths the user
  mentions as relative to them unless they say otherwise. They are attached in the app.
- Deleting is destructive and approval-gated; conversations survive a delete but lose the
  project context going forward.
