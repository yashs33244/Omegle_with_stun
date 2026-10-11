# Runbook: release

A release is a tag `vX.Y.Z` on `new-v` with a CHANGELOG section and a GitHub
Release. It is bookkeeping: production deploys on every merge to `new-v`
(Vercel, Render), not on tags. Cutting a release says "this is the state we
stand behind" and gives a name to roll back to and to write in incident
notes. Cut one after every user-visible change lands, at least weekly while
things move fast.

Versions follow semver as users see it: patch for fixes, minor for new
features and new settings, major for a protocol version bump or anything
that needs operator action (new required env, store migration).

## Before

- `## [Unreleased]` in `CHANGELOG.md` lists everything merged since the last
  tag. If a PR forgot its line, add it now in a normal commit.
- The CI run for `HEAD` of `new-v` is green (`gh run list --branch new-v --workflow ci.yml --limit 1`).
- Production is already running this commit (Render Events shows the sha
  live; `vercel ls chizzy-chat` shows the latest Ready production deploy).
  Do not tag a commit that is not live; a tag should never be ahead of
  production.

## Cut

```sh
git checkout new-v && git pull --ff-only
scripts/release.sh --dry-run minor     # prints every step and the CHANGELOG diff, writes nothing
scripts/release.sh minor               # patch | minor | major | X.Y.Z
```

`scripts/release.sh` refuses to run unless: branch is `new-v`, tree is
clean, `new-v` is up to date with `origin/new-v`, `gh` is authenticated, the
latest CI run for `HEAD` succeeded, and the tag does not exist yet. It then:

1. computes the next version from `backend/package.json`;
2. writes `version` into `backend/package.json`,
   `new-frontend/package.json` and `new-frontend/package-lock.json`;
3. moves the `## [Unreleased]` content in `CHANGELOG.md` under
   `## [X.Y.Z] - YYYY-MM-DD` and updates the compare links;
4. commits `Release vX.Y.Z`;
5. `git tag -a vX.Y.Z -m "Release vX.Y.Z"`;
6. `git push origin new-v vX.Y.Z` (`RELEASE_REMOTE` overrides `origin`).

The push of the Release commit triggers the usual Vercel and Render deploys
(package.json versions changed, nothing else); the push of the tag triggers
`release.yml`.

## What release.yml does

On `push` of a `v*` tag:

1. `ci`: the same checks as every PR, reused from `ci.yml` via `workflow_call`.
2. `images`: builds `backend/` and `new-frontend/` images and pushes
   `yashs3324/omegle-backend` and `yashs3324/omegle-frontend` tagged
   `<version>` and `latest` to Docker Hub. Skipped when the
   `DOCKERHUB_USERNAME` secret is absent. These images are for the compose
   path; Render builds its own.
3. `release`: builds `new-frontend/dist`, packs it as
   `chizzy-frontend-<version>.tar.gz`, and runs `gh release create vX.Y.Z`
   with the CHANGELOG section as the body plus `--generate-notes` (the PR
   list), attaching the tarball.

Watch it: `gh run list --workflow release.yml --limit 1` then `gh run watch`.
A failed `ci` job means the tag was cut on a commit that regressed between
the CI run and the tag; fix on `new-v` and cut a patch release, do not force
the tag.

## After

Check, in this order, and only tick what you saw:

- [ ] `gh release view vX.Y.Z` shows the CHANGELOG section and the tarball.
- [ ] Render: `render deploys list srv-db5nnass728c738ek0o0 -o json` shows the
      Release commit sha with `"status": "live"`.
- [ ] Vercel: `vercel ls chizzy-chat` shows a Ready production deployment for the
      Release commit; https://chizzy-chat.vercel.app loads.
- [ ] Prod smoke: `curl -sS https://chizzy-api.onrender.com/healthz` is 200
      and `/api/config` returns the expected `tosVersion`.
- [ ] Canary green: `gh workflow run canary.yml --ref new-v` then `gh run watch`,
      or wait for the next scheduled run (`gh run list --workflow=canary.yml --limit 3`).
- [ ] `CHANGELOG.md` on `new-v` has an empty `## [Unreleased]` above the new
      section (the script leaves it in place).
- [ ] If the release changed anything an operator must do (new env, new flag
      default), it is written in the CHANGELOG entry and in DEPLOYMENT.md.

If a check fails, [rollback.md](rollback.md) is the next page.

## Undo a release

A tag that should not have been cut (wrong version, broken commit):

```sh
gh release delete vX.Y.Z --cleanup-tag --yes
git revert <Release-commit-sha>          # puts the versions and CHANGELOG back
git push origin new-v
```

Then cut the correct release. Never move an existing tag; anyone who pulled
it keeps the old object and the Docker Hub tags already point at the old
images.
