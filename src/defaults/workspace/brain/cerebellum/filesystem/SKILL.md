---
name: filesystem
description: Read, write, and edit files on the local system
triggers:
  - file
  - files
  - read
  - write
  - edit
  - create
  - save
  - open
  - patch
  - modify
  - content
  - folder
  - directory
  - rename
  - move
  - copy
  - delete
  - remove
  - path
  - text
  - overwrite
  - append
  - list files
  - show file
  - update file
  - change file
  - what's in
  - replace
  - find and replace
  - look at
  - check file
  - config
  - configuration
  - log
  - document
  - txt
  - json
  - yaml
  - yml
  - xml
  - env
  - dotfile
  - gitignore
  - readme
  - makefile
  - toml
  - ini
  - csv
  - properties
  - source code
  - snippet
  - template
  - backup
  - archive
  - workspace
  - project
  - codebase
  - cat
  - head
  - tail
  - wc
  - line count
  - show contents
  - print file
  - what does this file say
  - read the file
  - write to file
  - save to file
  - create a file
  - new file
  - update config
  - edit config
tools:
  - name: file_read
    readOnly: true
    description: 'Read a file or list a directory. Lines come back numbered as `N: text` (the number is NOT part of the content — never paste it into an edit). Default window is 2000 lines / 100 KB from `offset`; the footer says how to continue. Long lines are clipped at 2000 chars. A directory returns its entries (subdirectories end with /). Missing paths answer with nearby names. Prefer file_grep to find something in a big file, and file_glob to find a file by name.'
    parameters:
      path:
        type: string
        description: Absolute path, ~ path, or a path relative to the first working folder (the runtime tail names it; without one, relative paths land in the Wolffish workspace)
      offset:
        type: number
        required: false
        description: 1-based line to start from (default 1)
      limit:
        type: number
        required: false
        description: Maximum lines to return (default 2000)
      startLine:
        type: number
        required: false
        description: Alias of offset (kept for older calls)
      endLine:
        type: number
        required: false
        description: Last line to include, inclusive (alternative to limit)
  - name: file_edit
    description: 'Exact-string edit: replaces ONE occurrence of `old` with `new` in the file (every occurrence with replaceAll). Read the file first and copy `old` exactly as it appears after the line-number prefix — whitespace and indentation included; close-but-inexact text is matched leniently, but the match must be unique or the call refuses with "Found multiple matches" (add surrounding lines to disambiguate, or use replaceAll for a rename). Fails when `old` is not found. An empty `old` on a path that does not exist creates the file. Returns +N −M, the changed region with its new line numbers, and a diff the user sees.'
    parameters:
      path:
        type: string
        description: Absolute path, ~ path, or a path relative to the working folder
      old:
        type: string
        description: The exact text to replace (empty only when creating a new file)
      new:
        type: string
        description: The replacement text (must differ from old)
      replaceAll:
        type: boolean
        required: false
        description: Replace every occurrence of old (default false) — for renames
  - name: file_write
    description: Create or overwrite a whole text file (mode=append appends). Prefer file_edit for changing an existing file — it keeps everything you did not touch byte-identical and shows a diff. Never write documentation or README files unless asked.
    parameters:
      path:
        type: string
        description: Absolute path, ~ path, or a path relative to the working folder
      content:
        type: string
        description: Text to write
      mode:
        type: string
        required: false
        description: 'overwrite (default) or append'
        enum:
          - overwrite
          - append
  - name: file_grep
    readOnly: true
    description: 'Search file CONTENTS with a regex (ripgrep under the hood, gitignore-aware, any codebase size). Returns file paths with line numbers and the matching line, up to 100 matches, grouped by file. Use it to find where something is defined or used; use `include` to narrow by file type ("*.ts", "*.{ts,tsx}"). Run several searches in one message when they are independent.'
    parameters:
      pattern:
        type: string
        description: Regular expression (ripgrep syntax) to search for
      path:
        type: string
        required: false
        description: Directory (or single file) to search; defaults to the working folder
      include:
        type: string
        required: false
        description: 'Glob filter on file names, e.g. "*.js" or "*.{ts,tsx}"'
  - name: file_glob
    readOnly: true
    description: 'Find files by NAME pattern ("**/*.test.ts", "src/**/*.tsx", "*.md"), gitignore-aware. Returns up to 100 absolute paths. Use it when you know roughly what a file is called; use file_grep when you know what it contains.'
    parameters:
      pattern:
        type: string
        description: Glob pattern relative to the search directory
      path:
        type: string
        required: false
        description: Directory to search; defaults to the working folder
  - name: file_patch
    description: Deprecated — use file_edit. Replaces EVERY occurrence of find with replace (same as file_edit with replaceAll=true).
    parameters:
      path:
        type: string
        description: Absolute path or path starting with ~
      find:
        type: string
        description: Literal text to search for
      replace:
        type: string
        description: Replacement text
  - name: image_view
    readOnly: true
    description: View an image file — returns the actual pixels in the tool result. Attached images are never auto-loaded, so this is how you SEE one. You choose the view, and the choice is a real cost/clarity trade — max_dimension sets the long edge (default 1024, which reads scenes, layout and large type; raise to 1600-2048 only when you must resolve small text), region crops in the ORIGINAL pixel grid before any resize, and format png keeps screenshots, UI, charts and text crisp while jpeg suits photographs. Prefer a tight region at a modest max_dimension over a large max_dimension on the whole frame — a crop is sharper AND cheaper, because cost tracks the pixels you send, not the size of the file. Requires a vision-capable model (on text-only models the pixels are stripped — use shell tools like exiftool/sips for metadata instead).
    parameters:
      path:
        type: string
        description: Absolute path or path starting with ~ to the image file
      max_dimension:
        type: integer
        required: false
        description: Long edge of the returned view in pixels (default 1024). Never upscales past the source, so a value larger than the image simply returns it at native size.
      region:
        type: object
        required: false
        description: Crop to inspect, in ORIGINAL image pixels, applied before the resize. Omit to view the whole frame. Out-of-bounds rectangles are clamped and the result says so.
        properties:
          x:
            type: integer
            description: Left edge in original pixels
          y:
            type: integer
            description: Top edge in original pixels
          width:
            type: integer
            description: Crop width in original pixels
          height:
            type: integer
            description: Crop height in original pixels
      format:
        type: string
        required: false
        description: jpeg (default, best for photographs) or png (lossless, best for text and UI)
        enum:
          - jpeg
          - png
      quality:
        type: integer
        required: false
        description: JPEG quality 1-100 (default 75). Ignored for png.
requires:
  - node
danger_patterns:
  - pattern: '\.\./'
    args: [path]
    level: destructive
    reason: Path traversal attempt
confirm_patterns:
  - pattern: '/etc/'
    args: [path]
    reason: Modifying system configuration
  - pattern: '/usr/'
    args: [path]
    reason: Modifying system files
  - pattern: '/private/'
    args: [path]
    reason: Modifying protected system area
---

# Filesystem

## Interface

- Tools: `file_read`, `file_edit`, `file_write`, `file_grep`, `file_glob`, `image_view` (`file_patch` is a deprecated alias of `file_edit` with replaceAll).
- Paths: absolute, `~`, or relative to the first working folder when the conversation has one (the runtime tail names it). Without a working folder, relative paths land in the Wolffish workspace.
- Writes create parent directories as needed. Edits and writes run the project's own formatter (prettier, biome, ruff, gofmt, rustfmt, shfmt) when the project declares one, and return a diff the user sees.

## Rules

- **Read before you edit.** `file_read` shows numbered lines; copy the text you want to change exactly as it appears AFTER the `N: ` prefix — the prefix is never part of the file.
- **Prefer `file_edit` for changes to existing files.** It touches only the matched text and refuses ambiguous matches; `file_write` is for new files or an intentional whole-file replacement.
- **Search, don't guess.** `file_grep` for content, `file_glob` for names — both gitignore-aware and bounded. Run independent searches and reads in one message; they execute concurrently.
- Never write to system paths (`/etc/`, `/usr/`, `/private/`) without asking — the safety gate will prompt the user, but be transparent about what you're doing first.
- When showing file contents back to the user, format them as a code block.
