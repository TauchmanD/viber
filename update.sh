#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly EXPECTED_BRANCH="main"

usage() {
  cat <<'EOF'
Usage: ./update.sh

Updates Tmux Agent Grid from origin/main, installs locked JavaScript
packages, builds the optimized standalone application, and installs it to
~/.local/bin/tmux-agent-grid.

The updater refuses to run with uncommitted files or from a branch other
than main. It never resets, stashes, or deletes local work.
EOF
}

if [[ ${1:-} == "--help" || ${1:-} == "-h" ]]; then
  usage
  exit 0
fi
if [[ $# -ne 0 ]]; then
  usage >&2
  exit 2
fi

for command in git node npm cargo tmux; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command" >&2
    printf 'See README.md for installation dependencies.\n' >&2
    exit 1
  fi
done

cd "$SCRIPT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'update.sh must be run from a Git checkout of Tmux Agent Grid.\n' >&2
  exit 1
fi

current_branch="$(git branch --show-current)"
if [[ $current_branch != "$EXPECTED_BRANCH" ]]; then
  printf 'Update aborted: expected branch %s, currently on %s.\n' \
    "$EXPECTED_BRANCH" "${current_branch:-detached HEAD}" >&2
  exit 1
fi

if [[ -n $(git status --porcelain --untracked-files=normal) ]]; then
  printf 'Update aborted: the repository contains uncommitted changes.\n' >&2
  printf 'Commit or stash them before running update.sh.\n' >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  printf 'Update aborted: Git remote origin is not configured.\n' >&2
  exit 1
fi

printf 'Updating Tmux Agent Grid from origin/%s...\n' "$EXPECTED_BRANCH"
git pull --ff-only origin "$EXPECTED_BRANCH"

printf 'Installing locked JavaScript dependencies...\n'
npm ci

printf 'Building and installing the optimized application...\n'
npm run build -- --no-bundle

printf '\nUpdate complete. Installed executable:\n  %s/.local/bin/tmux-agent-grid\n' "$HOME"
