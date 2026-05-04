#!/usr/bin/env bash
set -euo pipefail

# Cuts a Juno release by tagging HEAD and pushing the tag.
#
# Usage:
#   ./scripts/release.sh                # patch bump (default)
#   ./scripts/release.sh patch          # patch bump
#   ./scripts/release.sh minor
#   ./scripts/release.sh major
#   ./scripts/release.sh v1.2.3         # explicit tag

ARG="${1:-patch}"

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

err() { printf "%s✗ %s%s\n" "$RED" "$*" "$RESET" >&2; exit 1; }
ok()  { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$*"; }

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || err "not inside a git repo"
cd "$REPO_ROOT"

printf "%sPreflight checks%s\n" "$BOLD" "$RESET"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "main" ]] || err "on branch '$BRANCH', not main"
ok "on main"

[[ -z "$(git status --porcelain)" ]] || err "uncommitted changes in working tree"
ok "working tree clean"

git remote get-url origin >/dev/null 2>&1 || err "remote 'origin' not configured"

git fetch origin --tags --quiet
LOCAL_HEAD=$(git rev-parse HEAD)
ORIGIN_HEAD=$(git rev-parse origin/main 2>/dev/null) || err "origin/main not found (push main first)"
[[ "$LOCAL_HEAD" == "$ORIGIN_HEAD" ]] || err "local HEAD differs from origin/main (pull or push first)"
ok "up to date with origin/main"

# Determine the new tag.
if [[ "$ARG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    NEW="$ARG"
    if git rev-parse -q --verify "refs/tags/${NEW}" >/dev/null; then
        err "tag ${NEW} already exists locally"
    fi
    if git ls-remote --exit-code --tags origin "refs/tags/${NEW}" >/dev/null 2>&1; then
        err "tag ${NEW} already exists on origin"
    fi
    ok "explicit tag: ${NEW}"
else
    case "$ARG" in
        major|minor|patch) ;;
        *) err "usage: $0 [major|minor|patch | vX.Y.Z]" ;;
    esac

    if CURRENT=$(git describe --tags --abbrev=0 2>/dev/null); then
        ok "current version: ${CURRENT}"
    else
        CURRENT="v0.1.0"
        ok "no existing tags; bootstrapping from ${CURRENT}"
    fi

    BASE="${CURRENT#v}"
    IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE"
    [[ -n "$MAJOR" && -n "$MINOR" && -n "$PATCH" ]] || err "could not parse semver from ${CURRENT}"

    case "$ARG" in
        major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
        minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
        patch) PATCH=$((PATCH + 1)) ;;
    esac

    NEW="v${MAJOR}.${MINOR}.${PATCH}"

    if git rev-parse -q --verify "refs/tags/${NEW}" >/dev/null; then
        err "tag ${NEW} already exists locally"
    fi
fi

echo ""
printf "Release: %s%s%s%s\n" "$BOLD" "$GREEN" "$NEW" "$RESET"
echo ""

read -r -p "Tag and push ${NEW} to origin? [y/N] " REPLY
case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
esac

git tag -a "$NEW" -m "Release ${NEW}"
ok "tagged ${NEW}"

git push origin "$NEW"
ok "pushed ${NEW} to origin"

echo ""
printf "%sRelease workflow:%s https://github.com/o1x3/juno/actions\n" "$BOLD" "$RESET"
