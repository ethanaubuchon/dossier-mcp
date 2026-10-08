# Tool and Resource Reference

Detailed behavior of every MCP tool and resource the server registers (`server/src/mcp/server.ts`). The [README](../README.md) has the one-line summary; this page is the contract.

## Conventions shared by all tools

- **Slugs** are vault-relative paths without the `.md` extension (e.g. `projects/startup/market-analysis`). A slug is rejected if it is empty, contains a null byte, starts or ends with `/`, or contains `..`. `NoteStore` repeats the check and additionally verifies the resolved path stays inside the vault root (see [SECURITY.md](../SECURITY.md#vault-confinement)).
- **Errors** are returned as a tool result with `isError: true` and a human-readable message; tools do not throw to the client.
- **`vault` param.** Every tool accepts an optional `vault` naming one of the configured vaults (see [Multi-vault configuration](../README.md#multi-vault-configuration)). An unknown name errors and lists the configured vaults.
  - **Read tools** (`list_notes`, `search_notes`, `list_todos`): omitting `vault` spans *all* vaults, and every result carries a `vault` field naming its source.
  - **Write tools** (`create_note`, `update_note`, `append_to_section`, `edit_note`, `edit_frontmatter`, `move_note`, `delete_note`): omitting `vault` targets the **default vault**.
  - `get_note` resolves across all vaults (see below); `get_vault_context` reads the default vault's context file.
- **Default tag exclusion.** `list_notes`, `search_notes`, and `list_todos` omit notes carrying any tag in the default-exclude set (`archived`, `historical` unless configured otherwise). Matching is case-insensitive and is a hard filter, not a de-rank. Per call, `exclude_tags: []` disables exclusion and a non-empty list replaces the default set. `get_note` and the resources ignore exclusion — it is a discovery default, not an access control.
- **Index freshness.** Every successful write rebuilds the search index of the vault it wrote to before returning, so a following `search_notes` sees the change. External edits (an editor, file sync) are picked up by the per-vault file watcher.
- **`updated` stamping.** The surgical write tools (`append_to_section`, `edit_note`, `edit_frontmatter`) set `updated: YYYY-MM-DD` in the host's local time zone. `create_note` sets `date` the same way; `update_note` preserves the original `date`.
- **Array coercion.** `tags`, `related`, and the `add_*`/`remove_*` list params accept a real array, a JSON-encoded array string, or a comma-separated string. On `create_note`/`update_note`, an empty list (`[]` or `"[]"`) means "keep the existing value", not "clear" — this protects the common get → modify → update round trip where clients send `tags: []` to mean "unchanged". To remove tags or related entries, use `edit_frontmatter`.

## Read tools

### `get_vault_context`

| Param | Type | Notes |
|---|---|---|
| `vault` | string? | Omit for the default vault. |

Returns the raw text of the vault's context file — `profile.md` at the vault root unless the vault sets `context_file`. Errors clearly if the file does not exist. Clients are expected to call this first in a session.

### `list_notes`

| Param | Type | Notes |
|---|---|---|
| `path` | string? | Slug prefix filter; a trailing `/` is added if missing, so `projects` matches `projects/…` but not `projects-old/…`. |
| `exclude_tags` | string[]? | Overrides the default-exclude set for this call. |
| `vault` | string? | Omit to span all vaults. |

Returns a JSON array of `{ slug, frontmatter, vault }`, sorted by `date` descending across all queried vaults.

### `get_note`

| Param | Type | Notes |
|---|---|---|
| `slug` | string | |
| `vault` | string? | Omit to resolve across all vaults. |

Returns the note's raw Markdown (frontmatter + body), suitable for passing straight back to `update_note`. With `vault` omitted, every vault is checked (default first); if the slug exists in more than one vault the call errors, listing them, rather than guessing.

### `search_notes`

| Param | Type | Notes |
|---|---|---|
| `query` | string | Keywords. |
| `limit` | int 1–100? | Default 10. |
| `exclude_tags` | string[]? | Overrides the default-exclude set for this call. |
| `vault` | string? | Omit to span all vaults. |

BM25 keyword search over title, tags, `related` slugs, and body, with field weighting (title > tags > related > body). Terms of three or more characters also prefix-match; shorter terms match exactly. Returns a JSON array of `{ slug, frontmatter, score, excerpt, vault }`. Excerpts are drawn from title, tags, and body (never from `related` slugs).

Excluded notes are dropped **before** the limit is applied, so results still fill up to `limit`. Exclusion is a filter on results, not on the index: corpus statistics still include excluded notes.

Across vaults, each vault's index returns up to `limit` hits and the results are merged by raw score. Scores are computed against each vault's own corpus statistics and are **not normalized across vaults**, so cross-vault ordering is approximate.

### `list_todos`

| Param | Type | Notes |
|---|---|---|
| `path` | string? | Slug prefix filter (same normalization as `list_notes`). |
| `limit` | int 1–100? | Maximum number of *notes* returned. Default 10. |
| `exclude_tags` | string[]? | Overrides the default-exclude set for this call. |
| `vault` | string? | Omit to span all vaults. |

Returns `{ slug, title, todos, vault }` for notes containing unchecked task items (`- [ ] text`, also `*`/`+` markers, any indentation), newest first. Checked items (`[x]`/`[X]`), malformed boxes (`[]`, `-[ ]`), and anything inside closed triple-backtick fences are ignored. `~~~` fences and indented code blocks are not stripped.

## Write tools

### `create_note`

| Param | Type | Notes |
|---|---|---|
| `title` | string | |
| `content` | string | Markdown body. |
| `path` | string? | Slug for the new note. Defaults to `inbox/<slugified-title>`. |
| `tags` | string[]? | |
| `related` | string[]? | Slugs of related notes. |
| `frontmatter` | object? | Extra frontmatter fields (e.g. `{ status: "draft" }`). May not contain `title`, `date`, `tags`, or `related`. |
| `vault` | string? | Omit for the default vault. |

Errors if a note already exists at the slug. Intermediate directories are created as needed.

### `update_note`

| Param | Type | Notes |
|---|---|---|
| `slug` | string | Must already exist. |
| `content` | string | New body. May include a frontmatter block. |
| `title` | string? | Required unless present in embedded frontmatter. |
| `tags`, `related` | string[]? | Omit (or pass `[]`) to keep existing values. |
| `frontmatter` | object? | Extra fields; same denylist as `create_note`. |
| `vault` | string? | Omit for the default vault. A note read from another vault must name it here. |

Whole-body overwrite. If `content` begins with a frontmatter block, it is stripped from the body and its `title`/`tags`/`related`/extra fields are used; explicit params win over embedded values, and the explicit `frontmatter` param wins over embedded extras. Existing extra fields not mentioned are preserved. `date` is never changed.

### `append_to_section`

| Param | Type | Notes |
|---|---|---|
| `slug` | string | |
| `heading` | string | Exact heading text, without the leading `#`s. |
| `content` | string | Appended at the end of the section. |
| `create_if_missing` | boolean? | Default `false`. |
| `vault` | string? | Omit for the default vault. |

Appends without resending the note. The heading is matched by exact, case-sensitive text at any level; the matched heading's level defines where the section ends (the next heading of the same or higher level). A missing heading errors and lists the note's headings, unless `create_if_missing` is set, in which case a new `## heading` section is added at the end of the note. A heading that matches more than once errors with the count. Headings inside closed backtick fences are ignored. Returns the full updated note.

### `edit_note`

| Param | Type | Notes |
|---|---|---|
| `slug` | string | |
| `old_string` | string | Exact, whitespace-sensitive, literal (not a regex). |
| `new_string` | string | May be empty to delete the match. |
| `replace_all` | boolean? | Default `false`. |
| `vault` | string? | Omit for the default vault. |

Find-and-replace within the body only (frontmatter is not searched). Errors if there is no match, if the match is not unique and `replace_all` is not set (reporting the count), or if `old_string === new_string`. Returns the full updated note.

### `edit_frontmatter`

| Param | Type | Notes |
|---|---|---|
| `slug` | string | |
| `set` | object? | Scalar fields to set (strings, numbers, booleans, dates). |
| `add_tags`, `remove_tags` | string[]? | |
| `add_related`, `remove_related` | string[]? | |
| `vault` | string? | Omit for the default vault. |

Frontmatter-only edit; the body is passed through byte-for-byte. `set` may not target `title`, `date`, `tags`, or `related` (the error names the right param instead); an `updated` key in `set` is ignored because the tool stamps it. Lists use order-preserving set semantics: adding a present entry or removing an absent one is a no-op. Errors when no operation is supplied, when the same entry is both added and removed, or when the net effect is no change. `related` is not kept symmetric — editing one note does not touch the notes it points to. Returns the full updated note.

### `move_note`

| Param | Type | Notes |
|---|---|---|
| `slug` | string | Current slug. |
| `new_slug` | string | Target slug. |
| `vault` | string? | Omit for the default vault. Moves never cross vaults. |

Moves the note with its content and metadata intact, then rewrites references to the old slug across the vault: `related` entries and inline wiki-links (`[[old]]`, `[[old|alias]]`, `[[old#heading]]`; links inside backtick fences are left alone). Notes whose only reference is an inline link are rewritten in place, so their frontmatter is preserved exactly. Fails if a note already exists at `new_slug` (there is no overwrite flag) or if the slugs are equal. Empty directories left behind are removed. The response lists the notes whose references were updated.

### `delete_note`

| Param | Type | Notes |
|---|---|---|
| `slug` | string | |
| `vault` | string? | Omit for the default vault. |

Permanently unlinks the file — there is no trash — and removes any directories left empty up to the vault root.

## Resources

Resources have no parameters, so all three are bound to the **default vault**.

| URI | Content |
|---|---|
| `vault://context` | The default vault's context file. Same content as `get_vault_context`. |
| `notes://index` | Markdown list of every note: title, `note://` link, date, tags. |
| `note://{slug}` | A single note's raw Markdown. The slug is URL-encoded in the URI (`/` → `%2F`). |
