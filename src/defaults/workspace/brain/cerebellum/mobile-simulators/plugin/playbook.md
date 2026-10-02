# Mobile playbook — run it, look at it, touch it, prove it

The loop that verifies a mobile app the way a developer does. One vocabulary for both platforms: a device is a device.

## 0. Pick the device once
- `mobile_devices` lists iOS simulators (booted first), Android emulators/devices, and AVDs you can boot.
- `mobile_boot device=<name|udid|AVD>` boots it (state machine: Booting waits, Shutting Down waits then boots). No device named: the first iPhone, else the first AVD.
- `mobile_use device=...` makes it the active device for this conversation; every other tool then needs no `device`.
- `mobile_doctor` when anything is missing (Xcode, runtimes, AXe, adb, emulator, permissions).

## 1. Get the app on it
- iOS from source: `xcode_discover folder=<working folder>` → `xcode_defaults scheme=... project=... device=...` → `xcode_run` (build, install, launch with logs, in one call; errors come back parsed as file:line).
- iOS from a built `.app`: `mobile_install app=<path>` → `mobile_launch bundle_id=<id>`.
- Android: `./gradlew assembleDebug` through `shell_exec` (background for long builds) → `mobile_install app=<apk>` → `mobile_launch bundle_id=<package>`.
- Flutter / React Native / Expo: run the framework's own command through `shell_exec background=true` (`flutter run -d <udid>`, `npx expo run:ios`, `npx react-native run-android`), then drive the running app with the tools below.
- `mobile_launch` captures the app's stdout/stderr and os_log (iOS) or a per-pid logcat (Android) into files from the moment it starts; `mobile_log` reads them. No start/stop calls.

## 2. Turn the indicator on
- `mobile_indicator_on` is the FIRST call of any session that looks at or touches the screen. The user sees a blue frame around the simulator window and "Wolffish is driving iPhone 16 Pro"; every touch ripples there.
- Seeing and touching tools refuse to run while it is off. Lifecycle, build and log tools do not need it.
- `mobile_indicator_off` is the LAST call, whether you finished, gave up, or are handing back. Nothing else clears it.

## 3. See before you touch
- `mobile_snapshot` first: the accessibility tree as one line per element with a ref (`@e7 Button "Sign in" center=302,662 size=180x44`). It is cheaper and more precise than pixels. `marker=` narrows to elements whose label/text/id contains a word. `since=<hash>` returns "unchanged" cheaply.
- `mobile_screenshot` when you need pixels: canvas, maps, games, images, colours, layout. It becomes the current frame.
- `mobile_zoom x= y=` on a small target before tapping it when the screenshot is compressed (the result says so).
- `mobile_wait_for condition=exists|gone|focused|text|settled marker=...` instead of guessing delays. Mobile UIs animate: if the element is not there yet, wait, do not tap blind.

## 4. Touch by ref, then read the proof
- `mobile_tap ref=e7` taps the element's center (semantic selector first on iOS). Coordinates (`x= y=`) are ALWAYS pixels of the latest image you received — never device points, never a guess from an older image.
- Every touch returns: whether the screen changed, and a magnifier patch with a crosshair on the exact point. That patch is the new frame. If it says "Changed: NO", the tap missed or the app ignored it: re-aim from a fresh snapshot, do not repeat.
- `mobile_type text=... ref=e3` taps the field first, then types (`submit=true` presses Enter). Non-ASCII text goes through the pasteboard on iOS and the ADB Keyboard IME on Android when it is installed; the result tells you which.
- `mobile_swipe direction=up` scrolls from the screen center; `x= y=` or `ref=` to start elsewhere; `to_x= to_y=` for a precise gesture. A swipe starting within 4 pt of an edge is an OS edge gesture (back, Control Center, notifications) — use `mobile_button` for home/back/app_switch instead.
- `mobile_long_press`, `mobile_drag`, `mobile_key key=enter|backspace|cmd+a|back`, `mobile_button button=home|back|lock|siri`.
- `mobile_batch steps=[...]` for a sure sequence (fill a form) with one verification at the end; it stops at the first failure.
- Pass `expect="the login screen appears"` on an action and check that expectation on the proof before planning the next step.

## 5. Prove it and deliver
- Screenshot the milestone and `send_file` the saved path when the user should see it (tool images are for you; the person sees only delivered files).
- `mobile_record action=start` … `action=stop` for a short video of a flow; deliver the mp4.
- Crashes and print/log output: `mobile_log` (filter=…). Read the END of it.
- `mobile_push`, `mobile_location`, `mobile_privacy`, `mobile_appearance`, `mobile_status_bar`, `mobile_orientation` set up the scenario (a dark-mode screenshot, a permission dialog, a deep link with `mobile_open_url`).

## 6. Leave it tidy
- Stop an emulator you started when the task is done unless the user wants it running: `mobile_shutdown`.
- `mobile_indicator_off` last. Always.

## Typed errors you will see
`NO_DEVICE`, `NOT_BOOTED`, `APP_NOT_INSTALLED`, `SNAPSHOT_MISSING`, `SNAPSHOT_EXPIRED`, `REF_NOT_FOUND`, `FRAME_MISSING`, `OUT_OF_FRAME`, `WAIT_TIMEOUT`, `CHARSET_UNSUPPORTED`, `AXE_UNAVAILABLE`, `INDICATOR_REQUIRED`, `UNSUPPORTED`. Each names the call that fixes it. Do not retry the same call; make that call.
