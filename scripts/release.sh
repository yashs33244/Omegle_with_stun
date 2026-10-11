#!/usr/bin/env bash
# Cuts a release from new-v: bumps the version, moves the CHANGELOG
# "Unreleased" section under the new version, commits "Release vX.Y.Z", tags
# it and pushes branch + tag. The tag push runs .github/workflows/release.yml
# (CI, Docker Hub images, GitHub Release). See CONTRIBUTING.md "Releases".
#
# Usage: scripts/release.sh [--dry-run] <patch|minor|major|X.Y.Z>
#   --dry-run       print every step and the CHANGELOG diff, change nothing
# Environment:
#   RELEASE_REMOTE  git remote to push to (default: origin)
#
# Refuses to run unless: branch is new-v, tree is clean, HEAD equals the
# remote new-v, the latest CI run for HEAD succeeded (gh run list --commit)
# and the tag does not exist yet. Needs git, gh (logged in), node, awk.
set -euo pipefail

usage() {
  sed -n '7,10p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

dry_run=0
bump=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -h|--help) usage ;;
    -*) echo "unknown flag: $arg" >&2; usage ;;
    *) [ -z "$bump" ] || usage; bump=$arg ;;
  esac
done
[ -n "$bump" ] || usage

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
remote=${RELEASE_REMOTE:-origin}
branch=new-v
backend_pkg=backend/package.json
frontend_pkg=new-frontend/package.json
frontend_lock=new-frontend/package-lock.json
changelog=CHANGELOG.md
repo_url=$(git remote get-url "$remote" | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##')

say() { printf '%s\n' "$*"; }
fail() { echo "release: $*" >&2; exit 1; }
# Precondition: fatal for a real release, a warning in a dry run so the plan
# can be previewed from any branch or before CI finishes.
require() {
  if [ "$dry_run" = 1 ]; then
    echo "  WARN (would refuse): $*" >&2
  else
    fail "$*"
  fi
}
run() {
  if [ "$dry_run" = 1 ]; then
    say "  would run: $*"
  else
    "$@"
  fi
}

# --- preconditions -----------------------------------------------------------
for tool in git gh node awk; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is required"
done
current=$(git rev-parse --abbrev-ref HEAD)
[ "$current" = "$branch" ] || require "on branch $current; releases are cut from $branch"
[ -z "$(git status --porcelain)" ] || require "working tree is not clean"
git fetch --quiet "$remote" "$branch" refs/tags/\*:refs/tags/\*
head=$(git rev-parse HEAD)
[ "$head" = "$(git rev-parse "$remote/$branch")" ] || require "HEAD is not $remote/$branch; pull or push first"

ci=$(gh run list --commit "$head" --workflow ci.yml --limit 1 --json status,conclusion \
  --jq '.[0] | "\(.status) \(.conclusion)"' 2> /dev/null || true)
# new-v pushes run CI through deploy.yml (workflow_call), not as a ci.yml run.
if [ -z "$ci" ] || [ "$ci" = "null null" ]; then
  ci=$(gh run list --commit "$head" --workflow deploy.yml --limit 1 --json status,conclusion \
    --jq '.[0] | "\(.status) \(.conclusion)"' 2> /dev/null || true)
fi
case "$ci" in
  "completed success") ;;
  ""|"null null") require "no CI run found for $head" ;;
  *) require "CI for $head is '$ci', not 'completed success'" ;;
esac

# --- version -----------------------------------------------------------------
current_version=$(node -p "require('./$backend_pkg').version")
IFS=. read -r major minor patch <<< "$current_version"
case "$bump" in
  major) version="$((major + 1)).0.0" ;;
  minor) version="$major.$((minor + 1)).0" ;;
  patch) version="$major.$minor.$((patch + 1))" ;;
  [0-9]*.[0-9]*.[0-9]*) version=$bump ;;
  *) fail "bump must be patch, minor, major or X.Y.Z (got '$bump')" ;;
esac
tag="v$version"
! git rev-parse -q --verify "refs/tags/$tag" > /dev/null || fail "tag $tag already exists"
date=$(date -u +%Y-%m-%d)

# "release.sh X.Y.Z" where X.Y.Z is already the package version and already has
# a dated CHANGELOG section only tags HEAD (first release, or a version that
# was prepared by hand).
tag_only=0
if [ "$version" = "$current_version" ] && grep -q "^## \[$version\] - " "$changelog"; then
  tag_only=1
  say "Tag $tag at $head on $branch ($backend_pkg and $changelog already at $version)"
else
  grep -q '^## \[Unreleased\]' "$changelog" || fail "$changelog has no '## [Unreleased]' section"
  unreleased=$(awk '/^## \[Unreleased\]/ { on = 1; next } on && /^## \[/ { exit } on { print }' "$changelog")
  grep -q '[^[:space:]]' <<< "$unreleased" || require "the Unreleased section of $changelog is empty; add entries first"
  say "Release $tag (from $current_version) at $head on $branch, $date"
fi

previous_tag=$(git describe --tags --abbrev=0 --match 'v*' 2> /dev/null || true)

# --- CHANGELOG ---------------------------------------------------------------
# Inserts the new heading after the Unreleased heading and rewrites the link
# references at the bottom: [Unreleased] compares against the new tag, the
# new version compares against the previous tag (or is the first tag).
render_changelog() {
  awk -v version="$version" -v date="$date" -v tag="$tag" -v prev="$previous_tag" -v url="$repo_url" '
    /^## \[Unreleased\]/ { print; print ""; print "## [" version "] - " date; next }
    /^\[Unreleased\]: / {
      print "[Unreleased]: " url "/compare/" tag "...HEAD"
      if (prev != "") print "[" version "]: " url "/compare/" prev "..." tag
      else print "[" version "]: " url "/releases/tag/" tag
      next
    }
    { print }
  ' "$changelog"
}
new_changelog=$(render_changelog)
grep -q "^\[Unreleased\]: " "$changelog" || fail "$changelog has no [Unreleased] link reference"

# --- apply -------------------------------------------------------------------
set_version() {
  # Rewrites "version" in a package.json (and the two root entries of a
  # package-lock.json) without reformatting the file.
  file=$1
  if [ "$dry_run" = 1 ]; then
    say "  would set version $version in $file"
    return
  fi
  # shellcheck disable=SC2016 # JS template literal, not shell expansion
  node -e '
    const fs = require("fs");
    const [file, version] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    let seen = 0;
    const out = text.replace(/^(\s*"version": ")[^"]*(")/mg, (m, a, b) => {
      // package-lock.json: the root object and packages[""] only.
      if (file.endsWith("package-lock.json") && seen >= 2) return m;
      seen += 1;
      return a + version + b;
    });
    if (seen === 0) throw new Error(`no "version" in ${file}`);
    fs.writeFileSync(file, out);
  ' "$file" "$version"
}

say "Steps:"
if [ "$tag_only" = 0 ]; then
  set_version "$backend_pkg"
  set_version "$frontend_pkg"
  set_version "$frontend_lock"
  if [ "$dry_run" = 1 ]; then
    say "  would rewrite $changelog:"
    diff -u "$changelog" <(printf '%s\n' "$new_changelog") | sed 's/^/    /' || true
  else
    printf '%s\n' "$new_changelog" > "$changelog"
  fi
  run git add "$backend_pkg" "$frontend_pkg" "$frontend_lock" "$changelog"
  run git commit --quiet -m "Release $tag"
fi
run git tag -a "$tag" -m "Release $tag"
run git push "$remote" "$branch" "$tag"
if [ "$dry_run" = 1 ]; then
  say "Dry run: nothing changed. The tag push would start $repo_url/actions/workflows/release.yml"
else
  say "Pushed $tag. Watch $repo_url/actions/workflows/release.yml; the release appears at $repo_url/releases/tag/$tag"
fi
