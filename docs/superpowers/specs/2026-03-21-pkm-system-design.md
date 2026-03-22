# PKM System Design

**Date:** 2026-03-21

## Overview

A personal knowledge management system for capturing notes from Claude Code conversations, with cross-device sync and MCP integration so Claude can read and write notes during future sessions.

## Problem

- Notes from Claude Code conversations accumulate across separate git repos per topic (startup research, finances, moving, etc.), which doesn't scale
- No way to link overlapping context across topics (e.g. a personal profile referenced by multiple projects)
- No cross-device sync between laptop (which travels) and desktop
- Claude has no way to access prior notes during new conversations without manual pasting

## Solution

Obsidian vault as the single source of truth for all notes, synced across devices via Syncthing, with a lightweight MCP server (this project, stripped down) running locally on each machine so Claude can read and write notes during any session.

## Architecture

```
~/vault/                          ← Obsidian vault (Syncthing root)
  profile.md                      ← personal context, preferences, goals
  inbox/                          ← unfiled notes (default landing zone)
  projects/
    startup-research/
      index.md                    ← project overview + links
      ...
    finances/
      index.md
      ...
    moving/
      index.md
      ...
  reference/                      ← evergreen technical/factual notes
    react-hooks-rules.md
    ...
```

### Sync

- **Syncthing** runs on laptop, desktop, and home lab
- Home lab acts as always-on relay — syncs between laptop and desktop even when they're not on the same network
- Each machine has a full local copy of `~/vault`, so everything works offline
- Home lab Syncthing exposed at `syncthing.local.ethanaubuchon.com` (nginx + HTTPS, Podman quadlet)
- GitHub private repo remains as a backup/history layer; home lab pushes periodically via cron from the home lab host (out of scope for this codebase — set up as a host cron job separately)

### MCP Server (this project)

Runs as a **stdio process** on each machine, spawned by Claude Code on demand. Points at `~/vault` locally — no network dependency, works offline.

The repo is cloned to the same path on each machine (`/home/ethan/workspace/library`). The `NOTES_DIR` env var in the Claude Code config controls which vault folder the server reads from; `get_profile` constructs the profile path as `$NOTES_DIR/profile.md`.

**Claude Code config** (`~/.claude/settings.json` on each machine):
```json
{
  "mcpServers": {
    "library": {
      "command": "node",
      "args": ["/home/ethan/workspace/library/server/dist/mcp-entry.js"],
      "env": {
        "NOTES_DIR": "/home/ethan/vault"
      }
    }
  }
}
```

### Home Lab Stack (Podman quadlets)

- `syncthing` — file sync daemon, vault at `/data/vault` on host
- ~~library MCP~~ — not needed; MCP runs locally on each client machine via stdio

## Slug Convention

A **slug** is the relative path from the vault root to the note file, without the `.md` extension. Examples:

- `profile` → `~/vault/profile.md`
- `projects/startup-research/index` → `~/vault/projects/startup-research/index.md`
- `reference/react-hooks-rules` → `~/vault/reference/react-hooks-rules.md`

Slugs are used as note identifiers in all MCP tool parameters and in the `related` frontmatter field. The `[[slug]]` link syntax in note content uses the same convention and is Obsidian-compatible.

When `create_note` is called with a `path` parameter, that path **is** the slug verbatim. When no `path` is given, the slug is `"inbox/" + makeSlug(title)`. In both cases the slug derivation happens **inside the `create_note` tool handler** before calling `noteStore.upsert({ slug, ... })`; `upsert()` itself is not changed. The slug is immutable — `update_note` cannot relocate a note. The `path` MCP parameter is mapped to the `slug` field in `NoteStore.upsert()` inside the tool handler; `upsert()` itself is not renamed.

### Slug Validation

All tool handlers that accept a user-provided slug or path must validate it **in the tool handler**, before calling `upsert()` or `noteStore.get()`:
- Reject any slug containing `..` (path traversal)
- Reject any slug starting with `/` (absolute path)
- Return `{ isError: true, content: [{ type: 'text', text: 'Invalid slug: must be a relative path without ..' }] }` on failure

## This Codebase: What Changes

### Remove
- `client/` — entire React/Vite frontend (not used in workflow)
- `server/src/routes/` — REST API routes (notes, search, settings)
- `server/src/notes/noteBlockParser.ts` and its tests — no longer needed; Claude writes notes directly via MCP tools
- `compose.yml` client service
- HTTP server setup in `server/src/index.ts`

### Keep and Extend

**`server/src/notes/NoteStore.ts`**
- `list()`: replace flat `readdir` with a recursive walk of `NOTES_DIR`; filter out any path containing `.sync-conflict`; filter to `.md` files only; return type stays `NoteListItem[]`
- Add `listWithContent(): Promise<Array<NoteListItem & { content: string }>>` — same recursive walk, same `.sync-conflict` filter, same date-descending sort as `list()`, but also reads file content for each note. Returns the intersection type that `buildIndexWithContent` already expects — do not change `buildIndexWithContent`'s signature.
- `upsert()`: no change to method signature. Call `fs.mkdir(parentDir, { recursive: true })` before writing to create intermediate directories. When `slug` is provided, use it directly as the file path; when omitted, auto-generate from title as before.
- File watcher glob: change from `*.md` (root only) to `**/*.md` (recursive); apply the same `.sync-conflict` filter

**`server/src/search/SearchIndex.ts`**
- `buildIndex()` is kept (used in existing tests); no signature change
- `buildIndexWithContent` is used for all runtime paths (startup and after mutations); its signature is unchanged; update its implementation to also include `related` slugs in indexed text (currently it indexes only `title + tags + content` — add `...note.frontmatter.related` to match `buildIndex` behavior)

**`server/src/mcp/server.ts`**
- `create_note` tool handler: call `noteStore.get(slug)` first; if a note exists, return `{ isError: true, content: [{ type: 'text', text: 'Note already exists at <slug> — use update_note to modify it' }] }`; if not, call `noteStore.upsert()`. The "already exists" guard lives in the tool handler, not in `upsert()`, so existing `NoteStore` upsert tests remain valid.
- `update_note` tool handler: behavior unchanged (already checks existence via `noteStore.get()` before calling `upsert()`)
- After any mutation (`create_note`, `update_note`, `delete_note`): replace `noteStore.list()` + `searchIndex.buildIndex()` with `noteStore.listWithContent()` + `searchIndex.buildIndexWithContent()`
- `list_notes` tool: add `path: z.string().optional()` to the Zod schema; implement prefix filter as `startsWith` on slug; normalize trailing slash (both `"projects"` and `"projects/"` match `projects/startup-research/index`); exact prefix, not substring (`"project"` does NOT match `"projects/"`); `path = undefined` or `path = ""` returns all notes; add tests for prefix filter, slash normalization, and empty/undefined cases
- `notes://index` resource handler: stays on `noteStore.list()` (metadata-only is sufficient for display); URL-encode slugs containing slashes when constructing `note://` URIs (e.g. `note://projects%2Fstartup-research%2Findex`). Apply same encoding in the `noteTemplate` list callback.
- `note://{slug}` resource handler: URL-decode the `slug` parameter received from the MCP SDK before passing to `noteStore.get()` (use `decodeURIComponent`) to handle both encoded and unencoded slugs correctly.

**`server/src/mcp-entry.ts`**
- Startup: replace `noteStore.list()` + `searchIndex.buildIndex()` with `noteStore.listWithContent()` + `searchIndex.buildIndexWithContent()`
- `change` event handler: ignore the emitted payload; call `noteStore.listWithContent()` + `searchIndex.buildIndexWithContent()` directly inside the handler. (The emitted payload remains `NoteListItem[]` — leave `NoteStore`'s emit unchanged; the handler simply does not use it.)

### Add
- `get_profile` MCP tool — reads `$NOTES_DIR/profile.md` and returns its raw markdown content (same format as `get_note`); profile.md does not require frontmatter; if missing, returns `{ isError: true, content: [{ type: 'text', text: 'profile.md not found — create it at the vault root to use this tool' }] }`; tests must cover: profile exists (returns content), profile missing (returns error)
- `path` parameter on `create_note` — mapped to `slug` in `upsert()` call inside the tool handler
- Update existing `mcpTools` tests to use `noteStore.listWithContent()` + `searchIndex.buildIndexWithContent()` where index rebuilds are tested; `SearchIndex.test.ts` can continue using `buildIndex` directly since that method is kept

### MCP Tools (final set)

| Tool | Parameters | Purpose |
|---|---|---|
| `get_profile` | — | Fetch `profile.md` for personal context |
| `list_notes` | `path?: string` (slug prefix filter, recursive) | List notes; `"projects/startup-research"` returns all slugs with that prefix |
| `get_note` | `slug: string` | Fetch a note by slug |
| `search_notes` | `query: string`, `limit?: number` | Keyword search across entire vault including note body content |
| `create_note` | `title: string`, `content: string`, `path?: string`, `tags?: string[]`, `related?: string[]` | Create a note; `path` becomes slug; defaults to `inbox/<title-slug>`; errors if slug exists |
| `update_note` | `slug: string`, `title: string`, `content: string`, `tags?: string[]`, `related?: string[]` | Update in place; errors if not found; cannot relocate |
| `delete_note` | `slug: string` | Permanently delete (no trash) |

## Vault Structure Conventions

- Each project gets a folder under `projects/` with an `index.md` as the entry point
- Unfiled notes (no explicit `path`) land in `inbox/`
- Notes use YAML frontmatter: `title`, `date`, `tags`, `related`
- Cross-note links use `[[slug]]` syntax in content body; `related` frontmatter lists slugs of explicitly linked notes
- `profile.md` lives at vault root and is never project-specific
- Syncthing conflict files are ignored by NoteStore and the search index; filter by substring match: skip any file whose full path includes `.sync-conflict` (e.g. `note.md.sync-conflict-20260321-120000-ABCDEF`)

## Workflow

1. Start a Claude Code session on any machine
2. Claude fetches `profile.md` and relevant project `index.md` at session start (via MCP)
3. During conversation, Claude searches/reads notes as needed for context
4. At end of session (or when relevant context emerges), Claude creates or updates notes in the vault
5. Syncthing propagates changes to all other machines automatically

## Out of Scope

- Mobile access
- Web UI for browsing notes
- Semantic/vector search (keyword search is sufficient for now)
- Multi-user access
- GitHub backup cron setup (home lab host cron job, not part of this codebase)
- Syncthing conflict resolution (Syncthing creates `.sync-conflict` files; resolving them is a manual user action)
- Note relocation / slug rename
