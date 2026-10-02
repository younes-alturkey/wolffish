---
name: mobile-simulators
description: Drive iOS simulators and Android emulators or devices with one vocabulary — boot, install, launch with logs, read the accessibility tree, tap/swipe/type by ref with proof on every touch, screenshots, video, push/location/permissions — under a driving indicator the user sees on the device window.
triggers:
  - simulator
  - ios simulator
  - xcrun
  - simctl
  - iphone
  - ipad
  - swift app
  - swiftui
  - flutter run
  - react native
  - expo
  - emulator
  - android emulator
  - adb
  - apk
  - android app
  - run my app
  - test on iphone
  - test on android
  - tap the button
  - screenshot the app
  - mobile app
  - accessibility tree
  - uiautomator
  - axe
tools:
  - name: mobile_devices
    readOnly: true
    description: 'List iOS simulators (booted first), Android emulators/devices, the AVDs that can be booted, and which device is active for this conversation. Call it first when you do not know what is available.'
    parameters: {}
  - name: mobile_use
    readOnly: true
    description: 'Make one device the active device for this conversation so every other mobile_* tool can omit `device`. Accepts a udid, an adb serial, or a name substring ("iPhone 16 Pro", "Dev_Phone").'
    parameters:
      device:
        type: string
        description: udid, serial, or name substring from mobile_devices
  - name: mobile_boot
    description: 'Boot a device and make it active: an iOS simulator by name or udid (waits for the boot to finish; a device that is Booting or Shutting Down is waited on), or an Android AVD by name (starts the emulator, waits for boot_completed, up to 4 minutes). With no device: the first iPhone, else the first AVD. Next: mobile_indicator_on.'
    parameters:
      device:
        type: string
        required: false
        description: simulator name/udid, or an AVD name from mobile_devices
      cold_boot:
        type: boolean
        required: false
        description: 'Android: ignore the saved snapshot and boot cold'
      headless:
        type: boolean
        required: false
        description: do not show the simulator/emulator window (the driving indicator then has nothing to frame)
  - name: mobile_shutdown
    description: Shut down an iOS simulator or stop an Android emulator (including one Wolffish started). Takes the driving indicator down with it.
    parameters:
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_erase
    description: Erase an iOS simulator to factory settings (shuts it down first). Destructive — all apps and data on that simulator are gone.
    parameters:
      device:
        type: string
        required: false
        description: udid or name; default the active device
  - name: mobile_apps
    readOnly: true
    description: List installed apps (bundle ids on iOS, package names on Android). User apps by default; all=true includes system apps.
    parameters:
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
      all:
        type: boolean
        required: false
        description: include system apps
  - name: mobile_install
    description: Install a built app — a `.app` bundle on an iOS simulator (xcode_build returns its path) or an `.apk` on Android (./gradlew assembleDebug writes one). Next, mobile_launch it.
    parameters:
      app:
        type: string
        description: absolute path to the .app bundle or .apk
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_uninstall
    description: Uninstall an app by bundle id (iOS) or package name (Android). Its data goes with it.
    parameters:
      bundle_id:
        type: string
        description: e.g. com.example.MyApp
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_launch
    description: 'Launch an app (restarting it if running) and capture its output from the first line: stdout/stderr and os_log on iOS, a per-process logcat on Android, written to files that mobile_log reads. No start/stop calls needed. Then mobile_indicator_on and mobile_snapshot to see it.'
    parameters:
      bundle_id:
        type: string
        description: the iOS bundle id (xcode_bundle_id) or the Android package name
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
      no_logs:
        type: boolean
        required: false
        description: launch without log capture
  - name: mobile_terminate
    description: Stop a running app (and its log capture).
    parameters:
      bundle_id:
        type: string
        required: false
        description: default the app last launched here
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_open_url
    description: Open a URL or deep link (https://…, myapp://…) on the device — the way to test universal links and custom schemes.
    parameters:
      url:
        type: string
        description: the URL to open
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_screenshot
    readOnly: true
    description: 'See the screen as pixels (downscaled, attached for this turn, saved under files/screenshots/). The image becomes the CURRENT FRAME: every x/y you give to mobile_tap, mobile_swipe, mobile_drag or mobile_zoom is a pixel of the latest image you received — never device points, never a guess from an older image. Prefer mobile_snapshot for finding controls; use this for layout, colours, canvas and images. Needs mobile_indicator_on. send_file the saved path when the user should see it.'
    parameters:
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
      max_dimension:
        type: integer
        required: false
        description: long edge of the returned image in pixels (default 1024)
  - name: mobile_zoom
    readOnly: true
    description: 'A fresh native-resolution close-up of a region of the current frame (up to 4x), centered on x,y in pixels of the latest image. It becomes the new frame — tap small targets inside it. Use when a screenshot reports it is compressed or a target is small. Needs mobile_indicator_on.'
    parameters:
      x:
        type: number
        description: center X in pixels of the latest image
      y:
        type: number
        description: center Y in pixels of the latest image
      width:
        type: integer
        required: false
        description: region width in pixels of the latest image (default a third of it)
      height:
        type: integer
        required: false
        description: region height in pixels of the latest image (default a third of it)
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_snapshot
    readOnly: true
    description: 'Read the screen as the accessibility tree — one line per element with a ref: `@e7 Button "Sign in" center=302,662 size=180x44 [focused]`. Cheaper and more precise than pixels: call it BEFORE touching, then mobile_tap ref=e7. center/size are in the current frame''s pixels so refs and coordinates share one space. marker= keeps only elements whose label/text/id/type contains the word; since=<screen hash from the last snapshot> returns "unchanged" cheaply. Refs expire after any action or 60 s. Needs mobile_indicator_on.'
    parameters:
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
      marker:
        type: string
        required: false
        description: substring of a label, text, id or type to narrow the list
      since:
        type: string
        required: false
        description: the screen hash from the previous snapshot; returns "unchanged" when it still matches
  - name: mobile_wait_for
    readOnly: true
    description: 'Wait until the UI reaches a state instead of guessing delays: condition=exists|gone|focused|text with marker=<label/text/id substring>, or condition=settled (the screen stopped changing for 500 ms). Returns the matching elements with fresh refs. Default 5 s, polled every 250 ms. Needs mobile_indicator_on.'
    parameters:
      condition:
        type: string
        enum: [exists, gone, focused, text, settled]
        description: what to wait for
      marker:
        type: string
        required: false
        description: substring to match (required unless condition=settled)
      timeout_ms:
        type: integer
        required: false
        description: how long to wait (default 5000, max 60000)
      interval_ms:
        type: integer
        required: false
        description: poll interval (default 250)
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_tap
    description: 'Tap an element by ref from the latest mobile_snapshot (preferred — on iOS a unique id/label is used as a semantic selector), or a point x,y in pixels of the latest image. Returns proof: whether the screen changed and a magnifier patch with a crosshair on the exact point, which becomes the new frame. "Changed: NO" means re-aim from a fresh snapshot, not repeat. Pass expect= to state what should happen so you verify it next. Needs mobile_indicator_on.'
    parameters:
      ref:
        type: string
        required: false
        description: element ref from mobile_snapshot, e.g. e7
      x:
        type: number
        required: false
        description: X in pixels of the latest image (when no ref)
      y:
        type: number
        required: false
        description: Y in pixels of the latest image (when no ref)
      expect:
        type: string
        required: false
        description: what you expect to happen, in a few words
      settle_ms:
        type: integer
        required: false
        description: wait before the proof capture (default 350)
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_long_press
    description: Press and hold an element (ref) or a point (x,y in pixels of the latest image) for duration_ms (default 800). Same proof as mobile_tap. Needs mobile_indicator_on.
    parameters:
      ref:
        type: string
        required: false
        description: element ref from mobile_snapshot
      x:
        type: number
        required: false
        description: X in pixels of the latest image
      y:
        type: number
        required: false
        description: Y in pixels of the latest image
      duration_ms:
        type: integer
        required: false
        description: hold time (default 800)
      expect:
        type: string
        required: false
        description: what you expect to happen
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_swipe
    description: 'Swipe/scroll: direction=up|down|left|right from the screen center (or from ref= / x,y in pixels of the latest image), distance= in pixels of the latest image (default 40% of the screen), or an explicit end with to_x/to_y. A swipe that starts within 4 pt of a screen edge is an OS edge gesture (back, Control Center, notifications); use mobile_button for home/back. Returns change proof and a patch. Needs mobile_indicator_on.'
    parameters:
      direction:
        type: string
        required: false
        enum: [up, down, left, right]
        description: swipe direction (content moves the opposite way when scrolling)
      ref:
        type: string
        required: false
        description: start on this element
      x:
        type: number
        required: false
        description: start X in pixels of the latest image
      y:
        type: number
        required: false
        description: start Y in pixels of the latest image
      to_x:
        type: number
        required: false
        description: end X in pixels of the latest image (instead of direction)
      to_y:
        type: number
        required: false
        description: end Y in pixels of the latest image
      distance:
        type: number
        required: false
        description: swipe length in pixels of the latest image
      duration_ms:
        type: integer
        required: false
        description: gesture duration (default 300; longer = slower, more like a drag)
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_drag
    description: Drag from an element (ref) or point (x,y) to another element (to_ref) or point (to_x,to_y), pixels of the latest image, over duration_ms (default 800) — reordering, sliders, drag-and-drop. Needs mobile_indicator_on.
    parameters:
      ref:
        type: string
        required: false
        description: start element
      x:
        type: number
        required: false
        description: start X in pixels of the latest image
      y:
        type: number
        required: false
        description: start Y in pixels of the latest image
      to_ref:
        type: string
        required: false
        description: end element
      to_x:
        type: number
        required: false
        description: end X in pixels of the latest image
      to_y:
        type: number
        required: false
        description: end Y in pixels of the latest image
      duration_ms:
        type: integer
        required: false
        description: drag duration (default 800)
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_type
    description: 'Type text into the focused field; with ref= the field is tapped first. submit=true presses Enter after. ASCII goes in as keystrokes; other scripts (Arabic, emoji) go through the simulator pasteboard on iOS and the ADB Keyboard IME on Android when it is installed (the result says which, or returns CHARSET_UNSUPPORTED with the fix). Never types passwords the user did not give you. Needs mobile_indicator_on.'
    parameters:
      text:
        type: string
        description: the text to type
      ref:
        type: string
        required: false
        description: the field to tap first (from mobile_snapshot)
      submit:
        type: boolean
        required: false
        description: press Enter afterwards
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_key
    description: 'Press a key: enter, backspace, delete, tab, space, escape, up/down/left/right, a letter or digit, or a combo like cmd+a (iOS) / ctrl+a (Android). Android also: back, home, menu, app_switch, search, volume_up/down, or any KEYCODE_* name. Needs mobile_indicator_on.'
    parameters:
      key:
        type: string
        description: key name or combo
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_button
    description: 'Press a hardware button: iOS home, lock, siri, side, apple_pay; Android home, back, app_switch, power, volume_up, volume_down, menu. Needs mobile_indicator_on.'
    parameters:
      button:
        type: string
        description: button name
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_batch
    description: 'Run a sure sequence of touch steps in one call (fill a form: tap field, type, tap next field, type, tap submit) with one verification at the end; stops at the first failure. Steps are {tool, args} using mobile_tap, mobile_long_press, mobile_swipe, mobile_drag, mobile_type, mobile_key, mobile_button, mobile_wait_for. Refs must all come from the same snapshot only if no step changes the screen; otherwise use coordinates or wait_for between them. Needs mobile_indicator_on.'
    parameters:
      steps:
        type: array
        description: ordered steps
        items:
          type: object
          properties:
            tool:
              type: string
            args:
              type: object
          required: [tool]
      stop_on_error:
        type: boolean
        required: false
        description: stop at the first failed step (default true)
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_indicator_on
    readOnly: true
    description: 'Show the driving indicator: a blue frame around the device window and the notice "Wolffish is driving <device>", with a ripple at every touch. Call it FIRST in any session that looks at or touches the screen — seeing and touching tools refuse to run until it is up (build, lifecycle and log tools do not need it). If it cannot be shown, the tools are unblocked and you tell the user.'
    parameters:
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_indicator_off
    readOnly: true
    description: 'Take the driving indicator down. Call it as the LAST action of the session — whether you finished, gave up, or are handing back to the user. Nothing else clears it and there is no timer.'
    parameters: {}
  - name: mobile_location
    description: Set a simulated GPS location (latitude, longitude), or clear=true on iOS to restore the real one. Android emulators only (adb emu geo fix).
    parameters:
      latitude:
        type: number
        required: false
        description: e.g. 37.3349
      longitude:
        type: number
        required: false
        description: e.g. -122.009
      clear:
        type: boolean
        required: false
        description: iOS — clear the simulated location
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_push
    description: 'iOS only: deliver a simulated push notification to an app. payload is the APNs JSON (an object with "aps": {"alert": "…"}).'
    parameters:
      bundle_id:
        type: string
        required: false
        description: default the app last launched here
      payload:
        type: object
        description: 'APNs payload, e.g. {"aps":{"alert":"Hello","badge":1}}'
      device:
        type: string
        required: false
        description: udid or name; default the active device
  - name: mobile_privacy
    description: 'Grant, revoke or reset a permission so the dialog does not block the flow: iOS services location, location-always, contacts, photos, camera-adjacent media-library, microphone, calendar, reminders, motion, siri, all; Android any android.permission.* (e.g. CAMERA, ACCESS_FINE_LOCATION) with a package.'
    parameters:
      action:
        type: string
        enum: [grant, revoke, reset]
        description: what to do
      service:
        type: string
        description: iOS service name or Android permission name
      bundle_id:
        type: string
        required: false
        description: app to apply it to (default the app last launched; required on Android)
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_appearance
    description: Switch the device to light or dark mode (for a dark-mode screenshot).
    parameters:
      mode:
        type: string
        enum: [light, dark]
        description: appearance
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_status_bar
    description: 'Override the status bar for clean screenshots (time "9:41", full battery, wifi/cellular bars), or clear=true to restore it.'
    parameters:
      time:
        type: string
        required: false
        description: e.g. "9:41"
      battery:
        type: integer
        required: false
        description: battery level 0-100
      wifi:
        type: integer
        required: false
        description: iOS wifi bars 0-3
      cellular:
        type: integer
        required: false
        description: iOS cellular bars 0-4
      clear:
        type: boolean
        required: false
        description: remove the overrides
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_orientation
    description: 'Android: rotate to portrait, landscape, portrait-upside-down or landscape-right. iOS simulators cannot be rotated from the command line (the tool says so).'
    parameters:
      mode:
        type: string
        enum: [portrait, landscape, portrait-upside-down, landscape-right]
        description: orientation
      device:
        type: string
        required: false
        description: serial or name; default the active device
  - name: mobile_log
    readOnly: true
    description: 'Read the app''s log: the stdout/stderr and os_log (iOS) or logcat (Android) captured since mobile_launch, tail-biased, optionally filtered by a substring; falls back to the system log of the last N seconds when nothing was captured. Crashes, print/NSLog/Logger output and exceptions show here. Read the end.'
    parameters:
      bundle_id:
        type: string
        required: false
        description: the app (default the app last launched here)
      lines:
        type: integer
        required: false
        description: how many recent lines (default 200)
      seconds:
        type: integer
        required: false
        description: fallback window for the system log (default 60)
      filter:
        type: string
        required: false
        description: keep only lines containing this text
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_record
    description: 'Record the screen to an mp4: action=start, drive the flow, action=stop saves the file (Android stops at 180 s). Deliver it with send_file.'
    parameters:
      action:
        type: string
        enum: [start, stop]
        description: start or stop
      device:
        type: string
        required: false
        description: udid, serial or name; default the active device
  - name: mobile_doctor
    readOnly: true
    description: 'Check this machine: Xcode and runtimes, AXe (the iOS input backend) and its version, adb, emulator and AVDs, the window locator and the permissions the driving indicator needs, the image pipeline, tracked helper processes. Each finding names its fix.'
    parameters: {}
  - name: mobile_playbook
    readOnly: true
    description: 'The run-look-touch-prove procedure for mobile work (iOS, Android, Flutter, React Native, Expo): device choice, getting the app on, the indicator rule, snapshot-before-touch, reading proof, delivering evidence. Read it once at the start of a mobile task.'
    parameters: {}
  - name: axe_check
    readOnly: true
    description: 'Is AXe (the iOS Simulator input and accessibility backend) installed? Returns JSON {installed, version, path, source, pinned}.'
    parameters: {}
  - name: axe_install
    description: 'Install AXe 1.8.0 (MIT, github.com/cameroncooke/AXe) into ~/.wolffish/bin without root: pinned version, checksum-verified download from its GitHub release. Needed once for iOS taps, typing and the accessibility tree; macOS only.'
    parameters: {}
requires: []
confirm_patterns:
  - pattern: '^mobile_erase'
    reason: Erasing a simulator deletes every app and all data on it
  - pattern: '^mobile_uninstall'
    reason: Uninstalling removes the app and its data
danger_patterns:
  - pattern: 'mobile_type.*(sudo|rm -rf|password|passcode)'
    reason: Typing credentials or destructive commands into a device
---

# Mobile simulators

One driver for iOS simulators and Android emulators or devices. The tool
descriptions above carry the contract; `mobile_playbook` returns the full
procedure on demand. Nothing in this body is injected into the prompt.

## The loop

1. `mobile_devices` → `mobile_boot` or `mobile_use` — pick the device once.
2. Get the app on: `xcode_run` (iOS from source), or `mobile_install` +
   `mobile_launch` (a built `.app` or `.apk`). Launch captures logs from the
   first line; `mobile_log` reads them.
3. `mobile_indicator_on` — the user sees a blue frame around the device window
   and "Wolffish is driving iPhone 16 Pro". Seeing and touching tools refuse to
   run until it is up.
4. `mobile_snapshot` → `mobile_tap ref=e7` → read the proof (changed? magnifier
   patch) → `mobile_snapshot` again. `mobile_screenshot` for pixels,
   `mobile_zoom` for small targets, `mobile_wait_for` instead of sleeps.
5. Screenshot the milestone and `send_file` it; `mobile_record` for a flow.
6. `mobile_indicator_off` last.

## Contracts

- **Frame**: coordinates the model gives are always pixels of the latest
  image it received (screenshot, zoom, or the magnifier patch after an
  action). The plugin owns every translation to device points (iOS) or
  pixels (Android). A text-only snapshot with no prior image establishes a
  native frame so refs and coordinates still share one space.
- **Refs**: `e12` handles into one snapshot; they expire after any action or
  60 s. A stale ref is a typed error with the repair call, never a mis-tap.
- **Proof**: every touch returns a change flag (greyscale diff before/after,
  whole screen and near the point) and a 480×300 magnifier patch at 2 px per
  device unit with a crosshair on the exact point; the patch becomes the frame.
- **Indicator**: model-owned lifecycle mirroring computer-use — on first,
  off last; the Agent's guard carries the tail notice, the turn-end nudge and
  the failsafe. A machine that cannot draw it does not lose driving.
- **Errors**: `NO_DEVICE`, `NOT_BOOTED`, `APP_NOT_INSTALLED`, `SNAPSHOT_*`,
  `REF_NOT_FOUND`, `FRAME_MISSING`, `OUT_OF_FRAME`, `WAIT_TIMEOUT`,
  `CHARSET_UNSUPPORTED`, `AXE_UNAVAILABLE`, `INDICATOR_REQUIRED`,
  `UNSUPPORTED` — each with the call that fixes it, `retryable: false`.

## Backends

- iOS: `simctl` for lifecycle, screenshots, video, URLs, pasteboard,
  location, push, privacy, appearance, status bar; **AXe** (pinned 1.8.0,
  managed download into `~/.wolffish/bin/axe/`) for the accessibility tree
  and every touch and key. `simctl` has no input injection.
- Android: `adb` for everything — `uiautomator dump` for the tree,
  `input tap|swipe|text|keyevent`, `screencap`, `logcat --pid`,
  `screenrecord`; `emulator -avd` to boot an AVD with a `boot_completed`
  poll. Works on macOS, Windows and Linux.
- The driving indicator locates the device window through a compiled
  CGWindowList helper (macOS, swiftc on first use) with System Events as the
  fallback, user32 on Windows, xdotool on Linux.

## Files

- Screenshots and recordings: `files/screenshots/`.
- App logs and emulator logs: `files/mobile/logs/`.
- Helper-process registry (log streams, emulators, recordings), swept on
  every plugin load: `files/mobile/helpers/`.
