# Architecture

How the server is put together: the runtime shape, the module map, the invariants each module owns, and how the test suites line up with them. For the tool contract see [TOOLS.md](TOOLS.md); for the threat model see [SECURITY.md](../SECURITY.md).

## Runtime shape

The server is a single Node.js process launched by an MCP client and spoken to over stdio. It listens on no sockets; its only outbound connections are HTTP requests to configured station vaults. There is no database: local notes are Markdown files with YAML frontmatter on disk, and every local index is rebuilt in memory from those files.

```
MCP client ──stdio──▶ mcp-entry.ts
                          │  loadVaultConfig()  → VaultRegistry
                          │  one runtime per vault:
                          │    local:   NoteStore (files + watcher) ─ change ─▶ SearchIndex.rebuild
                          │    station: StationClient ──HTTP──▶ dossier-station
                          ▼
                     createMcpServer(runtimes)  → tools + resources
```

Startup (`server/src/mcp-entry.ts`):

1. Resolve the vault registry (see [Configuration](#configuration)). Invalid config throws a `VaultConfigError` and the process exits non-zero — startup is fail-fast.
2. For each configured local vault, create a `NoteStore` (which starts its own file watcher), read every note, and build that vault's `SearchIndex`. For each station vault, create a client (`createStationRuntime`); nothing is fetched at startup, so an unreachable station doesn't block boot.
3. Subscribe each store's `change` event to a rebuild of *its own* index only.
4. Hand all runtimes plus the default vault name to `createMcpServer`, along with the version from `server/package.json` (clients see server name `dossier-mcp` and that version at initialize), and connect a `StdioServerTransport`.
5. On `SIGINT`/`SIGTERM`, close every watcher and exit.

Logs go to stderr; stdout belongs to the MCP protocol.

## Module map

All source lives under `server/src/`.

| Module | Role |
|---|---|
| `mcp-entry.ts` | Process entry point: config resolution, per-vault runtime wiring, stdio transport, shutdown. |
| `mcp/server.ts` | `createMcpServer` — registers every tool and resource, routes calls to the right vault, translates domain results into tool responses. |
| `mcp/coerce.ts` | Input normalization for write tools: `coerceStringArray` (lenient list parsing), `resolveFrontmatterParams` (frontmatter embedded in `update_note` content), and the shared `FRONTMATTER_DENYLIST`. |
| `config/loadVaultConfig.ts` | Impure shell: picks the config source, reads the file, supplies `fs`/`os` predicates. |
| `config/vaultConfig.ts` | Pure config logic: YAML parsing, schema validation, default-vault resolution, the `NOTES_DIR` fallback. |
| `config/excludeTags.ts` | Default exclude-tag set and the `DOSSIER_EXCLUDE_TAGS` parsing / env-over-config resolution. |
| `notes/NoteStore.ts` | All filesystem access for one vault: list, get, upsert, move, delete, the watcher, path confinement; `listRaw` returns unparsed files for the privacy check. |
| `notes/parseMatter.ts` | The only module that imports `gray-matter`. YAML-only parse and stringify. |
| `notes/dates.ts` | `todayLocal()` — the single source of "today" for generated date stamps. |
| `notes/sections.ts` | Pure body edits behind `append_to_section` and `edit_note`. |
| `notes/frontmatter.ts` | Pure frontmatter edit behind `edit_frontmatter`. |
| `notes/wikilinks.ts` | Pure `[[wiki-link]]` rewriting used by `move`. |
| `notes/todos.ts` | Pure task-item extraction behind `list_todos`; exports the shared fenced-code regex. |
| `notes/tagFilter.ts` | Pure case-insensitive tag exclusion used by the retrieval tools and the search index. |
| `search/SearchIndex.ts` | In-memory BM25 index for one vault. |
| `privacy/writeCheck.ts` | Pure privacy check for station-bound writes: token normalisation and run boundaries, 12-token verbatim matching, case-insensitive link extraction, the keyed, content-bound hold token. |
| `types.ts` | Shared note, search-result, and vault-config types. |

The recurring pattern is **pure module + thin handler**: logic that can be expressed as a string or data transform lives in a pure module with its own test suite and returns a discriminated union (`{ ok: true, … } | { ok: false, reason, … }`). The handler in `mcp/server.ts` owns I/O, maps each `reason` to a caller-facing message, and never relies on exceptions for expected failures.

## Multi-vault model

A *vault* is either a named directory with its own `NoteStore`, `SearchIndex`, and watcher, or a station reached over HTTP (see [Station vaults](#station-vaults)). `mcp/server.ts` keeps them in a name → runtime map and resolves the `vault` param per call:

- **Read-wide:** read tools default to every vault and tag each result with its source.
- **Write-narrow:** write tools default to the single default vault, so an unqualified write never lands in an unexpected place.
- **No silent cross-vault guessing:** `get_note` without `vault` errors if the slug exists in more than one vault.
- **Personal slugs stay local on reads:** `get_note` without `vault` reads local vaults first; on a personal-vault hit it detects station collisions from each station's full listing instead of sending the slug.
- **Moves stay inside one vault.** There is no cross-vault move tool.
- **Resources are default-vault only**, because MCP resources carry no parameters.
- **Shared vaults** (`sync: git-publication` vaults and stations) **cannot be the default vault while a personal vault is configured**; config validation rejects it. This is the structural guard against unqualified writes landing in shared content. A config without any personal vault has nothing to guard, so a station-only config is valid.

### Station vaults

A station vault (`type: station`) is a dossier-station instance. Its runtime (`StationVaultRuntime`) holds only a `dossier-station-api` client; `VaultRuntime` is the union of it and `LocalVaultRuntime`, discriminated by `type`. In `mcp/server.ts`, `readNote`, `writeNote`, `readContext`, and `listAll` branch on that type, so the tool handlers share one code path for both backends.

- **Writes merge identically.** `composeFrontmatter` (in `NoteStore.ts`) is the single frontmatter merge for both `NoteStore.upsert` and station writes. A station note's existing extras keep their lists and objects; the local read path has already flattened local ones. Because `write` replaces the stored frontmatter wholesale, `writeNote` then drops the typed fields that were only filled in on read (`withoutFilledFields`, keyed off the frontmatter the station returned).
- **No optimistic concurrency.** Station edits read, transform, then `write`; the contract has no revision precondition, so concurrent edits to one note are last-write-wins.
- **Station failures degrade read-wide calls, never local ones.** `readEach` runs a read across vaults; with `vault` omitted, a station error becomes a notice (an extra text item after the main result) and the other vaults still answer. Local errors, and station errors on a call that named the station, fail the call as before.
- **Timeouts are unreachability.** `createStationRuntime` wraps `fetch` with `AbortSignal.timeout(timeoutMs)`; the client reports the abort as `unreachable`.
- **No index or watcher.** The station searches on its side; local writes rebuild their own index, station writes rebuild nothing.
- **Unsupported operations are refused, not emulated:** `delete_note` and `move_note` (no station verb), `list_todos` (would need every note body), and note writes to `issues/…` slugs (the contract routes issues through its issue operations, not `write`).
- **Issues have their own tools.** `create_issue`, `update_issue`, `comment_issue`, and `query_issues` are thin wrappers over the matching client methods. They and `note_history` target one station through `resolveStationVault`, so a failure is an error rather than a notice. The station owns issue rules (duplicate detection, ID allocation, the resolution cross-field checks); the server only validates the ID shape and maps snake_case params to the contract's hyphenated fields (`ISSUE_UPDATE_FIELDS`, with the zod params in `ISSUE_UPDATE_PARAMS`; compile-time checks keep the map, the params, and `IssueFieldsUpdate` in step). A possible-duplicates answer is a successful result, since it is a step in the create flow. Attribution defaults to the MCP client's name (`getClientVersion()`).
- **Every station-bound write passes the privacy check first.** dossier-mcp is the only component that sees both the personal vaults and a station, so the check lives here. `guardStationWrite` runs before the station branch of `writeNote` (through the `guard` option, so it sees the exact frontmatter about to be sent and subtracts the stored note's content) and before `createIssue`, `updateIssue`, and `commentIssue`. It resolves to `null` to send or to the held result; `writeNote` reports a hold as `{ ok: false, held }`, keeping the no-exceptions-for-expected-outcomes rule. Personal vaults are local runtimes without `shared` (set by the entry point from `sync: git-publication`). Their notes are read raw (`NoteStore.listRaw`, unparsed, so broken frontmatter can't hide a note) along with each context file, from disk per check rather than indexed: station writes are rare, and a fresh read can't go stale. A missing vault root or a read error (file or directory, via `walkMdFiles` in strict mode) fails the write, and files are read in bounded batches. A file that vanishes between the walk and the read triggers one re-walk (`readRawOnce`), so a renamed note is still read. Approval is the client's form-elicitation prompt when it is supported, with a 10-minute timeout (`PROMPT_TIMEOUT_MS`), cancelled along with the tool call via the handler's `signal` (`HoldOptions`). Any answer other than an explicit accept refuses, including a timeout or a failed prompt. The exception is a `MethodNotFound` rejection, where no prompt was shown, which falls back to the token. Otherwise approval is an `approve_hold` token: an HMAC of vault, tool, target issue (if any) and outgoing content under a per-process random secret, so it can't be computed outside the server or replayed for other content. The token is ignored for clients that can be prompted, so it never stands in for the user's answer. A write's own station path is checked separately from its links (`Outgoing.path`, reported as a path match). Reads are not checked: they send queries, prefixes and filters to stations, and slugs not found in a personal vault. The matching rules are in [TOOLS.md](TOOLS.md) under station vaults; the limits are in [SECURITY.md](../SECURITY.md).
- **Issue vs doc is a slug rule.** `noteKind` treats a slug under `issues/` as an issue, matching the station's `kind`; `search_notes`' `type` filter sends `kind` to stations and passes the same rule to `SearchIndex.search` as an `include` predicate for local vaults.

Search scores are per-vault BM25 and are merged by raw score without normalization; see the `search_notes` entry in [TOOLS.md](TOOLS.md#search_notes).

## Configuration

Resolution happens once, at startup (`config/loadVaultConfig.ts` → `config/vaultConfig.ts`):

1. `DOSSIER_CONFIG` set → read that file. If it does not exist, startup fails.
2. Otherwise, `${XDG_CONFIG_HOME:-~/.config}/dossier/config.yaml` if it exists.
3. Otherwise, the fallback: a single vault named `default` at `NOTES_DIR` (or, if unset, the repo's bundled `notes/` directory).

When a config file is found, `NOTES_DIR` is ignored. The config schema and validation rules are documented in the [README](../README.md#multi-vault-configuration). Validation failures carry a machine-readable code (`config_not_found`, `parse_error`, `malformed`, `no_vaults`, `default_required`, `default_unknown`, `default_is_shared`, `bad_vault_name`, `path_missing`, `api_key_missing`). A station's API key is read from the env var its `api_key_env` names, through an injected `getEnv`, and stored on the resolved `StationVaultConfig`.

The default exclude-tag set is resolved as: `DOSSIER_EXCLUDE_TAGS` if set (an empty string means "exclude nothing"), else the config file's `exclude_tags`, else `archived, historical`. A tool call's `exclude_tags` param overrides whichever applies.

`excludeTags.ts` and `vaultConfig.ts` are kept free of `import.meta` and direct `fs`/`os` use so that ts-jest can import them; the impure wiring lives in `loadVaultConfig.ts` and `mcp-entry.ts`. Keep that split when adding config.

## NoteStore

- **Path confinement.** Every slug is validated and then resolved against the vault root, and the resolved path must equal the root or start with root + separator. Details in [SECURITY.md](../SECURITY.md#vault-confinement).
- **Directory walk.** Recursively collects `.md` files, following symlinked directories with a visited-realpath set so cycles terminate. Files whose path contains `.sync-conflict` (Syncthing conflict copies) are skipped. Unreadable or unparseable files are logged to stderr and skipped, so one bad file cannot break indexing.
- **Atomic writes.** All writes go through `writeAtomically`: content is written to a sibling temp file, then `rename`d into place (overwrite) or hard-linked into place (create-or-fail, `EEXIST` with no check-then-write race). The temp file is always in the target's directory, so both operations are same-filesystem and atomic.
- **Move.** Writes the target in create-or-fail mode, then unlinks the source; if the unlink fails, the new file is removed so the pre-move state is restored. References in other notes are updated afterwards (see `move_note` in [TOOLS.md](TOOLS.md#move_note)). Referrers whose `related` list changes are re-serialized through `upsert`; referrers with only inline links are patched on their raw text so their frontmatter is preserved byte-for-byte.
- **Delete** unlinks the file and prunes now-empty parent directories up to the vault root.
- **`get`** returns `null` for a missing file and throws for any other read or parse error.
- **Watcher.** A chokidar watcher on the vault root emits a debounced `change` (300 ms) on add/change/unlink of `.md` files. `awaitWriteFinish` waits for file size to be stable for 500 ms, which also keeps the watcher quiet during the server's own short-lived temp files.

### Frontmatter contract

```yaml
---
title: Note Title
date: '2026-01-15'
tags: [tag1, tag2]
related: [other/slug]
status: draft        # any extra scalar field round-trips
---
Body in Markdown. [[other/slug]] links are Obsidian-compatible.
```

- `title`, `date`, `tags`, `related` are **tool-managed**: always present after parsing (`title` defaults to `Untitled`, lists to `[]`) and settable only through typed params.
- Extra fields are passed through, but must be **flat scalars** (string, number, boolean, date). Arrays and nested objects in extra fields are dropped on read and on write.
- `date` accepts an ISO `YYYY-MM-DD` string or an unquoted YAML date. Anything else falls back to today, so date-sorted listing stays consistent.

### Parser boundary

`parseMatter.ts` is the single entry point to `gray-matter`, for both parsing and stringifying. It rejects any frontmatter fence whose language is not empty, `yaml`, or `yml`, and overrides gray-matter's JavaScript engine to throw. Note files are untrusted input (they arrive via file sync and via tool calls), so the parser is a trust boundary; keeping it in one module means the guarantee is verified by grepping for `gray-matter` imports. Never import `gray-matter` anywhere else. See [SECURITY.md](../SECURITY.md#yaml-only-frontmatter-parsing).

### Dates

`dates.ts` exposes `todayLocal(now?, timeZone?)`, which formats `YYYY-MM-DD` in the host's local zone. Every date the server *generates* (`date` on create, `updated` on surgical writes, the invalid-date fallback) goes through it.

Dates *parsed* from frontmatter deliberately stay on UTC: js-yaml reads an unquoted `2026-01-15` as UTC midnight, so converting it to local time would shift it back a day west of Greenwich. Do not unify the two paths in either direction.

The `timeZone` parameter exists for tests only. Node caches the host zone on first use, and assigning `process.env.TZ` inside a Jest run does not reliably invalidate it, so a test that mutates `TZ` can silently assert against the host zone. Pass the zone explicitly in tests; to check the whole suite under a different zone, set `TZ` when launching the process (e.g. `TZ=Asia/Tokyo pnpm test`).

## SearchIndex

- One instance per vault, rebuilt from scratch on every change. This is cheap at personal-vault scale; incremental updates would be the first optimization if vaults grow large.
- Indexes title, tags, `related` slugs, and body with field weights 3.0 / 2.0 / 1.5 / 1.0, and scores with BM25 (`k1 = 1.2`, `b = 0.75`). An empty corpus is guarded so it cannot produce `NaN` scores.
- Tokenization lowercases and splits on non-word characters; single-character terms are indexed. Query terms of three or more characters also match as prefixes; shorter terms match exactly.
- Excerpts are cut around the first hit (40 characters before, 80 after; 120-character fallback) from title, tags, and body only — `related` slugs contribute to scoring but never to excerpts.
- Tag exclusion is applied while collecting results, before the limit slice, using a predicate built once per query.

## Known limitations

- Fenced-code masking (used by `list_todos`, `append_to_section`, and wiki-link rewriting) recognizes closed triple-backtick fences only. `~~~` fences, indented code blocks, and unterminated fences are treated as ordinary text.
- `related` symmetry is the caller's responsibility; no tool maintains back-links.
- Cross-vault search ranking is approximate (per-vault corpus statistics).

## Dependencies

Runtime (`server/package.json`):

| Package | Used for |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server and stdio transport. |
| `chokidar` | Per-vault file watching. |
| `gray-matter` | Frontmatter parse/stringify, accessed only via `parseMatter.ts`. |
| `js-yaml` | Parsing the multi-vault config file. |
| `dossier-station-api` | The workspace package: typed client for station vaults. |
| `slugify` | Default slugs from titles (`inbox/<slug>`). |
| `zod` | Tool input schemas. |

None of them is a network client; SECURITY.md relies on that.

Two major versions of js-yaml are installed: the direct dependency (used for config, safe `load` by default) and an older one pulled in by gray-matter. gray-matter calls the older version's `safeLoad`, so frontmatter parsing does not use the unsafe loader.

Dev: `typescript`, `tsx` (run TypeScript directly), `jest` + `ts-jest`, and type packages. The pnpm version is pinned via `packageManager`; the repo is a pnpm workspace (`server`, `packages/*`) with one root lockfile, and installs use `--frozen-lockfile` (see [AGENTS.md](../AGENTS.md#development-commands)).

## Station API package

`packages/station-api/` (`dossier-station-api`) is the wire contract between dossier-station, a self-hosted shared vault and issue tracker, and its clients. It lives in this public repo because the station repo is private and a public package can't depend on a private one. The server depends on it through `workspace:*` for station vaults. Under Jest, the server maps the package to its TypeScript source (`server/jest.config.cjs`), since Jest can't load the ESM `dist/`; `tsc` and the runtime use the built `dist/`, which the package's `prepare` script builds on install. Usage and versioning are in the [package README](../packages/station-api/README.md).

| Module | Role |
|---|---|
| `src/registry.ts` | `stationSchemas`, the package-local zod registry, and `named()`, which registers a schema under a component ID. |
| `src/common.ts` | Slugs, issue IDs, dates, commit SHAs, the error envelope and its code → HTTP status map. |
| `src/frontmatter.ts` | Issue and project frontmatter, the partial-update shape, issue and summary views. |
| `src/notes.ts` | Note reads (get, list, search) and the verbs `write`, `history`, `freshen`, plus request shapes for the reserved `propose`, `resolve`, `promote`. |
| `src/issues.ts` | Issue create (with the duplicate-check union), update, comment, query, bulk update. |
| `src/endpoints.ts` | The endpoint table: path, key scope, request and response schema for every operation. |
| `src/client.ts` | `createStationClient`, which derives one method per endpoint from the table. |
| `src/openapi.ts` | `buildOpenApiDocument`, which derives the OpenAPI 3.1 document from the registry and the table. |

Invariants:

- **zod schemas are the single source.** TypeScript types are `z.infer` of them and the OpenAPI document is generated from them; `openapi.json` is committed and a test fails when it is stale.
- **Every endpoint schema must be named.** The generator throws if a request or response schema is not in `stationSchemas`, since it emits each endpoint body as a `$ref`.
- **The package uses its own registry, not zod's global one,** so two copies of the package in one process can't collide on IDs.
- **Objects are generated with `io: 'input'`**, so the document doesn't declare `additionalProperties: false` and leaves room for later fields. The client parses responses with zod's default strip mode, so an older client ignores fields added by a newer station.
- **Reserved verbs have `response: null`.** The document lists only their 501 response, and their client methods always reject.
- **Client failures are one error type.** Every client method rejects with `StationApiError`: the station's error code (passed through even when this client version doesn't know it), or `unreachable` (no response) / `invalid_response` (body doesn't match the contract).
- **`IsoDateTime` has no `format` in the document.** RFC 3339 `date-time` requires seconds and an offset, and stored issues use `2026-10-18T14:02`; the generator strips `format` so the pattern alone describes the shape.

## Tests

Run `pnpm test` (Jest via ts-jest, ESM) and `pnpm typecheck` from the repo root to cover every workspace package, or from `server/` or `packages/station-api/` for one; CI runs both from the root on every pull request on Node 24 after a frozen-lockfile install. Station API suites (`packages/station-api/src/__tests__/`) cover schema rules (`schemas.test.ts`), client request shape and error mapping (`client.test.ts`), and OpenAPI freshness and structure (`openapi.test.ts`). The server suites below all live under `server/src/`. Test files sit next to the code in `__tests__/` directories, one suite per module:

| Suite | Covers |
|---|---|
| `mcp/__tests__/mcpTools.test.ts` | Tool handlers end to end against a temp vault: schema validation and coercion, slug validation, error shapes, `withToolError`, frontmatter round-trip and denylist, each write tool's success and structured-error paths (and that failed edits leave the note untouched), index rebuild after writes, `exclude_tags` behavior, resources, and the `vault` param surface. |
| `mcp/__tests__/multiVault.test.ts` | Vault routing: read-wide results with provenance, cross-vault search merge, `get_note` resolution and collision errors, write-narrow defaults, per-vault context files, unknown-vault errors. |
| `mcp/__tests__/station.test.ts` | Station vaults against `stubStation.ts`, an in-process HTTP stub that routes by the package's endpoint table and parses every request and response through its schemas: read-wide merging and provenance, raw round-trip, degraded reads (server gone, timeout, rejected key), writes through `write` (create conflict, extras preserved), `note_history`, the `search_notes` `type` filter, and the refused tools. |
| `mcp/__tests__/stationIssues.test.ts` | The issue tools against the same stub, which also implements the single-issue operations: create with the duplicate-candidates branch and `confirm_new`, `created-by` attribution, update field mapping and `null` clearing, station rule rejections, comments, query filters and subprojects, and station-vault resolution. |
| `mcp/__tests__/stationPrivacy.test.ts` | The privacy check end to end: every station-bound write tool held on a personal link and on verbatim personal or context-file text with nothing reaching the stub, clean writes, local writes unchecked, shared vaults not sources, no personal vault, a personal note with broken frontmatter, a station note at a personal path, frontmatter keys, existing station content not re-triggering, `approve_hold` accepted only for the same content and never over a shown prompt, the elicitation accept / decline / failure paths, an unreadable context file failing closed, and read-wide `get_note` of a personal note sending no slug while still detecting a station collision from the listing. |
| `privacy/__tests__/writeCheck.test.ts` | Normalisation (case, punctuation, markdown, NFKC, invisible characters, exact trailer and footer lines), the 12-token boundary, run boundaries (list items join; headings, task items and blank lines don't) and a copied profile of short facts, link forms and case-insensitive slugs, previous-content subtraction, match caps, the keyed hold token, and boilerplate fixtures that must not trip the check. |
| `config/__tests__/vaultConfig.test.ts` | Config resolution chain, `NOTES_DIR` fallback, tilde expansion, station entries, the shared-default guard, every named validation error, env-over-config exclude tags. |
| `config/__tests__/excludeTags.test.ts` | `DOSSIER_EXCLUDE_TAGS` parsing (unset vs. empty vs. list) and precedence. |
| `notes/__tests__/NoteStore.test.ts` | CRUD, slug confinement, date handling, symlink walk and loop protection, conflict-file filtering, directory pruning, atomic writes, move atomicity and rollback, reference and wiki-link rewriting, watcher behavior, rejection of executable frontmatter in vault files. |
| `notes/__tests__/parseMatter.test.ts` | Non-YAML fences rejected (asserting a sentinel global was never set, proving nothing was evaluated); YAML variants and fence-less notes accepted; `!!js/function` refused. |
| `notes/__tests__/dates.test.ts` | `todayLocal` across explicit time zones, including half-hour offsets and year rollover. |
| `notes/__tests__/sections.test.ts` | `appendToSection` and `editBody` semantics and edge cases. |
| `notes/__tests__/frontmatter.test.ts` | `applyFrontmatterEdit` list semantics, `set` normalization, conflict / no-op detection. |
| `notes/__tests__/wikilinks.test.ts` | Link forms, exact-slug matching, fence skipping. |
| `notes/__tests__/todos.test.ts` | Task-item extraction and fence stripping. |
| `notes/__tests__/tagFilter.test.ts` | Case-insensitive exclusion helpers. |
| `search/__tests__/SearchIndex.test.ts` | BM25 scoring and field weighting, prefix and single-character queries, excerpts, limits, empty corpus, tag exclusion and the `include` predicate before limiting. |

Conventions:

- Pure modules get their own suite; handler behavior is tested through the registered tools.
- Tests never import a module that uses `import.meta` (ts-jest cannot compile it in this setup) — keep such code in thin entry/loader modules.
- Time-zone-sensitive tests pass the zone explicitly rather than mutating `TZ`.
