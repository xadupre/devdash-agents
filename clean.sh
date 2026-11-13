#!/usr/bin/env bash
# Removes linked git worktrees and deletes every local branch except the current one and main.
echo "-- clean branches"
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
current_worktree="$(pwd)"
current_branch="$(git branch --show-current)"

git worktree list --porcelain | sed -n 's/^worktree //p' | tail -n +2 | while read -r worktree; do
  if [ "$worktree" != "$current_worktree" ]; then
    echo "Removing worktree $worktree"
    git worktree remove --force "$worktree"
  fi
done
git worktree prune

git for-each-ref --format='%(refname:short)' refs/heads/ | while read -r branch; do
  if [ "$branch" != "main" ] && [ "$branch" != "$current_branch" ]; then
    git branch -D "$branch"
  fi
done

git fetch --prune

echo "-- clean build"
rm -rf build dist node_modules

echo "-- done"