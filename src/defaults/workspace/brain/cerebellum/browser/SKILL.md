---
name: browser
description: "Headless Playwright — an invisible throwaway browser nobody watches, for scripted runs. Chromium, Firefox or WebKit; stored credentials, multi-tab crawls, table and link extraction, network logs, page-to-PDF. Not the user's browser and never on screen."
triggers:
  - headless
  - headless browser
  - throwaway browser
  - chromium
  - webkit
  - playwright
  - scrape
  - web scraping
  - crawl
  - crawler
  - data extraction
  - extract data
  - extract text
  - table
  - pagination
  - next page
  - infinite scroll
  - selector
  - xpath
  - css selector
  - dom
  - html
  - element
  - network
  - request
  - response
  - ajax
  - spa
  - single page app
  - iframe
  - incognito
  - private browsing
  - user agent
  - viewport
  - responsive
  - mobile view
  - full page
  - automation
  - bot
  - credential
  - password
  - sign in
  - sign up
  - register
  - pdf
  - print page
  - price tracker
  - monitor website
  - check availability
  - test website
  - debug website
  - wait for
  - wait until
  - load page
  - page loaded
  - automate
  - launch browser
  - close browser
  - open browser
  - unattended
  - scripted
tools:
  - name: browser_launch
    description: Launch a browser instance and return a session_id. Defaults to headed Chromium at 1280x720.
    parameters:
      headless:
        type: boolean
        required: false
        description: Run without a visible window. Default false (headed).
      browser:
        type: string
        required: false
        description: Browser engine to use.
        enum:
          - chromium
          - firefox
          - webkit
      viewport_width:
        type: number
        required: false
        description: Viewport width in pixels. Default 1280.
      viewport_height:
        type: number
        required: false
        description: Viewport height in pixels. Default 720.
      locale:
        type: string
        required: false
        description: Browser locale (e.g. en-US, fr-FR). Default system locale.
      timezone:
        type: string
        required: false
        description: Timezone ID (e.g. America/New_York). Default system timezone.
      user_agent:
        type: string
        required: false
        description: Custom User-Agent string.
  - name: browser_close
    description: Close a browser session and clean up all resources.
    parameters:
      session_id:
        type: string
        description: Session to close.
      clear_credentials:
        type: boolean
        required: false
        description: Also wipe all stored credentials. Default true.
  - name: browser_navigate
    description: Navigate to a URL in the active tab.
    parameters:
      session_id:
        type: string
        description: Browser session.
      url:
        type: string
        description: URL to navigate to.
      wait_until:
        type: string
        required: false
        description: When to consider navigation done.
        enum:
          - load
          - domcontentloaded
          - networkidle
      timeout_ms:
        type: number
        required: false
        description: Navigation timeout in ms. Default 30000.
      tab_id:
        type: string
        required: false
        description: Target a specific tab. Default is the last active tab.
  - name: browser_screenshot
    readOnly: true
    description: Take a screenshot of the current page or a specific element.
    parameters:
      session_id:
        type: string
        description: Browser session.
      output_path:
        type: string
        required: false
        description: Where to save the image. Default auto-generated in plugin screenshots dir.
      full_page:
        type: boolean
        required: false
        description: Capture the full scrollable page. Default false.
      selector:
        type: string
        required: false
        description: CSS/XPath selector to screenshot a specific element.
      format:
        type: string
        required: false
        description: Image format.
        enum:
          - png
          - jpeg
      quality:
        type: number
        required: false
        description: JPEG quality 0-100. Only for jpeg format.
  - name: browser_page_content
    readOnly: true
    description: Extract text, HTML, or markdown content from the current page or a specific element.
    parameters:
      session_id:
        type: string
        description: Browser session.
      format:
        type: string
        description: Output format.
        enum:
          - text
          - html
          - markdown
      selector:
        type: string
        required: false
        description: Extract only from this element. Default whole page.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_click
    description: Click an element on the page. Supports CSS, XPath, text, and role selectors.
    parameters:
      session_id:
        type: string
        description: Browser session.
      selector:
        type: string
        description: 'Element selector. CSS, xpath=//..., text=Submit, role=button[name="OK"].'
      button:
        type: string
        required: false
        description: Mouse button.
        enum:
          - left
          - right
          - middle
      click_count:
        type: number
        required: false
        description: Number of clicks. Default 1.
      timeout_ms:
        type: number
        required: false
        description: Timeout waiting for element. Default 10000.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_fill
    description: Fill a form field. Use credential_id for secure credential entry.
    parameters:
      session_id:
        type: string
        description: Browser session.
      selector:
        type: string
        description: Input element selector.
      value:
        type: string
        required: false
        description: Text to fill. Omit if using credential_id.
      credential_id:
        type: string
        required: false
        description: Credential UUID to read value from. Keeps credentials out of tool args.
      field_name:
        type: string
        required: false
        description: Which credential field to use (username or password). Required with credential_id.
        enum:
          - username
          - password
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_select
    description: Select an option from a dropdown/select element.
    parameters:
      session_id:
        type: string
        description: Browser session.
      selector:
        type: string
        description: Select element selector.
      value:
        type: string
        required: false
        description: Option value attribute.
      label:
        type: string
        required: false
        description: Option visible text.
      index:
        type: number
        required: false
        description: Option index (0-based).
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_type
    description: Type text character by character, triggering keystroke events.
    parameters:
      session_id:
        type: string
        description: Browser session.
      selector:
        type: string
        description: Target input element.
      text:
        type: string
        description: Text to type.
      delay_ms:
        type: number
        required: false
        description: Delay between keystrokes in ms. Default 50.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_keyboard
    description: Press a keyboard key or shortcut (Enter, Tab, Control+a, etc).
    parameters:
      session_id:
        type: string
        description: Browser session.
      key:
        type: string
        description: 'Key descriptor: Enter, Tab, Escape, Control+a, Meta+c, etc.'
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_hover
    description: Hover over an element to trigger hover states.
    parameters:
      session_id:
        type: string
        description: Browser session.
      selector:
        type: string
        description: Element to hover over.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_scroll
    description: Scroll the page or a specific element.
    parameters:
      session_id:
        type: string
        description: Browser session.
      direction:
        type: string
        description: Scroll direction.
        enum:
          - up
          - down
          - left
          - right
      amount:
        type: number
        required: false
        description: Pixels to scroll. Default 500.
      selector:
        type: string
        required: false
        description: Element to scroll within. Default is the page.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_form_fill
    description: Fill an entire form at once with multiple fields.
    parameters:
      session_id:
        type: string
        description: Browser session.
      fields:
        type: string
        description: 'JSON array of fields: [{"selector":"#email","value":"a@b.com","action":"fill"},{"selector":"#agree","action":"check"}]. Actions: fill, select, check, uncheck. Use credential_id and field_name instead of value for credentials.'
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_extract_table
    readOnly: true
    description: Extract an HTML table as structured JSON.
    parameters:
      session_id:
        type: string
        description: Browser session.
      selector:
        type: string
        description: Table element selector.
      headers:
        type: boolean
        required: false
        description: First row contains headers. Default true.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_extract_links
    readOnly: true
    description: Extract all links from the page or a section.
    parameters:
      session_id:
        type: string
        description: Browser session.
      selector:
        type: string
        required: false
        description: Container element to extract links from. Default whole page.
      filter:
        type: string
        required: false
        description: Regex pattern to filter hrefs.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_store_credential
    description: Store login credentials securely in runtime memory. Returns a credential_id. Password is NEVER echoed back.
    parameters:
      domain:
        type: string
        description: Website domain these credentials are for.
      username:
        type: string
        description: Username or email.
      password:
        type: string
        description: Password. Stored in memory only, never written to disk.
  - name: browser_clear_credentials
    description: Clear stored credentials from memory.
    parameters:
      credential_id:
        type: string
        required: false
        description: Specific credential to clear. Omit to clear all.
  - name: browser_list_credentials
    description: List stored credential IDs and metadata. Never includes passwords.
    parameters: {}
  - name: browser_wait
    description: Wait for a condition on the page.
    parameters:
      session_id:
        type: string
        description: Browser session.
      type:
        type: string
        description: What to wait for.
        enum:
          - selector
          - navigation
          - timeout
          - network_idle
      selector:
        type: string
        required: false
        description: CSS/XPath selector to wait for. Required when type is selector.
      state:
        type: string
        required: false
        description: Selector state to wait for.
        enum:
          - visible
          - hidden
          - attached
          - detached
      timeout_ms:
        type: number
        required: false
        description: Maximum wait time in ms. Default 30000.
      url_pattern:
        type: string
        required: false
        description: URL pattern to match for navigation waits.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_evaluate
    description: Execute JavaScript in the page context. Returns the result as JSON. DANGEROUS — always requires user approval.
    parameters:
      session_id:
        type: string
        description: Browser session.
      script:
        type: string
        description: JavaScript code to execute in the page.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_download
    description: Trigger and capture a file download from the page.
    parameters:
      session_id:
        type: string
        description: Browser session.
      trigger_selector:
        type: string
        required: false
        description: Element to click to start the download. Omit if download is already triggered.
      output_path:
        type: string
        description: Where to save the downloaded file. Must be an absolute path or ~ path.
      timeout_ms:
        type: number
        required: false
        description: Download timeout in ms. Default 60000.
      tab_id:
        type: string
        required: false
        description: Target tab.
  - name: browser_cookies
    description: Read, set, or clear browser cookies.
    parameters:
      session_id:
        type: string
        description: Browser session.
      action:
        type: string
        description: Cookie operation.
        enum:
          - get
          - set
          - clear
      cookies:
        type: string
        required: false
        description: 'JSON array of cookie objects for set action: [{"name":"x","value":"y","domain":".example.com"}].'
      domain:
        type: string
        required: false
        description: Domain filter for get/clear.
  - name: browser_network_log
    description: Get recent network requests made by the page.
    parameters:
      session_id:
        type: string
        description: Browser session.
      filter:
        type: string
        required: false
        description: URL pattern to filter requests.
      limit:
        type: number
        required: false
        description: Max number of entries. Default 50.
  - name: browser_pdf
    description: Save the current page as a PDF file.
    parameters:
      session_id:
        type: string
        description: Browser session.
      output_path:
        type: string
        description: Where to save the PDF.
      format:
        type: string
        required: false
        description: Paper format.
        enum:
          - A4
          - Letter
          - Legal
      landscape:
        type: boolean
        required: false
        description: Landscape orientation. Default false.
      print_background:
        type: boolean
        required: false
        description: Include background graphics. Default true.
  - name: browser_multi_tab
    description: Open a new tab in an existing browser session.
    parameters:
      session_id:
        type: string
        description: Browser session.
      url:
        type: string
        required: false
        description: URL to open in the new tab.
requires:
  - node
danger_patterns:
  - pattern: 'browser_evaluate\s.*document\.cookie'
    level: block
    reason: Cookie exfiltration via JS
  - pattern: 'browser_evaluate\s.*navigator\.sendBeacon'
    level: block
    reason: Beacon data exfiltration
  - pattern: 'browser_evaluate\s.*window\.open\s*\(\s*[''"]data:'
    level: block
    reason: Data URI exfiltration
  - pattern: 'browser_evaluate\s.*(?:fetch|XMLHttpRequest)\s*\(.*https?:\/\/(?!localhost)'
    level: block
    reason: Outbound data exfiltration via fetch/XHR
  - pattern: 'browser_download\s.*[''"]\/etc\/'
    level: block
    reason: Download to system directory
  - pattern: 'browser_download\s.*[''"]\/usr\/'
    level: block
    reason: Download to system directory
  - pattern: 'browser_download\s.*[''"]\/System\/'
    level: block
    reason: Download to system directory
  - pattern: 'browser_download\s.*C:\\\\Windows'
    level: block
    reason: Download to Windows system directory
  - pattern: 'browser_download\s.*C:\\\\Program Files'
    level: block
    reason: Download to Windows system directory
confirm_patterns:
  - pattern: '^browser_store_credential\s'
    reason: Storing login credentials in memory
  - pattern: '^browser_evaluate\s'
    reason: Executing arbitrary JavaScript in the page
  - pattern: '"credential_id"\s*:\s*"'
    reason: Using stored credentials to fill a form field
  - pattern: 'browser_navigate\s.*(?:login|signin|sign-in|auth|oauth|sso)\b'
    reason: Navigating to a login or authentication page
  - pattern: '^browser_download\s'
    reason: Downloading a file from the web
  - pattern: 'browser_cookies\s.*"set"'
    reason: Modifying browser cookies
  - pattern: '"headless"\s*:\s*true'
    reason: Launching browser in invisible headless mode
  - pattern: 'browser_navigate\s.*(?:bank|paypal|venmo|stripe\.com|checkout|payment)'
    reason: Navigating to a financial or payment site
---

# Browser Automation

This is the **clean-room browser**: a Playwright-launched Chromium (or Firefox/WebKit) with its own profile — none of the user's logins, cookies, tabs or history. When the user's real browser is connected through the `browser-extension` capability (`ext_*` tools), that is the default for anything logged-in, anything on their own tabs, and anything that should look like them. Reach for this one for isolated sessions, headless runs, PDF/print of your own HTML (`browser_pdf`), and when no extension browser is connected.

## Interface

- Tools: 25 tools for launching, navigating, interacting, extracting, and managing browser sessions
- Engine: Playwright (Chromium by default, Firefox and WebKit also available)
- Sessions: each `browser_launch` creates an isolated session; multiple sessions can run simultaneously
- Tabs: each session can have multiple tabs via `browser_multi_tab`

## Safety — READ BEFORE EVERY USE

### Terms of Service
ALWAYS warn the user before automating any website that this may violate that site's Terms of Service. Many platforms (Google, Facebook, LinkedIn, Amazon, Twitter/X, Instagram, banking sites) explicitly prohibit automated access. Violating ToS can result in account suspension or legal action. Let the user decide whether to proceed.

### Bot Detection
Browser automation is detectable by modern anti-bot systems (Cloudflare, reCAPTCHA, DataDome, PerimeterX, Akamai). Sites fingerprint automated browsers via WebDriver flags, headless detection, canvas fingerprinting, and behavioral analysis. Never promise undetectable automation.

### CAPTCHAs
If a site presents a CAPTCHA, STOP and inform the user. Never attempt to solve or bypass CAPTCHAs.

### Financial and Sensitive Sites
NEVER automate login to banking, financial, healthcare, or government sites unless the user explicitly acknowledges the risk after being warned. NEVER automate actions that could result in financial transactions (purchases, transfers, payments) without explicit per-action user approval.

### Screenshots
When taking screenshots, warn the user if the page might contain sensitive information (banking dashboards, email inboxes, medical records).

## Credential Handling — CRITICAL

Credentials must NEVER be written to any markdown file, episode, task log, memory, feedback, or conversation history.

### Storing Credentials
When the user provides login credentials, immediately call `browser_store_credential` to store them securely. Never include raw credentials in any other tool call's arguments — always reference by credential_id.

### Using Credentials
Use `browser_fill` with `credential_id` and `field_name` to enter credentials into form fields. This keeps raw passwords out of tool call arguments that get logged.

### Cleanup
After the automation task is complete, call `browser_clear_credentials` to wipe all stored credentials. If a task fails mid-execution, still clear credentials in the cleanup step.

### Never Echo
Never repeat passwords to the user in conversation text. Confirm storage with "Credentials stored securely (ID: xxx, expires in 60 minutes)" without echoing values.

## General Usage

- Always launch browsers in headed mode by default so the user can see what's happening. Only use headless mode if the user explicitly requests it.
- Always take a screenshot after key actions (page load, form fill, submission) and return the path so the user can verify.
- Use Playwright's auto-wait — don't add arbitrary delays. If a specific wait is needed, use `browser_wait` with type=selector or type=navigation, not type=timeout.
- For multi-step workflows, describe each step to the user before executing it.
- Always close the browser and clean up when the task is done, even if it fails mid-way.
- When extracting data from pages, return structured JSON, not raw HTML.
- For file downloads, save to the user's workspace or a user-specified path, never to system directories.

## Saving a page as a PDF (`browser_pdf`)

`browser_pdf` prints the current page **full bleed** (zero page margin), so the HTML controls
every millimeter of spacing and color. When you're generating a document to hand to the user (a
report, invoice, summary), this HTML → PDF path is the default — but the authoring system lives
elsewhere: **call the core `pdf_design` tool BEFORE writing the HTML.** It returns the document
design manual (page architecture, type scale, color rules, the component kit, and the mandatory
render-verify loop). Do not improvise document design from memory.

Mechanics that stay true regardless of design: the page prints with zero margin (`@page{margin:0}`
plus your own painted background = no white bars), `print_background` defaults to true, the
`format` argument (`"A4"`/`"Letter"`) — not CSS `@page size` — decides the paper size, and
`browser_pdf` does **not** auto-deliver: call `send_file` on the resulting `.pdf`.

## Selectors

All tools that accept a `selector` parameter support:
- CSS: `#id`, `.class`, `input[name="email"]`
- XPath: `xpath=//button[@type="submit"]`
- Text: `text=Submit`, `text=Sign In`
- Role: `role=button[name="Submit"]`

Playwright auto-waits for elements to be visible and actionable before interacting.

## Login Flow Pattern

```
1. browser_store_credential  → store creds, get credential_id
2. browser_launch            → start browser
3. browser_navigate          → go to login page
4. browser_fill              → fill username (credential_id + field_name=username)
5. browser_fill              → fill password (credential_id + field_name=password)
6. browser_click             → click submit
7. browser_screenshot        → verify success
8. ... do work ...
9. browser_clear_credentials → wipe creds
10. browser_close            → close browser
```

## Browser Installation

Chromium is installed automatically when this capability's npm dependencies are set up (via the `postinstall` script in `package.json`). This happens on first use — you do not need to install it manually.

If `browser_launch` fails with a "not installed" error, restart Wolffish so the capability can re-initialize its dependencies. Do NOT run `npx playwright install` — that pulls an arbitrary version from npm and may cause a version mismatch.
