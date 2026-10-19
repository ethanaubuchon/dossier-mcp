# dossier-station-api

The wire contract for the dossier-station HTTP API: zod schemas (with TypeScript types derived from them), the OpenAPI 3.1 document generated from those schemas, and a small typed `fetch` client. Both sides of the API use it. The station server validates requests and shapes responses with it, and dossier-mcp talks to a station through its client.

## What's in it

- **Schemas and types** for every endpoint, and for issue and project frontmatter. Each `FooSchema` export has a matching `Foo` type.
- **`endpoints`**: the endpoint table (path, required API-key scope, request and response schema).
- **`createStationClient({ baseUrl, apiKey, fetch? })`**: one method per endpoint. It sends `Authorization: Bearer <apiKey>`, validates the response, and rejects with `StationApiError` (`code`, `status`) on any failure.
- **`openapi.json`** (also importable as `dossier-station-api/openapi.json`) and `buildOpenApiDocument()`.

## API shape

Every operation is a `POST` with a JSON body under `/api/v1`. Errors come back as `{ "error": { "code", "message" } }`.

| Area | Operations |
|---|---|
| Reads | `notes/get`, `notes/list`, `notes/search` |
| Verbs | `write`, `history`, `freshen` (a no-op; the station is always current) |
| Reserved verbs | `propose`, `resolve`, `promote`: always `501 not_implemented` for now |
| Issues | `issues/create` (returns `created` or `possible-duplicates`; re-send with `confirm_new: true` to skip the check), `issues/update`, `issues/comment`, `issues/query`, `issues/bulk-update` |

`openapi.json` holds the full contract.

```ts
import { createStationClient, StationApiError } from 'dossier-station-api';

const station = createStationClient({ baseUrl: 'https://station.lan', apiKey: process.env.STATION_API_KEY! });

const res = await station.createIssue({ title: 'Add ES role', 'created-by': { kind: 'agent', source: 'claude-code' } });
if (res.result === 'possible-duplicates') {
  // comment on a candidate, or re-send with confirm_new: true
}
```

## Consuming it from another repo

The package isn't published to npm. Depend on it from git, pinned to a commit (or a tag) of this repo, using pnpm's `path:` selector for the subdirectory:

```jsonc
// package.json
"dependencies": {
  "dossier-station-api": "github:ethanaubuchon/dossier-mcp#<commit-sha>&path:packages/station-api"
}
```

pnpm builds the package after fetching it (its `prepare` script compiles `dist/`). pnpm blocks dependency build scripts by default, so allow this one in `pnpm-workspace.yaml`. The key is the resolved tarball URL, not the package name or the `github:` spec. If the key is wrong, `pnpm install` fails and prints the exact key to use. With pnpm 11 it is:

```yaml
allowBuilds:
  dossier-station-api@https://codeload.github.com/ethanaubuchon/dossier-mcp/tar.gz/<commit-sha>#path:packages/station-api: true
```

To upgrade, change the commit in both places and reinstall.

Inside this repo, other workspace packages depend on it with `"dossier-station-api": "workspace:*"`.

## Changing the contract

1. Edit the schemas in `src/` (and `src/endpoints.ts` when adding an operation). Register every request or response schema with `named()`, because the OpenAPI generator refers to each one by component ID.
2. Run `pnpm gen:openapi` and commit the regenerated `openapi.json`. Never edit it by hand; a test fails when it differs from what the schemas produce.
3. Bump `version` in `package.json` and `CONTRACT_VERSION` in `src/openapi.ts` together (a test checks that they match), then regenerate again.

Cross-field rules, such as `resolution` being allowed only on a canceled issue, are zod refinements. JSON Schema can't express them, so the OpenAPI document states them in descriptions, and only the zod schemas enforce them.

## Scripts

| Script | Purpose |
|---|---|
| `pnpm build` | Compile to `dist/` |
| `pnpm typecheck` | Typecheck sources, tests and scripts |
| `pnpm test` | Jest suite, including the OpenAPI freshness check |
| `pnpm gen:openapi` | Regenerate `openapi.json` |
