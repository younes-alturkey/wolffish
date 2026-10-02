---
name: archive
description: Work with zip archives — list what's inside a zip, read a file straight out of one, unzip all or part of it, and zip files and folders into a new archive
triggers:
  - zip
  - unzip
  - archive
  - compress
  - decompress
  - extract
  - unpack
  - pack
  - zip file
  - zip folder
  - zip up
  - zip these
  - make a zip
  - create archive
  - compressed folder
  - open the zip
  - read the zip
  - what's in the zip
  - inside the zip
  - contents of the zip
  - extract the zip
  - unzip the file
  - bundle files
  - package files
  - tar
  - tarball
  - gz
  - tgz
  - 7z
  - rar
  - compressed file
  - archive file
tools:
  - name: archive_list
    readOnly: true
    description: "List what is inside a .zip WITHOUT unpacking it: every entry path, its unpacked size and date, the top-level layout, totals, and which entries are encrypted. Reads only the archive's index, so it is fast on an archive of any size and costs nothing on disk. ALWAYS the first call on an archive you have not seen — you cannot say what a zip contains until you have run this. Supports paging (offset/limit) and a filter, and never truncates silently: the true match count is always reported."
    parameters:
      path:
        type: string
        description: "Path to the .zip archive. Absolute (/Users/you/x.zip), home-relative (~/Downloads/x.zip), or workspace-relative (uploads/x.zip)."
      filter:
        type: string
        description: "Narrow the listing: a glob like \"*.ts\" or \"src/**\" (matched against the full entry path and the file name), or a plain substring like \"src/\". Omit to list everything."
        required: false
      limit:
        type: number
        description: "Rows to show per call, 1-1000 (default 100)."
        required: false
      offset:
        type: number
        description: "Row to start from — page through a big archive with offset:100, offset:200, …"
        required: false
  - name: archive_read
    readOnly: true
    description: "Read one text file straight out of a .zip — no extraction, nothing written to disk. Use this to answer questions about an archive's contents (a README, a config, a source file) instead of unpacking the whole thing. The entry path comes from archive_list; a bare file name resolves if it is unambiguous. Long files page with start_line/end_line and the per-call cap is always reported. Binary entries are not dumped as garbage — you get their size and the tool to open them with after extracting."
    parameters:
      path:
        type: string
        description: "Path to the .zip archive."
      entry:
        type: string
        description: "The entry to read, exactly as archive_list prints it (e.g. \"project-main/src/index.ts\")."
      start_line:
        type: number
        description: "First line to return, 1-based. Use with end_line to page through a long file."
        required: false
      end_line:
        type: number
        description: "Last line to return."
        required: false
      password:
        type: string
        description: "Password, if the archive is encrypted (archive_list flags encrypted entries)."
        required: false
  - name: archive_extract
    description: "Unzip an archive to disk — all of it, or only the entries you select. Without output_dir it creates a new folder named after the archive next to it (an uploaded archive unpacks into the workspace files/ folder instead), never overwriting an existing folder. Entries that would escape the destination are refused outright. Reports exactly what landed where. Nothing is shown to the user automatically — follow up with show_path (folder) or send_file (one file)."
    parameters:
      path:
        type: string
        description: "Path to the .zip archive."
      output_dir:
        type: string
        description: "Destination folder. Omit to unpack into a new folder beside the archive."
        required: false
      entries:
        type: string
        description: "Optional selection — entry paths, globs (\"*.csv\", \"docs/*\"), or substrings, as a JSON array or comma-separated list. Omit to extract everything."
        required: false
      password:
        type: string
        description: "Password, if the archive is encrypted."
        required: false
  - name: archive_create
    description: "Zip files and/or folders into a new .zip archive. A folder keeps its own name as the archive's root, so unzipping produces a folder instead of spraying files loose. Reports the entry count, packed and unpacked size, and warns when heavy folders (node_modules, .git, venv) went in so you can re-run with exclude. The archive is NOT delivered to the user by this call — send_file it afterwards."
    parameters:
      output_path:
        type: string
        description: "Path for the new .zip file (must end in .zip)."
      paths:
        type: string
        description: "The files and/or folders to pack — a JSON array of paths, or a comma-separated list."
      base_dir:
        type: string
        description: "Make every entry path relative to this folder (all inputs must live inside it). Use it to control the archive's internal layout."
        required: false
      exclude:
        type: string
        description: "Patterns to leave out — globs or substrings, comma-separated (e.g. \"node_modules,.git,*.log\"). Matched against each entry path and its segments."
        required: false
---

# Archive

Four tools for `.zip` files: `archive_list` (what's inside), `archive_read`
(one file out of it), `archive_extract` (unpack), `archive_create` (pack).
They work in-process — no `unzip` or `zip` binary needed, same behaviour on
macOS and Windows.

## Look before you unpack

An archive is opaque until you list it, and unpacking is a side effect on the
user's disk. So the order is always **list → decide → act**:

1. `archive_list` — cheap on any size, tells you what you're dealing with.
2. Decide with the user what they actually want (see below).
3. `archive_read` if the answer is inside one or two files; `archive_extract`
   if they want the files on disk.

Never claim to know what an archive contains without listing it first, and
never describe files you have not read.

## When the user uploads a zip and says nothing

This is the common case, and unpacking by default is the wrong move — you don't
know whether they want it extracted, read, converted, inspected for one file, or
sent somewhere. Do this instead:

1. `archive_list` it.
2. Tell them what's in there in one or two lines — the shape, not a file dump
   ("It's a 212-file React project — src/, public/, package.json, plus a 40 MB
   video in assets/").
3. **Ask what they want done with it**, and offer the obvious options for what
   you just saw ("Unpack it somewhere? Read a specific file? Convert the CSVs?").
   Use `ask_user` when a short list of choices covers it.

Skip the question only when the request already answers it — "unzip this",
"what's the README say", "pull the invoices out of this". Then just do it.

## Reading vs extracting

`archive_read` answers questions; `archive_extract` puts files on the user's
disk. Prefer reading: it's faster, leaves nothing behind, and is usually what a
question about an archive actually needs. Extract when the user wants the files,
when you need to run tools over many of them, or when a file is binary
(`archive_read` will tell you so rather than dumping bytes).

After extracting, the files exist but the user has seen nothing. Close the loop:
`show_path` the folder for an openable card, or `send_file` the one file they
wanted. A path named in prose is not delivery.

## Packing

`archive_create` takes files, folders, or a mix. Pass a folder and it keeps its
name as the archive's root — `~/Projects/report` becomes `report/…` inside the
zip, so unpacking makes a folder rather than dumping loose files. `base_dir`
overrides that when you want a specific internal layout.

Nothing is excluded by default. If `node_modules`, `.git`, `venv`, `dist` or
`__pycache__` went in, the result says so — check the numbers, and re-run with
`exclude: "node_modules,.git"` if that wasn't the intent. Zipping a project
folder blind is how a 4 MB source tree becomes a 900 MB archive.

The new archive is not delivered anywhere by itself. `send_file` it when the
user is supposed to receive it (under 50 MB), or `show_path` it when it's large
and staying on disk.

## Other archive formats

These tools are zip-only, and they check the file's actual signature rather than
trusting its extension. A `.tar`, `.tar.gz`/`.tgz`, `.bz2`, `.xz`, `.7z` or
`.rar` is rejected with the exact shell command that handles it — run that with
your shell tool:

- `tar -tzf file.tgz` / `tar -xzf file.tgz -C dest` (gzip tarballs)
- `tar -tf file.tar` / `tar -xf file.tar -C dest`
- `7z l file.7z` / `7z x file.7z -o dest` (needs p7zip)
- `unar -o dest file.rar`

Going the other way, `zip -r out.zip folder` and `unzip file.zip -d dest` are
the right escape hatch for a genuinely huge tree (many GB): these tools build
archives in memory, so a multi-gigabyte pack or unpack belongs in the shell.

## Office files are zips

`.docx`, `.xlsx`, `.pptx`, `.jar`, `.epub` and `.apk` are zip containers, so
`archive_list` and `archive_read` open them. That is a debugging move, not the
normal route: use `document_read`, `spreadsheet_read` and the pdf tools for
those formats. Reaching in with `archive_read` is for when you need the raw XML
— e.g. `ppt/slides/slide1.xml` to pull the text out of a PowerPoint, whose
prose lives in `<a:t>` elements.

## Encrypted archives

`archive_list` still works on an encrypted archive (the index isn't encrypted)
and flags which entries need a password. `archive_read` and `archive_extract`
take a `password`. If decryption keeps failing with a password the user is sure
about, the archive uses AES encryption, which these tools can't read — say so
and fall back to `unzip -P <password> archive.zip -d dest` in the shell.

## Notes

- Paths can be absolute, `~/`-relative, or workspace-relative (`uploads/x.zip`).
- Extraction refuses any entry that would write outside the destination folder,
  and stores symlink entries as plain files — a hostile archive cannot reach
  outside the folder you chose.
- `__MACOSX/`, `.DS_Store` and `Thumbs.db` are skipped on extract and the count
  is reported, so a mac-made zip doesn't leave cruft behind.
