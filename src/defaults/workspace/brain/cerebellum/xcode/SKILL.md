---
name: xcode
description: 'Build, test and run iOS apps with xcodebuild: discover projects, list schemes, read the bundle id, parsed build errors (file:line), per-conversation defaults, and build-install-launch on the Simulator in one call.'
triggers:
  - xcodebuild
  - xcode
  - scheme
  - swift app
  - swiftui
  - ios build
  - ios app
  - build my app
  - run my app
  - xcworkspace
  - xcodeproj
  - .app
  - iphone app
  - simulator build
tools:
  - name: xcode_discover
    readOnly: true
    description: 'FIRST call for any iOS work: scan the working folder (depth 3) for Xcode workspaces/projects, Swift packages, Flutter, Expo/React Native and Gradle projects, and get the run path for each. Prefers a .xcworkspace over the .xcodeproj next to it. Pass the working folder — it does not guess.'
    parameters:
      folder:
        type: string
        description: Absolute path of the folder to scan (the working folder)
  - name: xcode_schemes
    readOnly: true
    description: 'List the schemes (plus targets and configurations for a project) of a .xcodeproj or .xcworkspace via xcodebuild -list. Pick the app scheme (not a test, Pods or framework scheme) and store it with xcode_defaults.'
    parameters:
      project:
        type: string
        required: false
        description: Path to the .xcworkspace or .xcodeproj (default the xcode_defaults project)
  - name: xcode_bundle_id
    readOnly: true
    description: 'Read PRODUCT_BUNDLE_IDENTIFIER, FULL_PRODUCT_NAME and the build dirs for a scheme from xcodebuild -showBuildSettings (cached 10 min). xcode_run resolves this itself — call it only when you need the bundle id for mobile_launch / mobile_log.'
    parameters:
      project:
        type: string
        required: false
        description: Path to the .xcworkspace or .xcodeproj (default the xcode_defaults project)
      scheme:
        type: string
        required: false
        description: Scheme name (default the xcode_defaults scheme)
      configuration:
        type: string
        required: false
        description: Debug (default) or Release
  - name: xcode_defaults
    description: 'Set once per conversation, then every xcode_* tool uses these when an argument is omitted: project, scheme, configuration, device. With no arguments it shows the current defaults. clear=true forgets them. A build without a known project or scheme fails with MISSING_DEFAULTS — set them here instead of repeating them on every call.'
    parameters:
      project:
        type: string
        required: false
        description: Path to the .xcworkspace or .xcodeproj (from xcode_discover)
      scheme:
        type: string
        required: false
        description: The app scheme (from xcode_schemes)
      configuration:
        type: string
        required: false
        description: Debug (default) or Release
      device:
        type: string
        required: false
        description: Simulator udid or exact name (e.g. "iPhone 17 Pro"); omitted = the booted simulator at run time
      clear:
        type: boolean
        required: false
        description: true forgets the defaults for this conversation
  - name: xcode_build
    description: 'Build a scheme for the iOS Simulator with xcodebuild (derived data under the workspace; 20 min cap; killed with BUILD_STALLED after 5 min of silence). Success is the exit code. On failure you get up to 25 deduped errors as file:line: message plus the log path — fix them and build again. Prefer xcode_run when the goal is to see the app; use this when you only need the build to pass or the .app path.'
    parameters:
      project:
        type: string
        required: false
        description: .xcworkspace or .xcodeproj (default from xcode_defaults)
      scheme:
        type: string
        required: false
        description: Scheme (default from xcode_defaults)
      configuration:
        type: string
        required: false
        description: Debug (default) or Release
      device:
        type: string
        required: false
        description: Simulator udid or name for the destination; omitted = generic iOS Simulator
      clean:
        type: boolean
        required: false
        description: true runs clean build (slow; only after mysterious stale-build errors)
  - name: xcode_test
    description: 'Run a scheme''s tests on the iOS Simulator (xcodebuild test; 30 min cap, same stall watchdog). Returns passed/failed/skipped counts, up to 25 failures as Suite.test: message (file:line), and the log path. Narrow with only (e.g. "MyAppTests/LoginTests" or "MyAppTests/LoginTests/testEmpty", comma-separated for several) to iterate on one failing test fast.'
    parameters:
      project:
        type: string
        required: false
        description: .xcworkspace or .xcodeproj (default from xcode_defaults)
      scheme:
        type: string
        required: false
        description: Scheme (default from xcode_defaults)
      configuration:
        type: string
        required: false
        description: Debug (default) or Release
      device:
        type: string
        required: false
        description: Simulator udid or name; omitted = the xcode_defaults device or generic
      only:
        type: string
        required: false
        description: '-only-testing selector(s): Target/Class or Target/Class/test, comma-separated'
      skip:
        type: string
        required: false
        description: '-skip-testing selector(s), same shape as only'
  - name: xcode_run
    description: 'The one call to see the app: build the scheme, boot the simulator if needed, install the .app and launch it (terminating a running copy) — returns the pid, the app path and the bundle id. Prefer this over chaining xcode_build + mobile_install + mobile_launch. A failure names its step (BUILD_FAILED with parsed file:line errors, BOOT_FAILED, INSTALL_FAILED, LAUNCH_FAILED). Then mobile_use + mobile_screenshot to look at it.'
    parameters:
      project:
        type: string
        required: false
        description: .xcworkspace or .xcodeproj (default from xcode_defaults)
      scheme:
        type: string
        required: false
        description: Scheme (default from xcode_defaults)
      configuration:
        type: string
        required: false
        description: Debug (default) or Release
      device:
        type: string
        required: false
        description: Simulator udid or exact name; omitted = the xcode_defaults device, else the booted simulator
      bundle_id:
        type: string
        required: false
        description: Bundle identifier to launch; omitted = read from the build settings
      clean:
        type: boolean
        required: false
        description: true runs clean build first
requires: []
confirm_patterns: []
---

# Xcode

Build, test and run an iOS app the way a developer does from the terminal, with
the output parsed so a failing build reads as `File.swift:42: message` rather than
a thousand lines of log.

## How to use

1. `xcode_discover folder=<working folder>` — finds the `.xcworkspace` / `.xcodeproj`
   (and tells you when the project is Flutter, Expo, React Native or Gradle instead,
   with the run path for each).
2. `xcode_schemes project=<path>` — pick the app scheme.
3. `xcode_defaults {project, scheme, device}` once. Every later call uses them.
4. `xcode_run` — build, boot, install, launch. Then look at it with the `mobile`
   capability (`mobile_use device=<udid>`, `mobile_indicator_on`, `mobile_screenshot`,
   `mobile_log`).
5. Fix what `BUILD_FAILED` lists (deduped `file:line: message`, first 25) and run again.
   `xcode_test only=Target/Class/test` iterates on one test.

## Where things land

- Derived data: `<workspace>/files/derived-data/<scheme>/` (the `.app` under
  `Build/Products/<Configuration>-iphonesimulator/`).
- Full xcodebuild logs: `<workspace>/files/xcode/logs/<build|test>-<scheme>-<time>.log`
  — `file_read` the log when the parsed errors are not enough.

## Behaviour worth knowing

- Success is decided by xcodebuild's exit code, never by "BUILD SUCCEEDED" in the log.
- Builds are capped at 20 minutes (tests 30) and killed with `BUILD_STALLED` after
  5 minutes without output. Stopping the run kills xcodebuild.
- A `device` that looks like a UUID is passed as `id=`; anything else as `name=`.
- Bundle ids are cached for 10 minutes per (project, scheme, configuration).
