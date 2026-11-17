# Contributing to @particle-academy/fancy-git-bitbucket

Notes for anyone, human or agent, working ON this package's code. How to USE the
package is in [AGENTS.md](./AGENTS.md); what it is, is in [README.md](./README.md).
`CLAUDE.md` is a symlink to this file, so Claude Code reads these notes when it
works in this repo.

## Layout

- `src/index.ts` — `BitbucketProvider`, the whole adapter.
- `tests/provider.test.ts` — the vitest suite.

## Commands

```bash
npm run build   # tsup
npm run lint    # tsc --noEmit
npm test        # vitest run
```

`prepublishOnly` runs lint, test and build in that order.

## Changelog

Update `CHANGELOG.md` (Keep a Changelog) in the same commit as the change.
