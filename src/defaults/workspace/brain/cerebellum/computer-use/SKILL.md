---
name: computer-use
description: "Everything that is not a web page — the screen itself: native apps, OS dialogs, browser chrome. Verified-aim clicks that return evidence, accessibility-tree find, native-resolution zoom, typing, menus, scrolling, drag, batches, a shadow cursor so the user keeps their own mouse. An approval per action."
triggers:
  - screen
  - desktop
  - open app
  - scroll
  - type into
  - mouse
  - keyboard
  - what's on my screen
  - computer use
  - UI
  - display
  - monitor
  - window
  - application
  - app
  - cursor
  - pointer
  - drag
  - drop
  - menu
  - toolbar
  - icon
  - taskbar
  - dock
  - finder
  - right click
  - double click
  - hotkey
  - shortcut
  - press key
  - enter text
  - what do you see
  - show me
  - look at screen
  - visual
  - GUI
  - interface
  - native app
  - system tray
  - notification center
  - control panel
  - system preferences
  - spotlight
  - launchpad
  - activity monitor
  - task manager
  - file explorer
  - terminal app
  - text editor
  - fullscreen
  - minimize
  - maximize
  - resize window
  - switch window
  - alt tab
  - cmd tab
  - copy paste
  - undo redo
  - select all
  - right click menu
  - context menu
  - pixel
  - coordinate
  - position
  - zoom in
  - magnify
  - what is on screen
  - see my screen
  - look at my screen
  - interact with desktop
  - control my computer
  - click on
  - move mouse to
requires:
  - node
tools:
  - name: computer_glow_on
    description: 'Turn ON the screen indicator: a blue glow along the display''s edges, a centered translucent notice telling the user their screen is being captured and controlled, and a SHADOW CURSOR that glides to wherever you act (the user''s own pointer stays theirs). CRITICAL: this MUST be your FIRST action in every computer-use session — before the first capture — and it is enforced, not just asked: every capture and input tool REFUSES to run until the indicator is on and tells you to call this, so forgetting costs a wasted round-trip. It also runs an access check and reports any missing permission with its exact fix (call computer_check_access for the full report). Once on, the indicator follows your actions across displays and stays on until computer_glow_off. It is invisible in screenshots and never blocks clicks.'
    parameters:
      display_index:
        type: number
        required: false
        description: 'Display to show the indicator on first (default 0 = primary). It follows your captures and actions to other displays automatically.'
  - name: computer_glow_off
    description: 'Turn OFF the screen indicator. CRITICAL: this MUST be your LAST action when you finish controlling the screen — and equally when you give up, hit an error you cannot recover from, or hand back to the user so they can do something. Nothing clears the indicator for you and there is no timer: while it is up, the user is being told their screen is still being watched. Ending your turn is finishing — a turn that ends with the indicator still on is handed straight back to you to close it, so the only thing skipping this buys is a wasted round-trip and a user who was lied to in the meantime. On = first action, off = last action, every session, no exceptions.'
    parameters: {}
  - name: computer_check_access
    readOnly: true
    description: 'What this machine lets Wolffish see and control, per operating system: on macOS the Accessibility and Screen Recording grants; on Linux the display server (X11 or Wayland and which compositor), the virtual input device and the accessibility bus; on Windows elevation limits; on every OS whether the background input driver loaded (pointer-free input) and whether the indicator can be drawn. Every missing item names what it blocks, the exact settings path or command, and whether a restart is needed. Call it at the start of a session when in doubt, and ALWAYS when a capture or input tool fails with a permission-shaped error — then stop retrying, tell the user the exact fix (use ask_user so they can say when it is done), finish any part of the task that does not need the screen, and continue when they confirm. Pass request: true on macOS to trigger the system prompts before reporting.'
    parameters:
      request:
        type: boolean
        required: false
        description: 'Trigger the operating system''s permission prompts (macOS) before reporting'
  - name: computer_screenshot
    readOnly: true
    description: 'See a whole display. If the screen indicator is not on yet, call computer_glow_on FIRST — it must precede the first capture of every session, and this tool refuses to run until it does. Captures the chosen display (default 0 = primary) and returns the image plus a Frame line stating its exact pixel size and the aim point (marked with a magenta crosshair). This image becomes the CURRENT FRAME. Every mouse coordinate you give afterwards must be a pixel position read from the current frame, with (0,0) at its top-left — translation to real screen position (display scaling, Retina, monitor offsets) is fully automatic. Screenshot again whenever the screen may have changed; acting on an outdated image is the main cause of wrong clicks. When you know which window you are working in, prefer computer_window_screenshot: it captures that window even when covered and shows less of the user''s screen. If the target is small, crowded, or you are not certain of its exact position, do not guess: find it by name with computer_find, or zoom into it with computer_zoom first. If this tool ever reports that its image was omitted because the active model cannot view images, computer use is impossible — stop and tell the user to switch to a vision-capable model. CAPTURE QUALITY IS YOURS TO SET per capture through max_width and format — there is no user setting for either. Default 1280/jpeg for ordinary navigation; go to 1920-2560 and/or png the moment detail decides the outcome. Neither setting sticks — pass it again on every capture that needs it.'
    parameters:
      display_index:
        type: number
        required: false
        description: 'Index of the display to capture (default 0 = primary). Use computer_list_displays to see all of them.'
      max_width:
        type: number
        required: false
        description: 'Width cap in pixels for THIS capture only (480-2560; default 1280). RAISE to 1920-2560 when: the user asked for a high-resolution or detailed screenshot; you must read dense text, code, a terminal, a document or a table across the whole screen at once; or you are judging fine visual detail. LOWER to 640-960 only for long repetitive loops tracking coarse layout. Tokens scale with area. The value does not persist.'
      format:
        type: string
        required: false
        enum:
          - jpeg
          - png
        description: 'Image format for THIS capture only (default jpeg). Use png whenever JPEG artifacts could corrupt what you must read or judge — text-heavy screens, code, terminals, small UI labels, thin lines, exact colors. A full-screen PNG above ~1280px usually exceeds the per-image byte budget and is then delivered as JPEG at the width you asked for, with a note. For lossless pixels use computer_zoom. The value does not persist.'
  - name: computer_zoom
    readOnly: true
    description: 'Magnify a rectangular region of the current frame, captured fresh at up to native resolution — the precision instrument for small targets and small text. Pass the region in current-frame pixels; you get back a sharp close-up that becomes the NEW current frame, so you then click using the close-up''s own coordinates. Magnification depends on region size: a NARROW region magnifies a lot, a wide region barely at all — the result states the factor, and if it warns the zoom is weak (under 2x), do not aim at small controls from it: zoom again into the narrower slice it suggests. Recommended flow for any small target: screenshot → locate it roughly → zoom a region around it (for example 300x200) → click its exact pixel in the zoom. Better still, when the app exposes it: computer_find the control by name and computer_click_element it. To act outside the zoomed region, take a fresh capture first.'
    parameters:
      x:
        type: number
        description: 'Left edge of the region, in current-frame pixels'
      y:
        type: number
        description: 'Top edge of the region, in current-frame pixels'
      width:
        type: number
        description: 'Region width in current-frame pixels'
      height:
        type: number
        description: 'Region height in current-frame pixels'
  - name: computer_list_windows
    readOnly: true
    description: 'List the visible windows front to back: app, title, window_id, pid, size, position and display index, with the frontmost app marked. Start here when the task names an app: pick its window, then computer_window_screenshot it (works even when other windows cover it) and computer_find its controls by name. Window ids are what computer_window_screenshot, computer_find, computer_focus_window, computer_menu and computer_wait_for take.'
    parameters:
      app:
        type: string
        required: false
        description: 'Filter by app name or window title substring'
  - name: computer_window_screenshot
    readOnly: true
    description: 'Capture ONE window (pid + window_id from computer_list_windows) at native resolution — it works even when other windows cover it, and it shows less of the user''s screen than a display capture, so prefer it whenever you know the window. The image becomes the current frame, scoped to that window: coordinates you read from it are delivered to that window in the BACKGROUND (the user''s pointer does not move and the window is not raised). The title bar is included at the top of the image. Minimized windows cannot be captured — computer_focus_window restores them. Same max_width and format rules as computer_screenshot. Omit pid and window_id to re-capture the window of the current frame or of your last action.'
    parameters:
      pid:
        type: number
        required: false
        description: 'Process id from computer_list_windows'
      window_id:
        type: number
        required: false
        description: 'Window id from computer_list_windows'
      max_width:
        type: number
        required: false
        description: 'Width cap in pixels for THIS capture only (480-2560; default 1280)'
      format:
        type: string
        required: false
        enum:
          - jpeg
          - png
        description: 'Image format for THIS capture only (default jpeg)'
  - name: computer_find
    readOnly: true
    description: 'Find controls by NAME in a window through the app''s accessibility tree — the second grounding route, and the most reliable one for small or crowded targets: pass text (a label, value, or part of one) and/or role (button, text field, checkbox, menu item, link, tab, …) and get back numbered matches with their role, label, value, enabled state, a token, and their position and CENTER in the current frame''s coordinates. Then click a match with computer_click_element (token — most reliable) or aim at its center with computer_mouse_move. Tokens are bound to the moment of the snapshot: after the window changes, call computer_find again before using one. Native apps expose rich trees; web content (browsers, Electron apps) often exposes only the window chrome — the result says so, and then you fall back to pixels or the browser tools. When the target is a web page in a browser the Wolffish extension is connected to, prefer the ext_* tools for reading, typing and clicking inside the page, and stay in computer use for the browser''s chrome, dialogs and file pickers around it. Omit pid and window_id to search the window of the current frame or of your last action.'
    parameters:
      pid:
        type: number
        required: false
        description: 'Process id from computer_list_windows'
      window_id:
        type: number
        required: false
        description: 'Window id from computer_list_windows'
      text:
        type: string
        required: false
        description: 'Label, value, or part of one (case-insensitive)'
      role:
        type: string
        required: false
        description: 'button, text field, checkbox, radio button, menu item, link, tab, slider, dropdown, …'
      max_results:
        type: number
        required: false
        description: 'Cap on returned matches (default 25)'
  - name: computer_read_element
    readOnly: true
    description: 'Read one control''s current value, label and state (enabled, selected, available actions) by token from computer_find, or by text/role. The way to read what a field contains without a screenshot, and to verify that typing or set_value landed.'
    parameters:
      pid:
        type: number
        required: false
        description: 'Process id from computer_list_windows'
      window_id:
        type: number
        required: false
        description: 'Window id from computer_list_windows'
      token:
        type: string
        required: false
        description: 'Token from computer_find'
      text:
        type: string
        required: false
        description: 'Or find the element by text'
      role:
        type: string
        required: false
        description: 'Or by role'
  - name: computer_window_state
    readOnly: true
    description: 'The full element tree of one window as an outline plus every element with a frame, in current-frame coordinates. Large; use computer_find for everyday targeting and this only when you need to understand an unfamiliar window''s whole structure.'
    parameters:
      pid:
        type: number
        required: false
        description: 'Process id from computer_list_windows'
      window_id:
        type: number
        required: false
        description: 'Window id from computer_list_windows'
      max_elements:
        type: number
        required: false
        description: 'Cap on elements (default 400)'
      max_depth:
        type: number
        required: false
        description: 'Depth cap (default 14)'
  - name: computer_click_element
    description: 'Click a control by its token from computer_find, through the accessibility route — the most reliable click there is: no pixel aim, delivered in the BACKGROUND (pointer untouched, window not raised), and the result carries an evidence line (delivery rung, effect, screen change) plus a magnifier of the element. If the token is stale (the window changed) the result says so: call computer_find again. Pass target (what it is) and expect (what should happen) so the next step can verify it.'
    parameters:
      pid:
        type: number
        required: false
        description: 'Process id from computer_list_windows'
      window_id:
        type: number
        required: false
        description: 'Window id from computer_list_windows'
      token:
        type: string
        description: 'Token from computer_find'
      button:
        type: string
        required: false
        enum:
          - left
          - right
          - middle
        description: 'Mouse button (default left)'
      count:
        type: number
        required: false
        description: 'Clicks: 1 (default), 2 (double), 3 (triple)'
      double:
        type: boolean
        required: false
        description: 'Double-click instead of single click'
      target:
        type: string
        required: false
        description: 'What you are clicking, as a short phrase — echoed back for verification'
      expect:
        type: string
        required: false
        description: 'What should happen right after (e.g. ''the dialog closes'') — carried into your next step so you verify it'
      delivery:
        type: string
        required: false
        enum:
          - auto
          - background
          - foreground
        description: 'auto (default): background first, foreground if the app refuses. background: refuse rather than move the pointer. foreground: activate the window (brief flash), pointer restored.'
  - name: computer_set_value
    description: 'Write a field''s value directly through the accessibility API, with readback proof — the most reliable way to fill a text field in a native app (no focus needed, no keystrokes). Pick the field by token from computer_find or by text/role. When the app does not support direct writes the tool falls back to click + select all + type and says so. Password fields are refused unless the user gave that secret in this conversation (allow_secret: true).'
    parameters:
      pid:
        type: number
        required: false
        description: 'Process id from computer_list_windows'
      window_id:
        type: number
        required: false
        description: 'Window id from computer_list_windows'
      token:
        type: string
        required: false
        description: 'Token from computer_find'
      text:
        type: string
        required: false
        description: 'Or find the field by text'
      role:
        type: string
        required: false
        description: 'Or by role'
      value:
        type: string
        description: 'The new value'
      allow_secret:
        type: boolean
        required: false
        description: 'The user explicitly gave this secret in the current conversation'
  - name: computer_focus_window
    description: 'Bring a window to the front (restores it if minimized) — without moving the user''s pointer where the driver allows. Keys and typing then go to it. Use it when a window is minimized or on another space, or when the app only reacts to input while frontmost (the evidence line tells you when a background delivery was refused).'
    parameters:
      pid:
        type: number
        required: false
        description: 'Process id from computer_list_windows'
      window_id:
        type: number
        required: false
        description: 'Window id from computer_list_windows'
  - name: computer_menu
    description: 'Invoke an application menu path through the accessibility API, e.g. ["File", "Save As…"] — exact labels from the top level down, no pointer movement, fail-closed when a label is missing or ambiguous. Use it for anything the menu bar offers (open, save, export, preferences) instead of aiming at tiny menu items.'
    parameters:
      pid:
        type: number
        required: false
        description: 'Process id from computer_list_windows'
      window_id:
        type: number
        required: false
        description: 'Window id from computer_list_windows'
      path:
        type: array
        description: 'Menu labels from the top level down, e.g. ["File", "Save"]'
        raw:
          type: array
          items:
            type: string
          description: 'Menu labels from the top level down, e.g. ["File", "Save"]'
      expect:
        type: string
        required: false
        description: 'What should happen right after'
  - name: computer_mouse_move
    description: 'Aim without clicking: moves the SHADOW cursor (never the user''s real pointer) to (x, y) in current-frame pixels and returns a magnified close-up with a crosshair and hairlines at that point, plus the element the app reports under it, so you can verify the aim before committing. This is the RELIABLE way to hit tiny targets: aim first, check that the hairlines pass through the target''s center and that the element under the point is the one you meant, then call computer_mouse_click with no coordinates to press that exact point — if the aim is off, aim again using the close-up''s finer coordinates. To trigger hover states (tooltips, hover menus) use computer_hover instead, which moves the real pointer.'
    parameters:
      x:
        type: number
        description: 'X in current-frame pixels'
      y:
        type: number
        description: 'Y in current-frame pixels'
      target:
        type: string
        required: false
        description: 'What you are aiming at, as a short phrase — echoed back and checked against the element under the point'
  - name: computer_hover
    description: 'Move the user''s REAL pointer to (x, y) in current-frame pixels and hold it there — the one tool that touches their pointer — for tooltips, hover menus and hover-only controls. Returns a magnifier; take a computer_screenshot to see what appeared.'
    parameters:
      x:
        type: number
        description: 'X in current-frame pixels'
      y:
        type: number
        description: 'Y in current-frame pixels'
      ms:
        type: number
        required: false
        description: 'How long to hold the pointer there before returning (default 400)'
      target:
        type: string
        required: false
        description: 'What you are hovering, as a short phrase'
  - name: computer_mouse_click
    description: 'Click at (x, y) in CURRENT-FRAME pixels — or omit both to click at the aim point set by computer_mouse_move. Delivery is BACKGROUND first: the click is posted to the window under the point without moving the user''s pointer or raising the window; when an app refuses background input, the tool escalates to foreground delivery (brief activation, pointer restored) and says so. Every result carries an EVIDENCE line: the delivery rung, the driver''s effect verdict, whether the real pointer moved during the action (the user is using the mouse — do not repeat side-effectful clicks), the element the app reports UNDER THE POINT (compare it with your target: a mismatch means you aimed wrong), and an objective screen-change measurement from before/after captures. NO visible change when you expected an immediate local effect means the click almost certainly missed — re-locate the target (computer_find, or fresh capture + zoom) instead of reporting success. Slow-loading results and effects on another display evade the check: when the effect might be slow, use computer_wait_for and verify with a capture, and NEVER re-click a side-effectful control (send, submit, buy, delete) on the report alone. The result also includes a magnified close-up with a crosshair on the exact point pressed, which becomes the current frame. Pass target (what you are clicking) and expect (what should happen). Never click coordinates you have not read from the current frame.'
    parameters:
      x:
        type: number
        required: false
        description: 'X in current-frame pixels (omit x and y to click at the aim point)'
      y:
        type: number
        required: false
        description: 'Y in current-frame pixels (omit x and y to click at the aim point)'
      button:
        type: string
        required: false
        enum:
          - left
          - right
          - middle
        description: 'Mouse button to click (default left)'
      count:
        type: number
        required: false
        description: 'Clicks: 1 (default), 2 (double), 3 (triple — selects a line or paragraph)'
      double:
        type: boolean
        required: false
        description: 'Double-click instead of single click'
      modifiers:
        type: string
        required: false
        description: 'Comma-separated modifier keys to hold during the click: shift (extend selection), cmd or ctrl (toggle selection / open in new tab), alt'
      target:
        type: string
        required: false
        description: 'What you are clicking, as a short phrase (e.g. ''the ✕ on the GitHub tab'') — echoed back and checked against the element under the point'
      expect:
        type: string
        required: false
        description: 'What should happen right after (e.g. ''the tab closes'') — carried into your next step so you verify it'
      delivery:
        type: string
        required: false
        enum:
          - auto
          - background
          - foreground
        description: 'auto (default): background first, foreground if the app refuses. background: refuse rather than move the pointer. foreground: activate the window (brief flash), pointer restored — for apps that only react when frontmost.'
  - name: computer_mouse_down
    description: 'Press and HOLD a mouse button at the real pointer (optionally moving it to x, y first) — for custom gestures, scrubbing a slider, or a drag you want to steer with computer_hover before computer_mouse_up. This path moves the user''s pointer; for ordinary drags use computer_mouse_drag.'
    parameters:
      x:
        type: number
        required: false
        description: 'X in current-frame pixels (optional: move the pointer here first)'
      y:
        type: number
        required: false
        description: 'Y in current-frame pixels'
      button:
        type: string
        required: false
        enum:
          - left
          - right
          - middle
        description: 'Mouse button to hold (default left)'
  - name: computer_mouse_up
    description: 'Release a mouse button held by computer_mouse_down.'
    parameters:
      button:
        type: string
        required: false
        enum:
          - left
          - right
          - middle
        description: 'Mouse button to release (default left)'
  - name: computer_mouse_drag
    description: 'Press and hold at the start point, glide to the end point, and release — for drag-and-drop, sliders, resizing, and selecting text. All four coordinates are current-frame pixels; when both endpoints are inside one window the drag is delivered in the background (pointer untouched), otherwise by moving the real pointer, and the evidence line says which. For a precise drag first zoom into a region that contains BOTH endpoints; when source and destination are far apart, do a rough long drag first, then a short corrective drag inside one zoom. Returns a magnified close-up of the release point; take a capture afterwards to confirm the result.'
    parameters:
      start_x:
        type: number
        description: 'Drag start X in current-frame pixels'
      start_y:
        type: number
        description: 'Drag start Y in current-frame pixels'
      end_x:
        type: number
        description: 'Drag end X in current-frame pixels'
      end_y:
        type: number
        description: 'Drag end Y in current-frame pixels'
      button:
        type: string
        required: false
        enum:
          - left
          - right
          - middle
        description: 'Mouse button to hold (default left)'
      modifiers:
        type: string
        required: false
        description: 'Comma-separated modifier keys to hold during the drag (alt to copy, shift to constrain)'
      duration_ms:
        type: number
        required: false
        description: 'Glide time in milliseconds (default 500; slower drags register better in some apps)'
      target:
        type: string
        required: false
        description: 'What you are dragging, as a short phrase'
      expect:
        type: string
        required: false
        description: 'What should happen right after'
      delivery:
        type: string
        required: false
        enum:
          - auto
          - background
          - foreground
        description: 'auto (default): background when both endpoints share a window, else the real pointer. background: refuse otherwise.'
  - name: computer_mouse_scroll
    description: 'Scroll to reveal content on the direction side (''down'' reveals what is below). Scrolling affects whatever is UNDER the point, so pass x,y (current-frame pixels) to scroll a specific pane or list; delivered in the background when the app accepts it (web content in browsers and Electron apps usually does not — then the real pointer is moved there, and the evidence line says so). The result includes a magnified view of the area around the point after the scroll, which becomes the current frame — when scrolling to find an item, look for it there and click it directly in the magnifier''s coordinates the moment it appears. Pre-scroll coordinates are stale; take a fresh capture for the wider picture. In a web page the Wolffish extension is connected to, prefer ext_scroll — it scrolls the page or a named element without touching the pointer; keep computer_mouse_scroll for windows the extension cannot reach.'
    parameters:
      direction:
        type: string
        enum:
          - up
          - down
          - left
          - right
        description: 'Which side to reveal more of (''down'' reveals content below)'
      amount:
        type: number
        required: false
        description: 'Wheel notches, or pages when by is pages (default 3)'
      by:
        type: string
        required: false
        enum:
          - lines
          - pages
        description: 'lines (default, wheel notches) or pages'
      x:
        type: number
        required: false
        description: 'Optional: scroll at this point, in current-frame pixels'
      y:
        type: number
        required: false
        description: 'Optional: scroll at this point, in current-frame pixels'
      target:
        type: string
        required: false
        description: 'What you are scrolling, as a short phrase'
      expect:
        type: string
        required: false
        description: 'What you expect to see'
      delivery:
        type: string
        required: false
        enum:
          - auto
          - background
          - foreground
        description: 'auto (default), background (refuse rather than move the pointer), foreground'
  - name: computer_keyboard_type
    description: 'Type text into the focused field of the window you last acted on (click the field first — that focuses it AND picks the window). Delivered in the background where the app accepts it (the user''s pointer and other windows are untouched); the evidence line says which rung ran. Options: enter: true presses Enter afterwards (submit in one step); replace: true selects the existing text first; via: clipboard pastes instead of keystrokes (used automatically for long or non-ASCII text such as Arabic and emoji, so it arrives exactly as written). Password fields are refused unless the user gave that secret in this conversation (allow_secret: true). Send the WHOLE text in one call, however long — splitting a body into chunks is how its tail gets forgotten before submit; the result reports the character count, compare it with what you meant to send. Verify with computer_read_element or a capture that the text landed in the intended field: web content cannot be read back by the driver — use ext_get_value / ext_take_snapshot for that; in a browser the Wolffish extension is connected to, prefer ext_type or ext_fill for the typing itself.'
    parameters:
      text:
        type: string
        description: 'The text to type'
      enter:
        type: boolean
        required: false
        description: 'Press Enter after typing'
      replace:
        type: boolean
        required: false
        description: 'Select all existing text in the field first, so the new text replaces it'
      via:
        type: string
        required: false
        enum:
          - auto
          - keystrokes
          - clipboard
        description: 'auto (default): keystrokes for short ASCII, clipboard paste otherwise'
      allow_secret:
        type: boolean
        required: false
        description: 'The user explicitly gave this secret in the current conversation'
      target:
        type: string
        required: false
        description: 'Which field, as a short phrase'
      expect:
        type: string
        required: false
        description: 'What should happen right after'
      delivery:
        type: string
        required: false
        enum:
          - auto
          - background
          - foreground
        description: 'auto (default), background (refuse rather than type into the focused app), foreground (type into whatever app has focus)'
  - name: computer_keyboard_press
    description: 'Press one key or a shortcut. Accepts a single key (enter, tab, escape, backspace, delete, space, up/down/left/right, home, end, pageup, pagedown, f1-f12, letters, digits, punctuation) or a combo in one string like ''cmd+s'', ''ctrl+shift+t'', ''alt+f4'' (a separate comma-separated modifiers parameter also works). Use cmd on macOS and ctrl on Windows/Linux. Delivered in the background to the window you last acted on where the app accepts it, else to the focused app; the evidence line says which. Prefer a reliable shortcut over clicking when both work (Enter to submit, Esc to dismiss, cmd+l for the address bar) and computer_menu for anything the menu bar offers.'
    parameters:
      key:
        type: string
        description: 'Key or combo string (e.g. enter, tab, ''cmd+shift+4'')'
      modifiers:
        type: string
        required: false
        description: 'Comma-separated modifier keys to hold: ctrl, alt, shift, meta, cmd'
      expect:
        type: string
        required: false
        description: 'What should happen right after'
      delivery:
        type: string
        required: false
        enum:
          - auto
          - background
          - foreground
        description: 'auto (default), background, foreground'
  - name: computer_key_down
    description: 'Hold a key down until computer_key_up (shift-select with clicks, a held modifier for a drag, game controls). Goes to the focused app. Always release what you hold.'
    parameters:
      key:
        type: string
        description: 'Key name (shift, ctrl, alt, cmd, a letter, …)'
  - name: computer_key_up
    description: 'Release a key held by computer_key_down.'
    parameters:
      key:
        type: string
        description: 'Key name'
  - name: computer_list_displays
    readOnly: true
    description: 'List all connected displays with resolution, scale factor, position, and which one is primary. When the app you need is not on the display-0 screenshot, capture each display_index in turn until you find it, then keep using that index. Coordinates never need display offsets — they always refer to the latest returned image.'
    parameters: {}
  - name: computer_wait
    description: 'Wait for a specified duration before the next action — use 500-2000ms after actions that trigger animations, page loads, or dialogs. Prefer computer_wait_for when you know what you are waiting for. No cap; a wait cannot be interrupted once in flight, so split very long waits into several calls.'
    parameters:
      ms:
        type: number
        description: 'Milliseconds to wait. No cap; split very long waits across multiple calls.'
  - name: computer_wait_for
    readOnly: true
    description: 'Wait until something is true instead of guessing a delay: until: stable (the screen stopped changing — after a page load or animation), window_title (a window whose title contains text appears — a dialog, a new document), element (a control matching text/role appears in a window) or element_gone (it disappears — a progress dialog closed). Polls every 250-300ms up to timeout_ms (default 5000; you choose it, there is no cap) and reports what it saw, so the next capture is taken when it matters.'
    parameters:
      until:
        type: string
        required: false
        enum:
          - stable
          - window_title
          - element
          - element_gone
        description: 'What to wait for (default stable)'
      text:
        type: string
        required: false
        description: 'Window title substring, or element text'
      role:
        type: string
        required: false
        description: 'Element role for element waits'
      timeout_ms:
        type: number
        required: false
        description: 'How long to wait at most (default 5000)'
      pid:
        type: number
        required: false
        description: 'Process id for element waits (defaults to the window of the current frame or last action)'
      window_id:
        type: number
        required: false
        description: 'Window id for element waits'
  - name: computer_clipboard_read
    readOnly: true
    description: 'Read the clipboard text (says so when it holds an image or is empty). Useful after a copy shortcut to get exact text out of an app.'
    parameters: {}
  - name: computer_clipboard_write
    description: 'Put text or an image file on the clipboard, then paste it with computer_keyboard_press cmd+v / ctrl+v. Replaces what the user had on the clipboard.'
    parameters:
      text:
        type: string
        required: false
        description: 'Text to copy'
      image_path:
        type: string
        required: false
        description: 'Absolute path of an image file to copy'
  - name: computer_batch
    description: 'Run several computer-use steps in order in one call — an ordered list of { tool, args } — for sequences you are sure of (open a menu, pick an item, confirm; click a field, type, press Enter). Stops at the first failure, refusal, interruption or no-visible-change step and returns every step''s result so far, so a miss never silently cascades. Each step still obeys the indicator gate and the approval rules; the approval card shows all steps.'
    parameters:
      steps:
        type: array
        description: 'Ordered steps, each { tool: computer_…, args: { … }, stop_on_noop?: boolean }'
        raw:
          type: array
          items:
            type: object
            properties:
              tool:
                type: string
              args:
                type: object
              stop_on_noop:
                type: boolean
            required:
              - tool
          description: 'Ordered steps, each { tool: computer_…, args: { … }, stop_on_noop?: boolean }'
confirm_patterns:
  - pattern: computer_mouse_click
    reason: Clicking on screen
  - pattern: computer_click_element
    reason: Clicking a control
  - pattern: computer_mouse_drag
    reason: Dragging on screen
  - pattern: computer_mouse_down
    reason: Holding a mouse button
  - pattern: computer_hover
    reason: Moving the pointer
  - pattern: computer_keyboard_type
    reason: Typing text
  - pattern: computer_set_value
    reason: Writing a field
  - pattern: computer_keyboard_press
    reason: Pressing keys
  - pattern: computer_key_down
    reason: Holding a key
  - pattern: computer_mouse_scroll
    reason: Scrolling
  - pattern: computer_menu
    reason: Invoking a menu
  - pattern: computer_focus_window
    reason: Switching windows
  - pattern: computer_clipboard_write
    reason: Replacing the clipboard
  - pattern: computer_batch
    reason: Running several screen actions
danger_patterns:
  - pattern: 'computer_keyboard_press.*(delete|backspace)'
    level: warn
    reason: Pressing delete/backspace key
  - pattern: 'computer_menu.*(Quit|Delete|Empty Trash|Erase|Uninstall)'
    level: warn
    reason: A menu item that removes or quits something
  - pattern: 'computer_(keyboard_type|set_value).*(sudo|rm -rf|password|secret|token)'
    level: destructive
    reason: Typing potentially dangerous or sensitive text
---

# Computer Use — Verified Aim, Background Delivery, Two Grounding Routes

The agent sees and controls the desktop through a closed feedback loop designed for
surgical accuracy with any vision-capable model — and, since v3, without taking the
user's mouse away from them.

## What the model works with

1. **One coordinate space, owned by the plugin.** Every image a tool returns
   (display screenshot, window screenshot, zoom, or magnifier) becomes the *current
   frame*. The model gives coordinates as pixels read off the latest image; the plugin
   does all translation — downscaling, Retina/HiDPI, multi-monitor offsets, and the
   window-local capture pixels the native driver expects. The model never does
   coordinate math.
2. **Two grounding routes.** Pixels (screenshot → zoom → aim → click) and elements
   (`computer_find` by name through the app's accessibility tree → `computer_click_element`
   by token). On every pixel click the element the app reports under the point is echoed
   back, so a wrong aim is caught by one accessibility query instead of by eyesight.
3. **Background delivery through a native driver.** Clicks, keys, scrolls and drags are
   posted to the target *window* (cua's Rust driver, `@trycua/cua-driver`, MIT): the
   user's pointer does not move and the window is not raised. When an app refuses
   background input the driver answers with a code (`background_unavailable`,
   `background_occluded`, `background_uipi_blocked`) and the plugin escalates one rung —
   foreground delivery with the pointer restored — and, only if that is impossible, the
   legacy path that moves the real pointer (nut-js). Every result names the rung that ran.
4. **Evidence on every action.** Delivery rung, the driver's effect verdict
   (`confirmed`, `partial`, `unverifiable`, `suspected noop`, `refused`), whether the real
   pointer moved during a foreground action (the user is using the mouse), the element
   under the point, and an objective before/after pixel-change measurement. The action's
   stated intent (`target`, `expect`) rides the runtime tail into the next step, so the
   model verifies before it plans — one forward pass, no extra call.
5. **A shadow cursor** in the screen indicator: it glides to the point before the input
   is posted and pulses on the press, so the person sees cause before effect while their
   own pointer stays free. `computer_mouse_move` aims the shadow cursor only;
   `computer_hover` is the one tool that moves the real pointer (tooltips, hover menus).

Verified live on Windows 11 too (2026-09-15, build 26200, Electron 39, 35/35 checks;
harness in `src/main/__tests__/computer-use-live/`): background clicks land through an
occluding window, Notepad's UIA tree takes background typing with readback, menus invoke,
the indicator is invisible to captures. Windows differs in three places, all handled: the
driver lists DWM-cloaked shell windows (Start, Search, suspended UWP apps) as on screen,
so they are filtered through Electron's own window enumeration; a posted right or middle
click leaves a Chromium window dropping every later posted click, so those buttons take
the foreground rung there; and Chromium windows refuse background typing and scrolling,
so text and keys take the foreground rung (real input into THAT window, foreground put
back) and scrolling the legacy path with the pointer put back afterwards.

Verified live (2026-09-15, macOS 26.6, Electron 39) against a separate Chromium
process with DOM ground truth: background clicks land on the exact pixel (16px targets
included), double and right clicks, typing and key chords arrive, the real pointer does
not move, the frontmost app does not change, background scroll into Chromium is refused
with a code and escalated, and the content-protected indicator is invisible to the
driver's captures.

## The Small-Target Playbook

For any control smaller than ~20 logical pixels (tab close buttons, checkboxes,
tiny icons):

1. `computer_find` it by name in the window. If it has a frame, `computer_click_element`
   by token — no pixel aim at all. Native apps expose rich trees; web content in browsers
   and Electron apps usually exposes only the window chrome, and the result says so. When
   that web page is in a browser the Wolffish extension is connected to, prefer the `ext_*`
   tools for reading, typing and clicking inside the page, and stay in computer use for the
   browser's chrome, dialogs and file pickers around it.
2. Otherwise `computer_screenshot` (or `computer_window_screenshot`) → `computer_zoom`
   into a **narrow** region around it (2x or more; the tool suggests the size) →
   `computer_mouse_move` onto it (pass `target`) and check that the hairlines pass
   through its **center** and that the element under the point is the one you meant →
   `computer_mouse_click` with no coordinates.
3. Read the evidence line. **No visible change + an expected immediate local effect = it
   did not work**, no matter how plausible the close-up looks; re-aim instead of
   rationalizing. If the effect might be slow, `computer_wait_for` and confirm with a
   capture — and never re-click a send/submit-style control on the report alone.

## Session shape

`computer_glow_on` (first; it also runs the access check) → `computer_list_windows` →
`computer_window_screenshot` + `computer_find` for the app you are driving → act with
`target`/`expect` → read the evidence → `computer_glow_off` (last). `computer_batch`
runs a sequence you are sure of in one call and stops at the first miss.

## Required setup, per operating system

| OS | What must be granted | How the plugin tells you |
|---|---|---|
| **macOS** | Screen Recording (captures, window trees) and Accessibility (input), attributed to Wolffish.app. Both are one-time; Screen Recording needs a restart. | `computer_check_access` reports each grant with the System Settings path; `computer_glow_on` runs the same check; `request: true` triggers the prompts. |
| **Windows** | Nothing to grant. Windows running as administrator cannot receive input from a non-elevated Wolffish (UIPI) — the driver reports `background_uipi_blocked`. Right and middle clicks, and typing into browsers and Electron apps, use the foreground rung (the window is fronted for an instant, the previous foreground and the pointer put back); the evidence line says so. | Same tool; elevation is reported as a limit, not a blocker. |
| **Linux X11** | Nothing to grant. Write access to `/dev/uinput` (input group or udev rule) enables a second, independent pointer; the AT-SPI bus enables the element route. | Same tool; missing pieces are reported as limits. |
| **Linux Wayland** | Depends on the compositor: GNOME 47+ and KDE 6+ can grant remote-desktop access through the portal; KDE refuses background window input by design. Foreground delivery and display captures work through XWayland or the portal. | Same tool; it names the session type and compositor. |

**Vision is required.** If the active Brain model cannot accept images, the runtime
strips the screenshots and the tools tell the model to stop and ask the user to switch
models.

## Screen indicator (glow, notice, shadow cursor)

While computer use runs, the controlled display shows a blue glow along all four edges,
a translucent pill in the center reading "Wolffish is capturing your screen" (English or
Arabic), and the shadow cursor. The glow breathes, brightens on every capture, and the
cursor pulses on every press.

**Its lifecycle is model-owned.** `computer_glow_on` is the mandatory FIRST action of
every session and `computer_glow_off` the mandatory LAST, whether the task succeeded,
failed, or was abandoned. There is no idle timer. Both halves are enforced:

- **On — a gate** (`indicatorGate`, `plugin/index.mjs`): every capture and input tool
  refuses to run while the indicator is off, naming `computer_glow_on`. A machine that
  cannot draw it opens the gate for that session and tells the model to say so.
- **Presence** (`ensureOverlayAlive`, `plugin/overlay.mjs`): "on" means visibly on. If
  the OS destroyed the window (display unplugged, sleep) while the indicator is on, the
  next gated call recreates it; display topology events rebuild it on a surviving
  display; plugin teardown and app quit take it down.
- **Off — a notice, a nudge, then a failsafe** (`agent/screen-indicator-guard.ts`): the
  runtime tail restates the exit on every iteration (with the last action's intent and
  evidence), a turn ending with the glow up is sent back to close it (twice at most),
  and only when the turn is over on a path where no model step is possible does the
  Agent's `finally` clear it.

The overlay window is content-protected, so it never appears in captures (on Linux it
hides for the instant of a display-scope capture; window-scope captures never include
it), and it is click-through and non-focusable, so input is unaffected. The e2e harness
sets `WOLFFISH_OVERLAY_CAPTURE_VISIBLE=1` to photograph it; production never does.

## Multiple displays

`computer_screenshot` captures display 0 by default; `computer_list_displays` shows
every monitor and window listings carry a display index. Coordinate translation to the
right monitor — including negative origins and mixed DPI — is automatic; there is no
manual offset arithmetic anywhere in the contract. Window-scope actions are per-window
and therefore monitor-agnostic.

## Working with the browser extension

When the window you are driving is a browser the Wolffish extension is connected to
(`browser-extension`, tools `ext_*`), the page itself is not this plugin's job: inside the
page the extension reads the DOM, types and clicks by element with no pointer and no
approval per action, and reads the result back — none of which the pixel route can do
through a browser. **Prefer `ext_*` for everything inside the page and stay here for
everything around it**: the browser's own chrome, native dialogs (file pickers, print,
save, basic-auth and passkey prompts), OS permission sheets, the PDF viewer and other
non-DOM viewers, `chrome://` pages, a browser the extension is not connected to, and how
the page actually looks to the user at their zoom and window size. A task that crosses
the boundary uses both and says so; the glow goes on before the first computer call and
comes off after the last one of the turn, held across the excursion. **Coordinates never
cross**: the extension's CSS-viewport pixels and this plugin's frame pixels are separate
frames — re-ground on the side you are acting on. **Credentials never cross either**:
never type a password, one-time code or payment number the user did not give in this
conversation, on either side — hand the field to the user with `ask_user` and wait.

## Capture quality is model-owned

There is **no user-facing control** for resolution or format. `max_width` (480-2560,
default 1280) and `format` (jpeg/png) are per capture and never persist; zoom and
magnifier images are always native-resolution PNG. A PNG over the per-image byte budget
is **encoded as JPEG at the same width** and the result says so: The width you asked
for is always honored; the codec is what gives. Captures are saved under
`screenshots/conv-<id>/` for chat rendering, channel delivery and aim forensics.

## Safety

- Clicking, dragging, typing, key presses, scrolling, menus, focusing windows and the
  clipboard are approval-gated (`confirm_patterns`); captures, element reads, waits and
  the access check are read-only.
- The approval card names the resolved target — "Click 'Save' in Notes" — and carries
  the app as its scope, so "Allow for this conversation" allows that app, not a tool
  name.
- Password fields are refused unless the user gave the secret in this conversation.
- Typing text matching sensitive patterns is flagged as destructive; menu items that
  quit, delete or erase are flagged as warnings.
