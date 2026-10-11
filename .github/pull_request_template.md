## Summary

<!-- What and why, two or three sentences. Link the issue if there is one. -->

## Changes

-

## Verification

<!-- Commands you ran and their result, e.g. `bun test` 412 pass, `npm run test:e2e` 38 pass,
     `sh scripts/sync-protocol.sh --check`. CI runs the full list in CONTRIBUTING.md. -->

- [ ] Backend: `bun run typecheck && bun run lint && bun test`
- [ ] Frontend: `npm run typecheck && npm run lint && npm test && npm run build`
- [ ] Guard scripts touched by this change (`sync-protocol`, `check-deploy-env`, `check-pins`, `check-frontend-headers`)
- [ ] CHANGELOG.md `## [Unreleased]` updated (or not user-visible)

## Deploy impact

<!-- New env vars or secrets (documented where?), protocol version bump, data migration,
     flags to flip, anything the Render/Vercel/EC2 deploy needs. "None" is a fine answer. -->

## Screenshots

<!-- UI changes: before/after on a phone viewport (Pixel 7 / iPhone 14) and desktop. Delete if not UI. -->
