#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
subject="$script_dir/review-context.sh"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  printf '%s\n' "$haystack" | grep -F -- "$needle" >/dev/null || fail "missing: $needle"
}

mkdir -p "$tmp/outside"
out=$(cd "$tmp/outside" && "$subject")
assert_contains "$out" "git-available: false"

repo="$tmp/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email reviewer@example.test
git -C "$repo" config user.name "Review Test"
printf 'base\n' > "$repo/a.txt"
git -C "$repo" add a.txt
git -C "$repo" commit -q -m base

git -C "$repo" switch -q -c feature
printf 'feature\n' >> "$repo/a.txt"
git -C "$repo" add a.txt
git -C "$repo" commit -q -m feature
printf 'dirty\n' >> "$repo/a.txt"
printf 'new\n' > "$repo/new.txt"

out=$(cd "$repo" && "$subject")
assert_contains "$out" "git-available: true"
assert_contains "$out" "branch: feature"
assert_contains "$out" "base-ref: main"
assert_contains "$out" "commits-ahead: 1"
assert_contains "$out" "working-tree-dirty: true"
assert_contains "$out" "tracked-dirty-count: 1"
assert_contains "$out" "untracked-count: 1"
assert_contains "$out" "a.txt"
assert_contains "$out" "new.txt"

out=$(cd "$repo" && "$subject" --base main)
assert_contains "$out" "base-ref: main"
assert_contains "$out" "commits-ahead: 1"

# A current branch whose name is itself a common integration name must not win
# base inference merely because it resolves to HEAD.
repo2="$tmp/develop-repo"
git init -q -b main "$repo2"
git -C "$repo2" config user.email reviewer@example.test
git -C "$repo2" config user.name "Review Test"
printf 'base\n' > "$repo2/a.txt"
git -C "$repo2" add a.txt
git -C "$repo2" commit -q -m base
git -C "$repo2" switch -q -c develop
printf 'develop\n' >> "$repo2/a.txt"
git -C "$repo2" add a.txt
git -C "$repo2" commit -q -m develop
out=$(cd "$repo2" && "$subject")
assert_contains "$out" "branch: develop"
assert_contains "$out" "base-ref: main"
assert_contains "$out" "commits-ahead: 1"

set +e
(cd "$repo" && "$subject" --base definitely-not-a-ref >/dev/null 2>&1)
status=$?
set -e
[ "$status" -eq 2 ] || fail "invalid base should exit 2, got $status"

echo "PASS: review-context"
