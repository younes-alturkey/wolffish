#!/bin/sh
set -eu

RELEASES_BASE="https://releases.wolffi.sh"
TEMP_DIR=""

# The name dpkg and rpm know Wolffish by. electron-builder derives it from
# package.json#name, NOT from productName (which is what /opt/Wolffish uses).
PACKAGE_NAME="wolffish-app"

# And the binary those packages put on PATH — named after package.json#name too.
# So a fresh deb/rpm install has `wolffish-app` and nothing else: `wolffish`, the
# CLI, is a shim the app writes into ~/.wolffish/bin the first time it boots.
# Both names appear in the closing notices for that reason, and telling someone
# to run the one that does not exist yet is how a working install reads as broken.
EXE_NAME="wolffish-app"

# Whether the installer may append a PATH line to a shell profile. Only the
# AppImage route ever needs it (see add_to_path), and --no-modify-path is there
# for anyone whose dotfiles are generated and would lose the edit anyway.
MODIFY_PATH=1

# Set once add_to_path has spoken, so the closing notice does not repeat it.
PATH_HANDLED=0

# apt and dpkg must never stop to ask a question. This script is normally read
# from a pipe (`curl … | sh`), so a conffile prompt or a debconf dialog would
# hang forever with no one able to answer it.
export DEBIAN_FRONTEND=noninteractive

# Colors
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' CYAN='' BOLD='' RESET=''
fi

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

info()  { printf "${BLUE}[i]${RESET} %s\n" "$1"; }
ok()    { printf "${GREEN}[+]${RESET} %s\n" "$1"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$1"; }
err()   { printf "${RED}[x]${RESET} %s\n" "$1" >&2; }
die()   { err "$1"; exit 1; }

banner() {
  printf "${CYAN}"
  cat << 'EOF'

  ╦ ╦╔═╗╦  ╔═╗╔═╗╦╔═╗╦ ╦
  ║║║║ ║║  ╠╣ ╠╣ ║╚═╗╠═╣
  ╚╩╝╚═╝╩═╝╚  ╚  ╩╚═╝╩ ╩

EOF
  printf "${RESET}"
  printf "  ${BOLD}Wolffish Installer${RESET}\n\n"
}

usage() {
  banner
  printf "Usage: install.sh [OPTIONS]\n\n"
  printf "Options:\n"
  printf "  --help             Show this help message\n"
  printf "  --version          Print the latest available version and exit\n"
  printf "  --no-modify-path   Never touch a shell profile (AppImage installs only)\n"
  printf "\nInstalls Wolffish on macOS (.dmg), Linux (.deb/.rpm/.AppImage), or Windows (.exe).\n"
  exit 0
}

detect_os() {
  case "$(uname -s)" in
    Darwin)          echo "macos" ;;
    Linux)           echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *)               die "Unsupported operating system: $(uname -s)" ;;
  esac
}

fetch_manifest() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" || die "Failed to download manifest from $url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url" || die "Failed to download manifest from $url"
  else
    die "Neither curl nor wget found. Cannot download files."
  fi
}

download_file() {
  local url="$1" dest="$2"
  info "Downloading from $url ..."
  if command -v curl >/dev/null 2>&1; then
    curl -fSL --progress-bar -o "$dest" "$url" \
      --retry 5 --retry-delay 3 --retry-connrefused -C - \
      || die "Download failed: $url"
  elif command -v wget >/dev/null 2>&1; then
    wget --show-progress -qO "$dest" "$url" \
      --tries=5 --wait=3 -c \
      || die "Download failed: $url"
  fi
}

parse_version() {
  local manifest="$1"
  echo "$manifest" | grep '^version:' | sed 's/^version: *//'
}

parse_url() {
  local manifest="$1" extension="$2"
  echo "$manifest" | grep "url:" | grep "\.${extension}" | head -1 | sed 's/.*url: *//'
}

parse_sha512() {
  local manifest="$1" filename="$2"
  local in_entry=0
  echo "$manifest" | while IFS= read -r line; do
    if echo "$line" | grep -q "url:.*${filename}"; then
      in_entry=1
    elif [ "$in_entry" = "1" ] && echo "$line" | grep -q "sha512:"; then
      echo "$line" | sed 's/.*sha512: *//'
      break
    elif [ "$in_entry" = "1" ] && echo "$line" | grep -q "^  - "; then
      break
    fi
  done
}

verify_checksum() {
  local file="$1" expected_b64="$2" os="$3"

  info "Verifying checksum..."

  if [ "$os" = "macos" ]; then
    actual_hex=$(shasum -a 512 "$file" | awk '{print $1}')
  elif command -v sha512sum >/dev/null 2>&1; then
    actual_hex=$(sha512sum "$file" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual_hex=$(shasum -a 512 "$file" | awk '{print $1}')
  else
    warn "No sha512 tool found - skipping checksum verification"
    return 0
  fi

  expected_hex=$(echo "$expected_b64" | base64 -d 2>/dev/null | od -An -tx1 | tr -d ' \n' || \
                 echo "$expected_b64" | base64 --decode 2>/dev/null | od -An -tx1 | tr -d ' \n')

  if [ -z "$expected_hex" ]; then
    die "Failed to decode base64 checksum from manifest"
  fi

  if [ "$actual_hex" != "$expected_hex" ]; then
    err "Checksum mismatch!"
    err "  Expected: $expected_hex"
    err "  Got:      $actual_hex"
    die "The downloaded file may be corrupted. Aborting."
  fi

  ok "Checksum verified"
}

install_macos() {
  local dmg_path="$1"

  info "Mounting disk image..."
  local mount_point
  mount_point=$(hdiutil attach -nobrowse -readonly "$dmg_path" 2>/dev/null | grep '/Volumes/' | sed 's/.*\(\/Volumes\/.*\)/\1/')

  if [ -z "$mount_point" ]; then
    die "Failed to mount .dmg"
  fi

  local app_path
  app_path=$(find "$mount_point" -maxdepth 1 -name "*.app" | head -1)

  if [ -z "$app_path" ]; then
    hdiutil detach "$mount_point" -quiet 2>/dev/null || true
    die "No .app found in disk image"
  fi

  local app_name
  app_name=$(basename "$app_path")

  info "Installing $app_name to /Applications..."
  if [ -d "/Applications/$app_name" ]; then
    rm -rf "/Applications/$app_name"
  fi
  cp -R "$app_path" "/Applications/"

  info "Unmounting disk image..."
  hdiutil detach "$mount_point" -quiet 2>/dev/null || true

  ok "Wolffish installed to /Applications/$app_name"
  info "You can launch it from Spotlight or run: open /Applications/$app_name"
}

# True if we can run a command as root (already root, or sudo is available).
can_root() {
  [ "$(id -u)" -eq 0 ] && return 0
  command -v sudo >/dev/null 2>&1
}

# Run a command as root — directly when already root, otherwise via sudo.
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# Native package format for this distro, chosen by available package manager.
# deb covers Debian/Ubuntu/Mint/Pop!_OS/etc.; rpm covers Fedora/RHEL/openSUSE/etc.;
# anything else (e.g. Arch) gets the portable AppImage.
detect_linux_format() {
  if command -v apt-get >/dev/null 2>&1 || command -v dpkg >/dev/null 2>&1; then
    echo deb
  elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1 \
    || command -v yum >/dev/null 2>&1 || command -v rpm >/dev/null 2>&1; then
    echo rpm
  else
    echo AppImage
  fi
}

# Pick the best artifact to install: the native .deb/.rpm when we can actually
# install it (supported package manager AND root AND the release ships it),
# otherwise the portable AppImage, which installs under $HOME with no root.
choose_linux_extension() {
  local manifest="$1" fmt
  fmt=$(detect_linux_format)
  if [ "$fmt" != "AppImage" ]; then
    if ! can_root; then
      fmt="AppImage"
    elif [ -z "$(parse_url "$manifest" "$fmt")" ]; then
      fmt="AppImage"
    fi
  fi
  echo "$fmt"
}

# Ask dpkg whether the package is installed AND configured.
#
# This is the only honest test of a .deb install, because a failing one does not
# reliably fail loudly: `apt-get -f install` resolves a dependency it cannot
# satisfy by REMOVING the package that needs it, and exits 0 having done so. An
# installer that trusts exit statuses alone therefore announces a successful
# install of nothing at all — and never falls back, because as far as it knows
# there is nothing to fall back from.
deb_installed() {
  local status
  status=$(dpkg-query -W -f='${Status}' "$PACKAGE_NAME" 2>/dev/null || true)
  case "$status" in
    *" ok installed") return 0 ;;
    *) return 1 ;;
  esac
}

rpm_installed() {
  rpm -q "$PACKAGE_NAME" >/dev/null 2>&1
}

# Said when the package manager could not satisfy Wolffish's dependencies. The
# library list is read out of the package itself so it cannot drift from what
# electron-builder actually shipped.
deps_hint() {
  local deps
  deps=$(dpkg-deb -f "$1" Depends 2>/dev/null | tr ',' ' ' | tr -s ' ' || true)
  err "Could not install Wolffish's system libraries."
  [ -n "$deps" ] && printf "  Wolffish needs: %s\n" "$deps" >&2
  printf "  Install them first with: %s\n" "sudo apt-get update && sudo apt-get -f install" >&2
}

# Install a .deb via apt so dependencies resolve — then prove it worked.
install_deb() {
  local deb="$1"

  info "Installing the Debian package (you may be prompted for your password)..."

  if command -v apt-get >/dev/null 2>&1; then
    local refreshed=0

    # Ask the solver first, in a simulation that downloads nothing and prints
    # nothing. On a machine with stale package lists — a fresh VPS image, or
    # one whose mirror cloud-init rewrote and never refreshed — every library
    # the app needs reads as "not installable" while sitting one `apt-get
    # update` away, and apt says so in a page of unmet dependencies ending in
    # "held broken packages". That text describes the LISTS, not the machine,
    # and it is the last thing anyone should read during an install that is
    # about to succeed. Simulating moves the decision ahead of any output, so
    # the only apt failure a user ever sees is a real one.
    if ! as_root apt-get install -s -y "$deb" >/dev/null 2>&1; then
      info "Package lists look stale — refreshing them..."
      as_root apt-get update || true
      refreshed=1
    fi

    # The real thing, output and all: this is the long step, and watching 100 MB
    # of dependencies arrive is the difference between working and hung.
    as_root apt-get install -y "$deb" && deb_installed && return 0

    # Lists can satisfy the solver and still be stale enough to 404 on the
    # fetch, which a simulation cannot predict. Worth one refresh — but only
    # if the check above did not already do it.
    if [ "$refreshed" = "0" ]; then
      info "Refreshing package lists and retrying..."
      as_root apt-get update || true
      as_root apt-get install -y "$deb" && deb_installed && return 0
    fi
  fi

  # No apt, or an apt too old to install from a file path. dpkg alone cannot
  # fetch dependencies, so this only lands the package; apt then completes it.
  as_root dpkg -i "$deb" >/dev/null 2>&1 || true
  if command -v apt-get >/dev/null 2>&1; then
    # --no-remove because apt's way of "fixing" a dependency it cannot satisfy
    # is to remove packages until the problem is gone — starting with the one
    # just unpacked, and not necessarily stopping there. Refuse that trade on
    # a machine whose only instruction was to install something.
    as_root apt-get install -f -y --no-remove >/dev/null 2>&1 || true
  fi
  deb_installed && return 0

  # Leave nothing half-unpacked: an unconfigured package makes every later apt
  # run on this machine fail, on a box that never got a working Wolffish.
  as_root dpkg --remove "$PACKAGE_NAME" >/dev/null 2>&1 || true
  deps_hint "$deb"
  return 1
}

# Install a .rpm via the system package manager (resolves dependencies).
install_rpm() {
  info "Installing the RPM package (you may be prompted for your password)..."
  if command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y "$1" || true
  elif command -v zypper >/dev/null 2>&1; then
    as_root zypper --non-interactive install --allow-unsigned-rpm "$1" || true
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y "$1" || true
  else
    as_root rpm -i "$1" || true
  fi
  rpm_installed && return 0
  err "Could not install Wolffish's system libraries."
  return 1
}

# An AppImage mounts itself to run, and ours needs two separate things to do it.
#
# electron-builder builds this app with its default (legacy) AppImage toolset —
# AppImageKit 12, whose runtime dlopens libfuse.so.2 and exits when it is not
# there. Ubuntu 22.04+, Debian 12, Fedora and Arch all ship FUSE 3 only, so that
# is most current machines. Mounting then also needs the kernel's /dev/fuse,
# which a container started without the device does not have.
#
# Either one missing means the same thing — this box cannot mount an AppImage —
# and the runtime's answer to that is APPIMAGE_EXTRACT_AND_RUN, which unpacks
# into $TMPDIR instead. It costs hundreds of megabytes per launch, so it is only
# ever worth baking in when a plain exec genuinely cannot work.
can_mount_appimage() {
  [ -e /dev/fuse ] || return 1
  { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q 'libfuse\.so\.2'
}

# Portable AppImage: no root needed, works on any distro. Universal fallback.
#
# Everything lands under ~/.wolffish, including the launcher — so `rm -rf
# ~/.wolffish` stays a complete uninstall (the app's own rule), nothing 600 MB
# large is parked in a bin directory, and the ONE PATH entry the app already
# asks for covers the launcher, the CLI shim the app writes next to it, and the
# gog/ffmpeg/voice binaries that are already there.
#
# The launcher is `wolffish-app`, the same name the .deb and .rpm give the app
# binary, and deliberately NOT `wolffish` — that name belongs to the CLI shim.
# Two different programs answering to one name, resolved by PATH order, is a
# coin flip nobody can debug.
install_appimage() {
  local home_dir="$HOME/.wolffish"
  local app_path="$home_dir/Wolffish.AppImage"
  local bin_dir="$home_dir/bin"
  local launcher="$bin_dir/$EXE_NAME"
  local extract=""

  mkdir -p "$home_dir" "$bin_dir"

  info "Installing to $app_path..."
  cp "$1" "$app_path"
  chmod +x "$app_path"

  if ! can_mount_appimage; then
    info "This system cannot mount an AppImage — the launcher will self-extract."
    extract="APPIMAGE_EXTRACT_AND_RUN=1 "
  fi

  printf '%s\n' \
    '#!/bin/sh' \
    '# Wolffish AppImage launcher — written by the installer, safe to regenerate.' \
    "${extract}exec \"$app_path\" \"\$@\"" > "$launcher"
  chmod +x "$launcher"

  ok "Wolffish installed to $app_path"
  add_to_path "$bin_dir"
  is_headless_host || info "Launch with: $EXE_NAME"
}

# Put ~/.wolffish/bin on PATH, because on this route nothing else can.
#
# A .deb or .rpm ships /usr/bin/wolffish and needs none of this. An AppImage has
# no package manager and no system directory to write to, so a PATH line in a
# shell profile is the only way the command becomes findable — and an install
# that ends by handing someone homework is an install that is not finished.
# Skipped when the directory is already on PATH, and it appends only a line that
# is not already in the file, so re-running the installer never stacks them up.
add_to_path() {
  local dir="$1" rc line
  PATH_HANDLED=1
  [ "$MODIFY_PATH" = "1" ] || { info "Add $dir to your PATH to use the command."; return 0; }

  case ":$PATH:" in
    *":$dir:"*) return 0 ;;
  esac

  rc=$(profile_file)
  line=$(path_line "$dir")

  if [ -f "$rc" ] && grep -qF "$line" "$rc" 2>/dev/null; then
    info "$rc already adds it — open a new terminal to pick it up."
    return 0
  fi

  mkdir -p "$(dirname "$rc")"
  printf '\n# Added by the Wolffish installer\n%s\n' "$line" >> "$rc" || {
    warn "Could not write $rc — add this line yourself:"
    printf "    ${BOLD}%s${RESET}\n\n" "$line"
    return 0
  }
  ok "Added $dir to your PATH in $rc"
  info "Open a new terminal, or run: . $rc"
}

# A box with no display server is what the CLI exists for — and the two things a
# desktop install signs off with are the two things it does not have: an
# application menu, and a `wolffish` that opens a window. Electron aborts on a
# display it cannot find unless the launch says headless was the intent.
is_headless_host() {
  [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]
}

native_ok() {
  if is_headless_host; then
    ok "Wolffish installed"
  else
    ok "Wolffish installed — find it in your application menu or run: $EXE_NAME"
  fi
}

# A machine with no display has no icon to click, and no `wolffish` yet either —
# so "launch it once" is not an instruction it can follow. Name the binary it
# actually has, with the flag that stops Electron from aborting on a display
# server it will never find.
#
# --no-sandbox is not optional here and not a suggestion: Chromium aborts as
# root with the sandbox on, before any of the app's own code runs, and a VPS
# logs you in as root. The app is unsandboxed by design either way.
headless_start_notice() {
  is_headless_host || return 0

  # With `wolffish` already on PATH there is no dance left to describe: the CLI
  # starts the agent itself, in the background, with the flags a root VPS needs.
  # Telling someone to run the app binary by hand instead is how they end up
  # with a daemon holding their terminal and a prompt that ignores them.
  if command -v wolffish >/dev/null 2>&1; then
    printf "  No display detected. The agent starts itself the first time you run:\n\n"
    printf "    ${BOLD}wolffish${RESET}\n\n"
    return 0
  fi

  printf "  No display detected — start the agent with:\n\n"
  printf "    ${BOLD}%s --headless --no-sandbox &${RESET}\n\n" "$EXE_NAME"
  printf "  The first run is also what creates the ${BOLD}wolffish${RESET} command.\n\n"
}

# Dispatch to the right installer for the chosen artifact. If a native package
# install fails, best-effort fall back to the portable AppImage.
install_linux() {
  local path="$1" ext="$2" manifest="$3" os="$4" ai_url ai_file ai_sha

  case "$ext" in
    deb) install_deb "$path" && { native_ok; return 0; } ;;
    rpm) install_rpm "$path" && { native_ok; return 0; } ;;
    *)   install_appimage "$path"; return $? ;;
  esac

  warn "Native package install failed; falling back to the portable AppImage..."
  ai_url=$(parse_url "$manifest" "AppImage")
  [ -n "$ai_url" ] || die "No AppImage available to fall back to"
  ai_file="$TEMP_DIR/$(basename "$ai_url")"
  download_file "$RELEASES_BASE/$ai_url" "$ai_file"
  ai_sha=$(parse_sha512 "$manifest" "$(basename "$ai_url")")
  [ -n "$ai_sha" ] && verify_checksum "$ai_file" "$ai_sha" "$os"
  install_appimage "$ai_file"
}

install_windows() {
  local exe_path="$1"

  info "Running installer silently..."
  "$exe_path" /S
  ok "Wolffish installed"
  info "You can launch Wolffish from the Start Menu."
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --help|-h) usage ;;
      --no-modify-path) MODIFY_PATH=0 ;;
      --version|-v)
        os=$(detect_os)
        case "$os" in
          macos)   manifest=$(fetch_manifest "$RELEASES_BASE/latest-mac.yml") ;;
          linux)   manifest=$(fetch_manifest "$RELEASES_BASE/latest-linux.yml") ;;
          windows) manifest=$(fetch_manifest "$RELEASES_BASE/latest.yml") ;;
        esac
        version=$(parse_version "$manifest")
        printf "%s\n" "$version"
        exit 0
        ;;
      *) die "Unknown option: $arg. Use --help for usage." ;;
    esac
  done

  banner

  os=$(detect_os)
  info "Detected OS: $os"

  case "$os" in
    macos)
      manifest=$(fetch_manifest "$RELEASES_BASE/latest-mac.yml")
      extension="dmg"
      ;;
    linux)
      manifest=$(fetch_manifest "$RELEASES_BASE/latest-linux.yml")
      extension=$(choose_linux_extension "$manifest")
      info "Selected Linux package: .$extension"
      ;;
    windows)
      manifest=$(fetch_manifest "$RELEASES_BASE/latest.yml")
      extension="exe"
      ;;
  esac

  version=$(parse_version "$manifest")
  if [ -z "$version" ]; then
    die "Could not determine latest version from manifest"
  fi
  ok "Latest version: $version"

  rel_url=$(parse_url "$manifest" "$extension")
  if [ -z "$rel_url" ]; then
    die "Could not find .$extension download URL in manifest"
  fi

  filename=$(basename "$rel_url")
  sha512_b64=$(parse_sha512 "$manifest" "$filename")
  if [ -z "$sha512_b64" ]; then
    warn "No checksum found in manifest - skipping verification"
  fi

  download_url="$RELEASES_BASE/$rel_url"

  TEMP_DIR=$(mktemp -d)
  # mktemp gives 0700, which apt cannot see into: it drops to the unprivileged
  # `_apt` user to fetch, fails to read the package sitting in root's private
  # directory, and prints a permission-denied notice before falling back to
  # working as root. Harmless, and alarming in the middle of an install that
  # worked. The contents are a public release artifact whose checksum is
  # verified below, world-READABLE and still owner-write-only, and the whole
  # directory is removed on exit either way.
  chmod 755 "$TEMP_DIR"
  local dest="$TEMP_DIR/$filename"

  download_file "$download_url" "$dest"
  ok "Download complete"

  if [ -n "$sha512_b64" ]; then
    verify_checksum "$dest" "$sha512_b64" "$os"
  fi

  case "$os" in
    macos)   install_macos "$dest" ;;
    linux)   install_linux "$dest" "$extension" "$manifest" "$os" || die "Wolffish was not installed." ;;
    windows) install_windows "$dest" ;;
  esac

  printf "\n  ${GREEN}${BOLD}Wolffish v%s installed successfully!${RESET}\n\n" "$version"

  # PATH first, then how to start: on an AppImage install the binary named
  # below IS in the directory the notice above adds, so the other order tells
  # people to run a command that cannot resolve yet.
  cli_path_notice
  [ "$os" = "linux" ] && headless_start_notice
  return 0
}

# The `wolffish` command is written by the app itself on first launch (it is
# idempotent, and it has to be re-pointed after every update anyway, so the app
# is the only place that can keep it correct). What the app cannot do is edit a
# shell profile — so the one thing left is telling the user whether its folder
# is already on PATH, and exactly what to add if it isn't.
#
# ~/.wolffish/bin, not ~/.local/bin: everything the app writes lives under
# ~/.wolffish so `rm -rf ~/.wolffish` is a complete uninstall. The same
# directory already holds gog, ffmpeg and the voice engines, so one PATH entry
# covers all of them.
cli_path_notice() {
  # The AppImage route has already dealt with PATH and said so. A second,
  # differently-worded notice about the same directory is how a finished
  # install reads as broken.
  [ "$PATH_HANDLED" = "1" ] && return 0

  # A .deb or .rpm ships /usr/bin/wolffish, so the command resolves the moment
  # the package manager finishes — nothing to add, and nothing to warn about.
  if command -v wolffish >/dev/null 2>&1; then
    info "The 'wolffish' command is ready."
    return 0
  fi

  local bin_dir="$HOME/.wolffish/bin"
  case ":$PATH:" in
    *":$bin_dir:"*)
      info "The 'wolffish' command will be available after the first launch."
      return 0
      ;;
  esac

  warn "$bin_dir is not on your PATH — the 'wolffish' command won't be found."
  printf "  Add it with:\n\n"
  printf "    ${BOLD}echo '%s' >> %s${RESET}\n\n" "$(path_line "$bin_dir")" "$(profile_file)"
  printf "  Then restart your shell. You can re-check any time with:\n"
  printf "    ${BOLD}wolffish path status${RESET}\n\n"
}

# Where a PATH line belongs, and what it should say — the login shell decides
# both, and fish spells the line differently from every other shell.
profile_file() {
  case "$(basename "${SHELL:-sh}")" in
    zsh)  echo "$HOME/.zshrc" ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *)    echo "$HOME/.bashrc" ;;
  esac
}

path_line() {
  case "$(basename "${SHELL:-sh}")" in
    fish) echo "fish_add_path $1" ;;
    *)    echo "export PATH=\"$1:\$PATH\"" ;;
  esac
}

main "$@"
