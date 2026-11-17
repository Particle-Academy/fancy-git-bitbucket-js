# Using @particle-academy/fancy-git-bitbucket — guide for agents

How an agent installs and uses this package in a consumer app. What the package
is, is in [README.md](./README.md). Notes for working ON this repo's code are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Install

```bash
npm install @particle-academy/fancy-git @particle-academy/fancy-git-bitbucket
```

- `@particle-academy/fancy-git` is a **peer** (`>=0.1 <2.0`); install it too.
- **Node:** `>=22`. No runtime dependencies: requests go through `fetch`.

## Find it on the Fancy MCP server

The catalog server is `https://ui.particle.academy/mcp` (streamable HTTP, no API
key; MCP id `fancy-ui`). This package is the registry entry
`fancy-git-bitbucket-js`. Server-side packages are found with
`search-backend-packages` (stack `node`); `install-instructions` gives the exact
commands for the slug.

## API essentials

```ts
import { ProviderRegistry } from "@particle-academy/fancy-git";
import { BitbucketProvider } from "@particle-academy/fancy-git-bitbucket";

const bitbucket = new BitbucketProvider({ token: process.env.BITBUCKET_TOKEN });
const providers = new ProviderRegistry().register(bitbucket);
```

- `BitbucketProviderOptions`: `token` (a string, or a function returning one,
  sync or async), `fetch` (your own fetch), `baseUrl` (defaults to
  `https://api.bitbucket.org/2.0`).
- `BitbucketProvider` implements fancy-git's `GitProvider` contract (`kind` is
  `"bitbucket"`): `identify`, `repository`, `listReviews`, `getReview`,
  `createReview`, `compare`, `checks`. Results use fancy-git's normalized types.
- `identify(remote)` returns a ref only for `bitbucket.org` remotes, otherwise
  `null`.

## Traps

- **Bitbucket Cloud only.** Bitbucket Data Center is a separate API family and
  is not supported here.
- No issue methods: this adapter does not implement fancy-git's
  `IssueProvider`.
