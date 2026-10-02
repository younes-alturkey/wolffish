---
name: package-manager
description: Cross-platform system package manager. Uses Homebrew on macOS (auto-installs if missing), winget on Windows (pre-installed), apt on Debian/Ubuntu, dnf on Fedora/RHEL.
triggers:
  - install
  - package
  - brew
  - winget
  - apt
  - dependency
  - homebrew
  - dnf
  - yum
  - pacman
  - snap
  - flatpak
  - choco
  - chocolatey
  - uninstall
  - upgrade
  - update
  - software
  - tool
  - binary
  - setup
  - prerequisite
  - requirement
  - system package
  - os package
  - cli tool
  - command line tool
  - missing command
  - not found
  - not installed
  - install program
  - install app
  - install utility
  - install library
  - system library
  - shared library
  - lib
  - pkg
  - formula
  - cask
  - tap
  - repository
  - ppa
  - add repository
  - remove package
  - purge
  - autoremove
  - list installed
  - search package
  - available updates
  - outdated
  - which version
  - latest version
requires: []
tools:
  - name: pkg_check
    readOnly: true
    description: Check if a system package manager is available and which one
    parameters: {}
  - name: pkg_install_manager
    description: Install the system package manager if missing (Homebrew on macOS). No-op on Windows and Linux where managers are pre-installed.
    parameters: {}
  - name: pkg_install
    description: Install a package using the system package manager
    parameters:
      package_name:
        type: string
        description: Generic package name. The plugin resolves the platform-specific identifier from the calling capability's SKILL.md packages field.
      brew_name:
        type: string
        description: Override package name for Homebrew
        required: false
      winget_id:
        type: string
        description: Override package ID for winget (e.g. Gyan.FFmpeg)
        required: false
      apt_name:
        type: string
        description: Override package name for apt
        required: false
      dnf_name:
        type: string
        description: Override package name for dnf
        required: false
danger_patterns: []
confirm_patterns:
  - pattern: "pkg_install_manager"
    reason: Installing system package manager
  - pattern: "pkg_install"
    reason: Installing a system package
---

# Package Manager

## Usage

Use `pkg_check` first to detect the available package manager. On macOS, if
Homebrew is missing, call `pkg_install_manager` to install it (requires user
approval). On Windows and Linux the system manager is pre-installed.

To install a package, call `pkg_install` with `package_name`. If the package
has a different identifier on a specific platform, pass the override:

- `brew_name` for Homebrew (macOS)
- `winget_id` for winget (Windows) — use the full ID like `Gyan.FFmpeg`
- `apt_name` for apt (Debian/Ubuntu)
- `dnf_name` for dnf (Fedora/RHEL)

When a capability declares a `packages` field in its SKILL.md, the cerebellum
automatically injects the correct platform override so you don't need to know
which OS the user is on.

## Rules

- All installs require user approval through the safety gate.
- Never install packages the user didn't ask for.
- Check if the package is already installed before attempting installation.
- Use the platform-specific override when available for accurate package resolution.
