# Contributing

Chizzy is a proprietary product (see the licence note in README.md); this
guide is for the people who have write access.

## Branches and merges

- `new-v` is production. Vercel (frontend) and Render (backend) deploy from it;
  the EC2 path in `deploy.yml` is paused behind `EC2_DEPLOY_ENABLED`.
- Work on a feature branch, open a PR into `new-v`, wait for CI, merge with a
  merge commit. Squash and rebase merges are not used: the branch history is
  the record, and `git log --merges new-v` is the release summary.
- Dependabot branches are not built by Vercel (`ignoreCommand` in
  `new-frontend/vercel.json`); they still run CI.

## Commits

- Imperative subject, capitalised, no trailing period, no trailers:
  `Gate the EC2 deploy behind a repository variable`.
- One topic per commit; put the why in the body when the diff does not say it.
- Never commit secrets or `.env`; `.env.example` files document every variable.

## What CI enforces

`ci.yml` runs on every PR and non-production push, and through `workflow_call`
from `deploy.yml` and `release.yml`:

| job | checks |
|---|---|
| Protocol and lockfiles | `sync-protocol.sh --check`, `check-lockfiles.sh`, `check-pins.sh`, `test-deploy.sh`, `check-deploy-env.sh`, `check-frontend-headers.sh` |
| Workflows and shell scripts | actionlint 1.7.12, shellcheck 0.11.0 on every script listed in the job |
| Backend | `bun run typecheck`, `sync-spark-prompts.sh --check`, loadtest typecheck, `lint`, `bun test` (with a Redis service), `build`, `test:node` |
| Frontend | `npm run typecheck`, `lint`, `test`, `build` |
| End-to-end (Playwright) | two fake-media Chromium users against the built backend, incl. the axe audit |
| Docker images | both images build; compose config, gateway and frontend nginx configs validate |
| Compose stack end-to-end | the full `docker-compose.yml` stack with two replicas, e2e against it |

Run the same commands locally before pushing; the README's
[Testing](README.md#testing) and [Scripts](README.md#scripts) sections list
them.

## Running everything locally

See [Quick start](README.md#quick-start-local-development) for the two dev
servers and [Full stack with Docker Compose](README.md#full-stack-with-docker-compose)
for the production shape. Backend uses Bun for install, build and tests and
Node 22 at runtime; the frontend uses npm. The versions CI expects are pinned
in `.github/workflows/ci.yml` and must match the Dockerfiles
(`scripts/check-pins.sh`).

## Rules that CI will hold you to

- Protocol: `backend/src/protocol.ts` is the only source. After changing it run
  `sh scripts/sync-protocol.sh` and commit the frontend copy; bump
  `PROTOCOL_VERSION` when a change breaks older clients.
- Spark prompts: edit the catalog, then `sh scripts/sync-spark-prompts.sh`.
- Environment variables: every new variable goes into the relevant
  `.env.example` and the README table; a compose setting also into
  `deploy/deploy.sh` (`ENV_KEYS`), `deploy.yml` and DEPLOYMENT.md
  (`scripts/check-deploy-env.sh` fails otherwise), and `render.yaml` when
  Render needs it.
- Frontend headers: change `new-frontend/vercel.json`,
  `new-frontend/_headers.template` and the nginx config together.
- Workflows: pin actions by commit SHA with a `# vX.Y.Z` comment; keep
  actionlint and shellcheck clean.
- Docs: a behaviour change updates README.md, DEPLOYMENT.md or `docs/` in the
  same PR, and gets a line under `## [Unreleased]` in CHANGELOG.md
  (Added / Changed / Fixed / Security, one line, reference the PR).

## Dependencies

Dependabot opens one grouped minor+patch PR per ecosystem per week. Majors are
ignored in `.github/dependabot.yml`: upgrade them deliberately by opening an
issue, migrating on a branch, and removing or adjusting the ignore rule in the
same PR. Runtime image majors (Node, nginx, Redis) also need the pins in
`ci.yml` and `docker-compose.yml` updated together.

## Releases

Versions are SemVer tags `vX.Y.Z` on `new-v`; the version lives in
`backend/package.json` and `new-frontend/package.json` (kept equal).

1. Make sure `## [Unreleased]` in CHANGELOG.md lists what shipped.
2. On an up-to-date, clean `new-v` with green CI:
   `scripts/release.sh --dry-run patch` to preview, then
   `scripts/release.sh patch` (or `minor`, `major`, `X.Y.Z`).
   The script bumps the versions, dates the CHANGELOG section, commits
   `Release vX.Y.Z`, tags and pushes.
3. The tag runs `.github/workflows/release.yml`: CI again, images pushed to
   Docker Hub as `X.Y.Z` and `latest` (skipped without `DOCKERHUB_*` secrets),
   and a GitHub Release with the CHANGELOG section plus generated notes and the
   built frontend as `chizzy-frontend-X.Y.Z.tar.gz`.

To undo a release that has not been deployed anywhere:
`gh release delete vX.Y.Z --cleanup-tag`, then `git revert` the release commit
on `new-v`. Rolling back production is covered in DEPLOYMENT.md.

## Code owners

`.github/CODEOWNERS` requests a review from @yashs33244 on every PR. Backend,
frontend and deploy paths are listed explicitly so ownership stays visible when
more owners are added.
