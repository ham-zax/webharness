#!/usr/bin/env bash
set -euo pipefail

base_override=""

usage() {
  echo "usage: $0 [--base <ref>]" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --base)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      base_override="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if ! command -v git >/dev/null 2>&1; then
  echo "git-available: false"
  exit 0
fi

if ! root=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "git-available: false"
  exit 0
fi

cd "$root"

echo "git-available: true"
echo "repo-root: $root"

head_sha=$(git rev-parse --verify HEAD)
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
[ -n "$branch" ] || branch="detached"

echo "branch: $branch"
echo "head: $head_sha"

base_ref=""
base_sha=""

if [ -n "$base_override" ]; then
  if ! base_sha=$(git rev-parse --verify "${base_override}^{commit}" 2>/dev/null); then
    echo "error: base ref not found: $base_override" >&2
    exit 2
  fi
  base_ref="$base_override"
else
  ownline_count=$(git rev-list --count --first-parent "$head_sha")
  best_distance=""
  seen=" "

  consider_ref() {
    local ref="$1"
    local sha distance

    case "$seen" in
      *" $ref "*) return 0 ;;
    esac
    seen="${seen}${ref} "

    sha=$(git rev-parse --verify "${ref}^{commit}" 2>/dev/null) || return 0
    # Do not choose the current branch itself as its own inferred base. Explicit
    # --base may still intentionally name a ref that resolves to HEAD.
    [ "$sha" != "$head_sha" ] || return 0
    distance=$(git rev-list --count --first-parent "$head_sha" "^$sha" 2>/dev/null) || return 0

    # A candidate that excludes none of HEAD's first-parent history is not a useful base.
    [ "$distance" -lt "$ownline_count" ] || return 0

    if [ -z "$best_distance" ] || [ "$distance" -lt "$best_distance" ]; then
      best_distance="$distance"
      base_ref="$ref"
      base_sha="$sha"
    fi
  }

  # Prefer remotes' declared default branches when they are tied with a guessed name.
  while IFS= read -r headref; do
    [ -n "$headref" ] || continue
    ref=$(git symbolic-ref --quiet --short "$headref" 2>/dev/null || true)
    [ -n "$ref" ] && consider_ref "$ref"
  done < <(git for-each-ref --sort=refname --format='%(refname)' refs/remotes/ 2>/dev/null | grep -E '/HEAD$' || true)

  # Fall back to common trunk/integration names, local first and then remote tracking refs.
  for name in main master trunk mainline next develop devel development default dev; do
    git show-ref --verify --quiet "refs/heads/$name" && consider_ref "$name"
    while IFS= read -r ref; do
      [ -n "$ref" ] && consider_ref "$ref"
    done < <(git for-each-ref --sort=refname --format='%(refname:short)' "refs/remotes/*/$name" 2>/dev/null || true)
  done
fi

merge_base="none"
commits_ahead="unknown"

if [ -n "$base_ref" ] && [ -n "$base_sha" ]; then
  merge_base=$(git merge-base "$base_sha" "$head_sha" 2>/dev/null || true)
  [ -n "$merge_base" ] || merge_base="none"
fi

if [ "$merge_base" != "none" ]; then
  commits_ahead=$(git rev-list --count "$merge_base..$head_sha")
fi

echo "base-ref: ${base_ref:-none}"
echo "base-sha: ${base_sha:-none}"
echo "merge-base: $merge_base"
echo "commits-ahead: $commits_ahead"

if [ "$merge_base" != "none" ]; then
  tracked_files=$(git diff --name-only "$merge_base" --)
else
  tracked_files=$(git diff --name-only HEAD --)
fi
untracked_files=$(git ls-files --others --exclude-standard)

status=$(git status --porcelain=v1 --untracked-files=all)
if [ -n "$status" ]; then
  echo "working-tree-dirty: true"
else
  echo "working-tree-dirty: false"
fi

tracked_dirty_count=$(printf '%s\n' "$status" | awk 'NF && substr($0,1,2) != "??" {n++} END {print n+0}')
untracked_count=$(printf '%s\n' "$untracked_files" | awk 'NF {n++} END {print n+0}')
echo "tracked-dirty-count: $tracked_dirty_count"
echo "untracked-count: $untracked_count"

echo "tracked-files-start"
[ -n "$tracked_files" ] && printf '%s\n' "$tracked_files"
echo "tracked-files-end"

echo "untracked-files-start"
[ -n "$untracked_files" ] && printf '%s\n' "$untracked_files"
echo "untracked-files-end"

echo "review-files-start"
{
  if [ -n "$tracked_files" ]; then
    printf '%s\n' "$tracked_files"
  fi
  if [ -n "$untracked_files" ]; then
    printf '%s\n' "$untracked_files"
  fi
} | awk 'NF && !seen[$0]++'
echo "review-files-end"
