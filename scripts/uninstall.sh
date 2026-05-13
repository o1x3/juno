#!/bin/sh
# shellcheck shell=sh
#
# Juno uninstaller. Removes the binary, the .old backup, the shell-rc PATH
# block, and (with --purge) the local data directory.
#
# Usage:
#   curl -sSfL https://raw.githubusercontent.com/o1x3/juno/main/scripts/uninstall.sh | sh
#   sh scripts/uninstall.sh --purge
#
# Flags:
#   --purge                 Also remove $JUNO_HOME (sessions, auth, config).
#   --yes                   Non-interactive; do not prompt.
#   --quiet                 Suppress wordmark and \r redraws.
#   --dry-run               Print what would be done; remove nothing.
#   --help                  Show this help and exit.

set -eu

PURGE=0
YES=0
QUIET=0
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --purge) PURGE=1; shift ;;
        --yes|-y) YES=1; shift ;;
        --quiet) QUIET=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --help|-h)
            sed -n '3,17p' "$0" 2>/dev/null || cat <<EOF
Juno uninstaller. Run with --help via source for full flags.
EOF
            exit 0
            ;;
        *)
            printf "unknown argument: %s\n" "$1" >&2
            exit 2
            ;;
    esac
done

if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ "$QUIET" -eq 0 ]; then
    C_BOLD=$(printf '\033[1m')
    C_DIM=$(printf '\033[2m')
    C_RED=$(printf '\033[31m')
    C_GREEN=$(printf '\033[32m')
    C_YELLOW=$(printf '\033[33m')
    C_BLUE=$(printf '\033[34m')
    C_RESET=$(printf '\033[0m')
    G_OK="✓"
    G_FAIL="✗"
else
    C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
    G_OK="[x]"
    G_FAIL="[!]"
fi

note() { printf "%s%s%s\n" "$C_DIM" "$*" "$C_RESET"; }
warn() { printf "%s%s%s %s\n" "$C_YELLOW" "$G_FAIL" "$C_RESET" "$*" >&2; }
ok()   { printf "  %s%s%s  %s\n" "$C_GREEN" "$G_OK" "$C_RESET" "$*"; }
miss() { printf "  %s-%s  %s\n" "$C_DIM" "$C_RESET" "$*"; }

if [ "$QUIET" -eq 0 ]; then
    printf "\n"
    printf "  %s╭──────────────╮%s\n" "$C_BLUE" "$C_RESET"
    printf "  %s│     juno     │%s  uninstaller\n" "$C_BLUE" "$C_RESET"
    printf "  %s╰──────────────╯%s\n\n" "$C_BLUE" "$C_RESET"
fi

# ---------- discover juno binaries ----------

CANDIDATE_DIRS="$HOME/.local/bin /usr/local/bin /opt/juno/bin"
[ -n "${JUNO_INSTALL_DIR:-}" ] && CANDIDATE_DIRS="$JUNO_INSTALL_DIR $CANDIDATE_DIRS"

FOUND_BINARIES=""
for dir in $CANDIDATE_DIRS; do
    if [ -x "$dir/juno" ]; then
        FOUND_BINARIES="${FOUND_BINARIES}${dir}/juno
"
    fi
done

JUNO_HOME="${JUNO_HOME:-$HOME/.juno}"

if [ -z "$FOUND_BINARIES" ] && [ ! -d "$JUNO_HOME" ]; then
    note "nothing to remove."
    exit 0
fi

printf "%swill remove:%s\n" "$C_BOLD" "$C_RESET"
echo "$FOUND_BINARIES" | while IFS= read -r bin; do
    [ -z "$bin" ] && continue
    printf "  %s\n" "$bin"
    [ -e "${bin}.old" ] && printf "  %s\n" "${bin}.old"
done
if [ "$PURGE" -eq 1 ] && [ -d "$JUNO_HOME" ]; then
    printf "  %s  %s(--purge: includes credentials and all sessions)%s\n" "$JUNO_HOME" "$C_YELLOW" "$C_RESET"
fi
printf "\n"

if [ "$DRY_RUN" -eq 1 ]; then
    note "dry run; nothing removed."
    exit 0
fi

if [ "$YES" -eq 0 ]; then
    if [ ! -t 0 ]; then
        warn "stdin is not a TTY; rerun with --yes to confirm non-interactively"
        exit 1
    fi
    printf "proceed? [y/N] "
    read -r reply
    case "$reply" in
        y|Y|yes|YES) ;;
        *) note "aborted."; exit 0 ;;
    esac
fi

# ---------- remove ----------

remove_path() {
    target="$1"
    if [ ! -e "$target" ]; then
        miss "$target (not present)"
        return
    fi
    if [ -w "$(dirname "$target")" ] || [ -w "$target" ]; then
        rm -rf "$target"
    elif command -v sudo >/dev/null 2>&1; then
        sudo rm -rf "$target"
    else
        warn "no permission to remove $target"
        return
    fi
    ok "removed $target"
}

echo "$FOUND_BINARIES" | while IFS= read -r bin; do
    [ -z "$bin" ] && continue
    remove_path "$bin"
    [ -e "${bin}.old" ] && remove_path "${bin}.old"
done

if [ "$PURGE" -eq 1 ] && [ -d "$JUNO_HOME" ]; then
    remove_path "$JUNO_HOME"
fi

# ---------- shell rc cleanup ----------

PATH_MARKER_START="# >>> juno install >>>"
PATH_MARKER_END="# <<< juno install <<<"
RC_FILES="$HOME/.zshenv $HOME/.zshrc $HOME/.bashrc $HOME/.bash_profile $HOME/.profile $HOME/.config/fish/conf.d/juno.fish"

for rc in $RC_FILES; do
    [ -f "$rc" ] || continue
    if grep -qF "$PATH_MARKER_START" "$rc" 2>/dev/null; then
        # Use awk to drop everything between the fence markers (inclusive).
        tmp=$(mktemp)
        awk -v start="$PATH_MARKER_START" -v end="$PATH_MARKER_END" '
            $0 ~ start { skip=1; next }
            skip && $0 ~ end { skip=0; next }
            !skip { print }
        ' "$rc" > "$tmp" && mv "$tmp" "$rc"
        ok "cleaned PATH block from $rc"
    fi
done

if [ "$QUIET" -eq 0 ]; then
    printf "\n"
    printf "  %s╭──── uninstalled ────╮%s\n" "$C_GREEN" "$C_RESET"
    if [ "$PURGE" -eq 0 ] && [ -d "$JUNO_HOME" ]; then
        printf "  %s│%s  config kept at:      %s│%s\n" "$C_GREEN" "$C_RESET" "$C_GREEN" "$C_RESET"
        printf "  %s│%s  %-21s%s│%s\n" "$C_GREEN" "$C_RESET" "$JUNO_HOME" "$C_GREEN" "$C_RESET"
    fi
    printf "  %s╰─────────────────────╯%s\n\n" "$C_GREEN" "$C_RESET"
    note "to reinstall later: curl -sSfL https://raw.githubusercontent.com/o1x3/juno/main/scripts/install.sh | sh"
fi
