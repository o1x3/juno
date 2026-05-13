#!/bin/sh
# shellcheck shell=sh
#
# Juno installer.
#
# Usage:
#   curl -sSfL https://raw.githubusercontent.com/o1x3/juno/main/scripts/install.sh | sh
#   curl -sSfL .../install.sh | sh -s -- --help
#
# Flags:
#   --install-dir <path>    Install location (default: $HOME/.local/bin)
#   --system                Shortcut for --install-dir /usr/local/bin
#   --sudo                  Use sudo to write into a non-writable install dir
#   --version <tag>         Install a specific tag (default: latest)
#   --no-modify-path        Do not edit shell rc files; just print the line
#   --quiet                 Suppress wordmark and \r redraws (CI mode)
#   --dry-run               Print what would be done; fetch nothing
#   --help                  Show this help and exit
#
# Env equivalents:
#   JUNO_INSTALL_DIR        Same as --install-dir
#   JUNO_NO_MODIFY_PATH=1   Same as --no-modify-path
#   VERSION=v0.2.1          Same as --version
#
# Manual verification checklist (run by maintainer before tagging a release):
#   1. TTY rendering   : run interactively; verify wordmark + green ✓ glyphs
#   2. Non-TTY        : pipe to `cat -A`; verify no ANSI escapes leak
#   3. --dry-run       : prints plan, fetches nothing
#   4. --system        : installs to /usr/local/bin
#   5. --version v0.1.1: installs the pinned tag, not latest
#   6. PATH missing    : ~/.local/bin not on PATH, run, verify rc edit + note
#   7. Existing install: re-run, verify "upgrading vX → vY" line
#   8. Refuse root     : sudo sh install.sh without --system → exit 1
#
# Reference patterns this script borrows from:
#   rustup (sh.rustup.rs), uv (astral.sh/uv/install.sh),
#   bun (bun.sh/install), starship.

set -eu

REPO="o1x3/juno"
DEFAULT_INSTALL_DIR="${HOME}/.local/bin"
SYSTEM_INSTALL_DIR="/usr/local/bin"

INSTALL_DIR=""
USE_SUDO=0
SYSTEM_MODE=0
PIN_VERSION=""
NO_MODIFY_PATH=0
QUIET=0
DRY_RUN=0

# Parse flags first so we know whether to emit colors before anything else.
while [ $# -gt 0 ]; do
    case "$1" in
        --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
        --install-dir=*) INSTALL_DIR="${1#*=}"; shift ;;
        --system) SYSTEM_MODE=1; shift ;;
        --sudo) USE_SUDO=1; shift ;;
        --version) PIN_VERSION="${2:-}"; shift 2 ;;
        --version=*) PIN_VERSION="${1#*=}"; shift ;;
        --no-modify-path) NO_MODIFY_PATH=1; shift ;;
        --quiet) QUIET=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --help|-h)
            sed -n '3,28p' "$0" 2>/dev/null || cat <<EOF
Juno installer. Run with --help via the script source for full flags.
EOF
            exit 0
            ;;
        *)
            printf "unknown argument: %s\n" "$1" >&2
            exit 2
            ;;
    esac
done

# Env defaults (CLI flags win).
[ -z "$INSTALL_DIR" ] && INSTALL_DIR="${JUNO_INSTALL_DIR:-}"
[ -z "$INSTALL_DIR" ] && [ "$SYSTEM_MODE" -eq 1 ] && INSTALL_DIR="$SYSTEM_INSTALL_DIR"
[ -z "$INSTALL_DIR" ] && INSTALL_DIR="$DEFAULT_INSTALL_DIR"
[ -z "$PIN_VERSION" ] && PIN_VERSION="${VERSION:-}"
[ "${JUNO_NO_MODIFY_PATH:-0}" = "1" ] && NO_MODIFY_PATH=1

# ---------- output helpers ----------

if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ "$QUIET" -eq 0 ]; then
    C_BOLD=$(printf '\033[1m')
    C_DIM=$(printf '\033[2m')
    C_RED=$(printf '\033[31m')
    C_GREEN=$(printf '\033[32m')
    C_YELLOW=$(printf '\033[33m')
    C_BLUE=$(printf '\033[34m')
    C_RESET=$(printf '\033[0m')
    G_RUN="…"
    G_OK="✓"
    G_FAIL="✗"
    TTY=1
else
    C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
    G_RUN="[ ]"
    G_OK="[x]"
    G_FAIL="[!]"
    TTY=0
fi

say()  { printf "%s\n" "$*"; }
note() { printf "%s%s%s\n" "$C_DIM" "$*" "$C_RESET"; }
warn() { printf "%s%s%s %s\n" "$C_YELLOW" "$G_FAIL" "$C_RESET" "$*" >&2; }
err()  { printf "%s%s install failed:%s %s\n" "$C_RED" "$G_FAIL" "$C_RESET" "$*" >&2; }

# step <label> <detail-on-success>
# Use phase_start/phase_end pairs around the actual work.
phase_start() {
    PHASE_LABEL="$1"
    PHASE_DETAIL_DEFAULT="$2"
    if [ "$TTY" -eq 1 ]; then
        printf "  %s%s%s  %-11s %s%s%s\r" "$C_DIM" "$G_RUN" "$C_RESET" "$PHASE_LABEL" "$C_DIM" "$PHASE_DETAIL_DEFAULT" "$C_RESET"
    else
        printf "  %s  %-11s %s\n" "$G_RUN" "$PHASE_LABEL" "$PHASE_DETAIL_DEFAULT"
    fi
}
phase_end() {
    detail="${1:-$PHASE_DETAIL_DEFAULT}"
    if [ "$TTY" -eq 1 ]; then
        printf "\r\033[K  %s%s%s  %-11s %s\n" "$C_GREEN" "$G_OK" "$C_RESET" "$PHASE_LABEL" "$detail"
    else
        printf "  %s  %-11s %s\n" "$G_OK" "$PHASE_LABEL" "$detail"
    fi
}
phase_fail() {
    detail="${1:-failed}"
    if [ "$TTY" -eq 1 ]; then
        printf "\r\033[K  %s%s%s  %-11s %s%s%s\n" "$C_RED" "$G_FAIL" "$C_RESET" "$PHASE_LABEL" "$C_RED" "$detail" "$C_RESET"
    else
        printf "  %s  %-11s %s\n" "$G_FAIL" "$PHASE_LABEL" "$detail"
    fi
}

wordmark() {
    [ "$QUIET" -eq 1 ] && return
    printf "\n"
    printf "  %s╭──────────────╮%s\n" "$C_BLUE" "$C_RESET"
    printf "  %s│     juno     │%s\n" "$C_BLUE" "$C_RESET"
    printf "  %s╰──────────────╯%s\n" "$C_BLUE" "$C_RESET"
    printf "  %scodex-first local coding agent%s\n\n" "$C_DIM" "$C_RESET"
}

# Refuse `sudo curl | sudo sh` accidents; only allow root when --system + --sudo.
if [ "$(id -u 2>/dev/null || echo 0)" = "0" ] && [ "$SYSTEM_MODE" -eq 0 ]; then
    err "refusing to run as root without --system (would clobber system paths)"
    say "  rerun: ${C_BOLD}sh install.sh --system --sudo${C_RESET}"
    exit 1
fi

wordmark

# ---------- platform detection ----------

phase_start "detect" "platform"

OS=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
ARCH_RAW=$(uname -m 2>/dev/null)

case "$ARCH_RAW" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    armv7l|armhf|armv6l)
        phase_fail "unsupported 32-bit ARM"
        err "32-bit ARM is not supported. Juno ships x64 and arm64 only."
        exit 1
        ;;
    *)
        phase_fail "unsupported arch: $ARCH_RAW"
        err "set JUNO_INSTALL_DIR and build from source if you need this arch."
        exit 1
        ;;
esac

case "$OS" in
    linux|darwin) ;;
    *)
        phase_fail "unsupported OS: $OS"
        err "Juno ships macOS and Linux binaries only."
        exit 1
        ;;
esac

# Detect rosetta-translated x64 on Apple Silicon.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
    if command -v sysctl >/dev/null 2>&1; then
        translated=$(sysctl -in sysctl.proc_translated 2>/dev/null || echo "")
        if [ "$translated" = "1" ]; then
            ARCH="arm64"
            note "  detected rosetta; switching to arm64 for native execution"
        fi
    fi
fi

# Detect musl on Linux — we don't ship a musl build yet.
if [ "$OS" = "linux" ]; then
    if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
        phase_fail "musl libc detected; only glibc builds are published"
        err "open an issue at https://github.com/$REPO/issues if you need a musl build"
        exit 1
    fi
fi

phase_end "$OS / $ARCH"

# ---------- fetch helpers ----------

have_curl=0
have_wget=0
command -v curl >/dev/null 2>&1 && have_curl=1
command -v wget >/dev/null 2>&1 && have_wget=1
if [ "$have_curl" -eq 0 ] && [ "$have_wget" -eq 0 ]; then
    err "curl or wget required"
    exit 1
fi

fetch() {
    url="$1"; out="$2"
    if [ "$have_curl" -eq 1 ]; then
        # `-f` (in -sSfL) already fails on HTTP errors; --fail-with-body needs
        # curl 7.76+ which isn't on every macOS so we skip it for compatibility.
        curl --proto '=https' --tlsv1.2 -sSfL --retry 3 --retry-delay 2 \
             --retry-connrefused "$url" -o "$out"
    else
        wget -q --tries=3 --timeout=20 "$url" -O "$out"
    fi
}

fetch_stdout() {
    url="$1"
    if [ "$have_curl" -eq 1 ]; then
        curl --proto '=https' --tlsv1.2 -sSfL --retry 3 --retry-delay 2 \
             --retry-connrefused "$url"
    else
        wget -qO- --tries=3 --timeout=20 "$url"
    fi
}

# ---------- resolve version ----------

phase_start "resolve" "GitHub releases"

if [ -n "$PIN_VERSION" ]; then
    VERSION_TAG="$PIN_VERSION"
    case "$VERSION_TAG" in v*) ;; *) VERSION_TAG="v${VERSION_TAG}" ;; esac
else
    if [ "$DRY_RUN" -eq 1 ]; then
        VERSION_TAG="(latest)"
    else
        api_json=$(fetch_stdout "https://api.github.com/repos/${REPO}/releases/latest") || {
            phase_fail "GitHub API call failed"
            exit 1
        }
        VERSION_TAG=$(printf "%s" "$api_json" | grep '"tag_name"' | head -n1 | cut -d'"' -f4)
        if [ -z "$VERSION_TAG" ]; then
            phase_fail "could not parse tag_name"
            exit 1
        fi
    fi
fi

PLAIN_VERSION="${VERSION_TAG#v}"
phase_end "$VERSION_TAG"

# ---------- download + verify ----------

FILENAME="juno-${PLAIN_VERSION}-${OS}-${ARCH}.tar.gz"
TARBALL_URL="https://github.com/${REPO}/releases/download/${VERSION_TAG}/${FILENAME}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION_TAG}/checksums.txt"

note "  url: $TARBALL_URL"

if [ "$DRY_RUN" -eq 1 ]; then
    say ""
    say "${C_BOLD}--dry-run: stopping before download${C_RESET}"
    say "  would install: $INSTALL_DIR/juno"
    say "  would download: $TARBALL_URL"
    [ "$NO_MODIFY_PATH" -eq 0 ] && say "  would edit shell rc (if PATH missing)"
    exit 0
fi

phase_start "download" "$FILENAME"

TMPDIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'juno-install')
trap 'rm -rf "$TMPDIR"' EXIT INT TERM HUP

if ! fetch "$TARBALL_URL" "$TMPDIR/$FILENAME"; then
    phase_fail "download failed"
    err "could not fetch $TARBALL_URL"
    say "  to retry: ${C_BOLD}curl -sSfL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sh${C_RESET}"
    exit 1
fi

SIZE=$(wc -c < "$TMPDIR/$FILENAME" | tr -d ' ')
SIZE_HUMAN=$(awk -v b="$SIZE" 'BEGIN { printf "%.1f MB", b/1024/1024 }')
phase_end "$FILENAME ($SIZE_HUMAN)"

phase_start "verify" "sha256"

if fetch "$CHECKSUMS_URL" "$TMPDIR/checksums.txt" 2>/dev/null; then
    EXPECTED=$(grep -F "$FILENAME" "$TMPDIR/checksums.txt" | awk '{print $1}' | head -n1)
    if [ -z "$EXPECTED" ]; then
        phase_fail "no entry for $FILENAME in checksums.txt"
        exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        ACTUAL=$(sha256sum "$TMPDIR/$FILENAME" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
        ACTUAL=$(shasum -a 256 "$TMPDIR/$FILENAME" | awk '{print $1}')
    else
        phase_fail "no sha256sum or shasum binary available"
        exit 1
    fi
    if [ "$EXPECTED" != "$ACTUAL" ]; then
        phase_fail "checksum mismatch"
        err "expected: $EXPECTED"
        err "actual:   $ACTUAL"
        exit 1
    fi
    SHORT_SHA=$(printf "%s" "$ACTUAL" | cut -c1-12)
    # Brace the expansion: macOS /bin/sh greedily reads the UTF-8 ellipsis
    # bytes as part of the variable name and then errors under `set -u`.
    phase_end "sha256: ${SHORT_SHA}…"
else
    phase_fail "checksums.txt unreachable"
    err "refusing to install without verifying integrity"
    exit 1
fi

# ---------- install ----------

phase_start "install" "$INSTALL_DIR/juno"

tar -xzf "$TMPDIR/$FILENAME" -C "$TMPDIR"
if [ ! -f "$TMPDIR/juno" ]; then
    phase_fail "tarball missing juno binary"
    exit 1
fi
chmod +x "$TMPDIR/juno"

mkdir -p "$INSTALL_DIR" 2>/dev/null || true

TARGET="$INSTALL_DIR/juno"
EXISTING_VERSION=""
if [ -x "$TARGET" ]; then
    EXISTING_VERSION=$("$TARGET" --version 2>/dev/null | head -n1 | tr -d '[:space:]' || true)
fi

place_binary() {
    src="$1"; dst="$2"
    if [ -w "$(dirname "$dst")" ] || [ -w "$dst" ]; then
        mv "$src" "$dst.new"
        chmod +x "$dst.new"
        mv "$dst.new" "$dst"
        return 0
    fi
    if [ "$USE_SUDO" -eq 1 ] && command -v sudo >/dev/null 2>&1; then
        sudo mv "$src" "$dst.new"
        sudo chmod +x "$dst.new"
        sudo mv "$dst.new" "$dst"
        return 0
    fi
    return 1
}

if ! place_binary "$TMPDIR/juno" "$TARGET"; then
    phase_fail "$INSTALL_DIR is not writable"
    err "rerun with --sudo, or pick another --install-dir"
    exit 1
fi

if [ "$OS" = "darwin" ]; then
    if [ -w "$TARGET" ]; then
        xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
    elif [ "$USE_SUDO" -eq 1 ]; then
        sudo xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
    fi
fi

# Sanity-check the freshly installed binary actually runs and prints a version.
if INSTALLED_VERSION=$("$TARGET" --version 2>/dev/null | head -n1 | tr -d '[:space:]'); then
    if [ -n "$INSTALLED_VERSION" ] && [ "$INSTALLED_VERSION" != "$PLAIN_VERSION" ]; then
        warn "installed binary reports v$INSTALLED_VERSION but expected v$PLAIN_VERSION"
    fi
else
    phase_fail "installed binary failed to run --version"
    err "this usually means an arch mismatch; please open an issue"
    exit 1
fi

if [ -n "$EXISTING_VERSION" ] && [ "$EXISTING_VERSION" != "$PLAIN_VERSION" ]; then
    phase_end "$INSTALL_DIR/juno  (v$EXISTING_VERSION → v$PLAIN_VERSION)"
else
    phase_end "$INSTALL_DIR/juno  (v$PLAIN_VERSION)"
fi

# ---------- PATH wiring ----------

PATH_STATUS="ok"
case ":$PATH:" in
    *":$INSTALL_DIR:"*) PATH_STATUS="on-path" ;;
    *) PATH_STATUS="missing" ;;
esac

PATH_RC=""
PATH_MARKER_START="# >>> juno install >>>"
PATH_MARKER_END="# <<< juno install <<<"

shell_name=$(basename "${SHELL:-/bin/sh}")
case "$shell_name" in
    zsh) PATH_RC="$HOME/.zshenv" ;;
    bash)
        if [ "$OS" = "darwin" ] && [ -f "$HOME/.bash_profile" ]; then
            PATH_RC="$HOME/.bash_profile"
        else
            PATH_RC="$HOME/.bashrc"
        fi
        ;;
    fish) PATH_RC="$HOME/.config/fish/conf.d/juno.fish" ;;
    *) PATH_RC="$HOME/.profile" ;;
esac

write_path_block() {
    rc="$1"
    mkdir -p "$(dirname "$rc")" 2>/dev/null || true
    # Idempotent: if the start marker is already there, skip the write.
    if [ -f "$rc" ] && grep -qF "$PATH_MARKER_START" "$rc"; then
        return 0
    fi
    if [ "$shell_name" = "fish" ]; then
        {
            printf "\n%s\n" "$PATH_MARKER_START"
            printf "# Added by Juno installer on %s. Remove or replace freely.\n" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
            printf 'if test -d "%s"; and not contains "%s" $PATH\n    set -gx PATH "%s" $PATH\nend\n' "$INSTALL_DIR" "$INSTALL_DIR" "$INSTALL_DIR"
            printf "%s\n" "$PATH_MARKER_END"
        } >> "$rc"
    else
        {
            printf "\n%s\n" "$PATH_MARKER_START"
            printf "# Added by Juno installer on %s. Remove or replace freely.\n" "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
            printf 'case ":$PATH:" in *":%s:"*) ;; *) export PATH="%s:$PATH" ;; esac\n' "$INSTALL_DIR" "$INSTALL_DIR"
            printf "%s\n" "$PATH_MARKER_END"
        } >> "$rc"
    fi
}

if [ "$PATH_STATUS" = "missing" ]; then
    if [ "$NO_MODIFY_PATH" -eq 1 ]; then
        note "  $INSTALL_DIR is not on \$PATH; add this to your shell rc:"
        if [ "$shell_name" = "fish" ]; then
            note "    fish_add_path \"$INSTALL_DIR\""
        else
            note "    export PATH=\"$INSTALL_DIR:\$PATH\""
        fi
    else
        write_path_block "$PATH_RC"
        note "  added $INSTALL_DIR to PATH in $PATH_RC"
        note "  open a new shell, or run: exec \$SHELL"
    fi
fi

# Warn about shadowing installs in other common locations.
for candidate in /usr/local/bin "$HOME/.local/bin" "$HOME/.juno/bin"; do
    if [ "$candidate" = "$INSTALL_DIR" ]; then continue; fi
    if [ -x "$candidate/juno" ]; then
        warn "another juno binary exists at $candidate/juno — it will shadow this install on PATH"
    fi
done

# ---------- log + summary ----------

JUNO_HOME="${JUNO_HOME:-$HOME/.juno}"
mkdir -p "$JUNO_HOME" 2>/dev/null || true
{
    printf "[%s] installed v%s to %s\n" \
        "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
        "$PLAIN_VERSION" \
        "$TARGET"
} >> "$JUNO_HOME/install.log" 2>/dev/null || true

if [ "$QUIET" -eq 0 ]; then
    case "$PATH_STATUS" in
        on-path) PATH_NOTE="on \$PATH" ;;
        *)
            if [ "$NO_MODIFY_PATH" -eq 1 ]; then
                PATH_NOTE="add manually (see above)"
            else
                PATH_NOTE="wired via $(basename "$PATH_RC")"
            fi
            ;;
    esac

    # ---- box renderer ----
    # Box width adapts to the terminal so paths fit; bounded 40..78 inner cols.
    TERM_W=$(tput cols 2>/dev/null || echo 80)
    INNER=$((TERM_W - 6))
    [ "$INNER" -gt 78 ] && INNER=78
    [ "$INNER" -lt 40 ] && INNER=40

    repeat_char() {
        # repeat_char <count> <char> -> stdout
        n=$1; ch=$2
        out=""; i=0
        while [ "$i" -lt "$n" ]; do out="${out}${ch}"; i=$((i + 1)); done
        printf "%s" "$out"
    }

    # display_width <string> -> stdout (chars, not bytes)
    # Only correction we need is for the UTF-8 ellipsis '…' (3 bytes → 1 cell).
    display_width() {
        s="$1"; len=${#s}
        rest="$s"
        while [ "${rest#*…}" != "$rest" ]; do
            len=$((len - 2))
            rest="${rest#*…}"
        done
        printf "%s" "$len"
    }

    LABEL_W=7
    HEADER=" installed "
    HLEN=${#HEADER}
    HG=$((INNER - HLEN))
    HL=$((HG / 2))
    HR=$((HG - HL))
    TOP_DASHES_L=$(repeat_char "$HL" "─")
    TOP_DASHES_R=$(repeat_char "$HR" "─")
    BOTTOM_DASHES=$(repeat_char "$INNER" "─")

    print_row() {
        label="$1"; value="$2"
        # available = INNER - 2 (left pad) - LABEL_W - 1 (gap) - 1 (right pad)
        avail=$((INNER - 2 - LABEL_W - 1 - 1))
        vlen=$(display_width "$value")
        if [ "$vlen" -gt "$avail" ]; then
            keep=$((avail - 1))
            value="$(printf "%s" "$value" | cut -c1-"$keep")…"
            vlen=$avail
        fi
        pad=$((INNER - 2 - LABEL_W - 1 - vlen - 1))
        [ "$pad" -lt 0 ] && pad=0
        spaces=$(repeat_char "$pad" " ")
        printf "  %s│%s %s%-${LABEL_W}s%s %s%s %s│%s\n" \
            "$C_GREEN" "$C_RESET" \
            "$C_DIM" "$label" "$C_RESET" \
            "$value" "$spaces" \
            "$C_GREEN" "$C_RESET"
    }

    printf "\n"
    printf "  %s╭%s%s%s╮%s\n" "$C_GREEN" "$TOP_DASHES_L" "$HEADER" "$TOP_DASHES_R" "$C_RESET"
    print_row "version" "$PLAIN_VERSION"
    print_row "path"    "$TARGET"
    print_row "sha256"  "${SHORT_SHA:-?}…"
    print_row "PATH"    "$PATH_NOTE"
    printf "  %s╰%s╯%s\n\n" "$C_GREEN" "$BOTTOM_DASHES" "$C_RESET"

    say "  next:"
    say "    ${C_BOLD}juno --help${C_RESET}            top-level command list"
    say "    ${C_BOLD}juno login${C_RESET}             configure OpenAI auth"
    say "    ${C_BOLD}juno upgrade --check${C_RESET}   check for a newer release"
    printf "\n"
else
    say "juno $PLAIN_VERSION installed at $TARGET"
fi
