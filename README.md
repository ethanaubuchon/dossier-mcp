# dossier-mcp

AI agents forget everything between sessions, and Claude's built-in memory is project-scoped. dossier-mcp gives your agent a persistent, cross-project memory: architectural decisions, ongoing priorities, and context that doesn't belong to any one project — stored as Markdown in a vault you can read and edit via the [Model Context Protocol](https://modelcontextprotocol.io).

Built and tested with [Claude Code](https://claude.ai/code). Any MCP-compatible coding agent should work — the server uses standard stdio transport. Registration commands below are Claude Code-specific; other clients will have their own configuration method.

See [SECURITY.md](SECURITY.md) for the threat model, the stdio-only and vault-confinement guarantees, and how to report a vulnerability. Contributor reference: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (modules, invariants, tests) and [docs/TOOLS.md](docs/TOOLS.md) (full tool contract).

## Philosophy

This tool is designed for **agent-as-author** use: Claude writes and maintains notes in your vault, building up a persistent cross-session and cross-project memory that you can optionally inspect in Obsidian or any Markdown viewer.

This is the inverse of tools like Obsidian MCP, where the agent reads notes *you* wrote. Here, the agent is the primary author. You direct conversations, the agent captures context, decisions, and knowledge — and picks it all back up next session without you repeating yourself. The result is a lightweight RAG you didn't have to build: structured, searchable, human-readable, and maintained by the agent as a side effect of working with you.

Context persists across sessions and projects — architectural decisions, ongoing priorities, research that doesn't belong to any one repo — all of it available in any new session without rebuilding from scratch.

## Setup

Install with `--frozen-lockfile`. This is the required install path — it fails if a lockfile has drifted from its `package.json` instead of silently resolving different versions, so you get exactly the dependency tree that was committed, reviewed, and tested in CI.

```bash
# from the repo root; one install covers the whole pnpm workspace
pnpm install --frozen-lockfile
```

Use a plain `pnpm install` (no flag) only when you are deliberately adding or upgrading a dependency, and commit the resulting lockfile change with it.

## MCP Configuration

The following commands are for Claude Code. Other MCP clients will have their own way to register a stdio server — point them at the same binary with `NOTES_DIR` set.

These examples serve a single vault via `NOTES_DIR`. To serve several vaults, use a config file instead (see [Multi-vault configuration](#multi-vault-configuration)); when a config file is present, `NOTES_DIR` is ignored and can be dropped from the registration.

### Dev mode (no build step)

Uses `tsx` to run TypeScript directly. Slower startup, no build required.

```bash
claude mcp add -s user dossier-mcp \
  -e NOTES_DIR=/path/to/your/vault \
  -- npx tsx /path/to/dossier-mcp/server/src/mcp-entry.ts
```

### Production mode

Build first, then run the compiled output with plain `node`.

```bash
cd server && pnpm build
```

```bash
claude mcp add -s user dossier-mcp \
  -e NOTES_DIR=/path/to/your/vault \
  -- node /path/to/dossier-mcp/server/dist/mcp-entry.js
```

### Updating an existing registration

`claude mcp add` will error if `dossier-mcp` is already registered. Remove it first:

```bash
claude mcp remove dossier-mcp
```

Then re-add with the command above.

## Environment variables

| Variable | Description |
|---|---|
| `NOTES_DIR` | Absolute path to the vault root (e.g. `/path/to/your/vault`). Used only when no config file is found; it then serves a single vault named `default`. |
| `DOSSIER_CONFIG` | Path to a multi-vault config file. If set, the file must exist or the server refuses to start. |
| `XDG_CONFIG_HOME` | Base directory for the default config location, `$XDG_CONFIG_HOME/dossier/config.yaml` (falls back to `~/.config`). |
| `DOSSIER_EXCLUDE_TAGS` | Comma-separated tags to exclude from `search_notes`, `list_notes`, and `list_todos` results by default (case-insensitive). Overrides both the built-in default (`archived,historical`) and the config file's `exclude_tags`. Set to an empty string to disable default exclusion. Callers can still override per request via each tool's `exclude_tags` param (`[]` includes everything; a list replaces the default). Notes remain directly reachable via `get_note` regardless. |

## Multi-vault configuration

One server can serve several named vaults, each with its own index and file watcher. The config file is located in this order:

1. `$DOSSIER_CONFIG`
2. `${XDG_CONFIG_HOME:-~/.config}/dossier/config.yaml`
3. none — fall back to a single vault named `default` at `$NOTES_DIR`

```yaml
default_vault: personal        # required when more than one vault is defined
exclude_tags: [archived, historical]   # optional; DOSSIER_EXCLUDE_TAGS still wins
vaults:
  personal:
    path: ~/vault              # must be an existing directory; leading ~ is expanded
  work:
    path: ~/work-notes
    context_file: conventions.md   # optional; bootstrap doc, default profile.md
  team:
    path: ~/team-vault
    sync: git-publication      # optional; marks a shared vault
```

A vault can also be a [dossier-station](packages/station-api/README.md) instance, reached over its HTTP API instead of a directory:

```yaml
vaults:
  station:
    type: station
    url: https://station.lan          # http(s) root of the station
    api_key_env: DOSSIER_STATION_KEY  # env var holding the API key; the key never goes in this file
    timeout_ms: 5000                  # optional; a slower request counts as unreachable
    context_file: profile.md          # optional; read from the station as note `profile`
```

Rules, all checked at startup (an invalid config stops the server with a named error):

- Vault names are lowercase letters, digits, and hyphens, starting with a letter or digit.
- `default_vault` must name a configured vault, and may be omitted only when exactly one vault is defined.
- Shared vaults — `sync: git-publication` vaults and stations — cannot be the default vault while a personal (local, non-shared) vault is configured, so writes that don't name a vault never land in shared content. A config made only of shared vaults, such as a single station, may use any of them as the default.
- A station needs `url` and `api_key_env`, and the named env var must be set. It takes no `path` or `sync`.

A station takes part in reads like any other vault. When it can't be reached (or answers with an error) during a read that spans all vaults, the tool still returns the other vaults' results and adds a notice naming the station and the error; a read that names the station errors instead. Note writes go through the station's `write` verb, and `note_history` shows a station note's commit history. `delete_note` and `move_note` are refused on a station, as are note writes to its `issues/` notes, and `list_todos` skips stations. Issues have their own tools (`create_issue`, `update_issue`, `comment_issue`, `query_issues`); `create_issue` runs the station's duplicate check and returns likely matches instead of filing when it finds them.

Every write headed to a station is first checked against your personal vaults (local vaults without `sync: git-publication`). A write that links to a personal note, or copies a run of 12 or more normalised tokens (roughly words) from one or from your `profile.md`, is held: nothing is sent, and the tool says what matched. You approve a held write through your client's prompt when it supports MCP elicitation, or by letting the agent retry with the `approve_hold` token it was given. The check catches copies and links, not paraphrase, and reads still send slugs and queries to stations; see [SECURITY.md](SECURITY.md#privacy-check-on-station-bound-writes).

Every tool takes an optional `vault` param. Read tools (`list_notes`, `search_notes`, `list_todos`) span all vaults when it is omitted and tag each result with its source vault; `get_note` searches all vaults and errors if the slug exists in more than one. Write tools target the default vault unless `vault` is given. Resources always read the default vault. See [docs/TOOLS.md](docs/TOOLS.md) for details.

## profile.md

`get_vault_context` reads `profile.md` at the vault root (or the vault's `context_file`, if configured) — a free-form markdown file that serves as the bootstrap document for the AI. Think of it as an `AGENTS.md` for your notes: when the MCP server is activated, reading this file first orients the agent to the vault — how it's organized, what it contains, and how to navigate it effectively.

What you put here is entirely up to you and your use case. Some possibilities:

- **Personal context** — who you are, current projects, working preferences
- **Vault structure** — how notes are organized, what naming conventions mean, which folders exist
- **Usage instructions** — how the AI should interact with your notes, what to prioritize, what to avoid
- **Domain context** — background knowledge the AI needs to be useful in your specific domain

The file uses standard frontmatter followed by markdown:

```markdown
---
title: Vault Profile
date: '2026-01-01'
tags:
  - profile
---
# My Vault

Brief description of what this vault contains and who it's for.

## Structure

How notes are organized — folders, naming conventions, key entry points.

## How to Use This Vault

Instructions for the AI: what to read first, how to search effectively,
any conventions to follow when creating or updating notes.
```

If `profile.md` doesn't exist, `get_vault_context` returns a clear error message rather than failing silently.

## Tools exposed to Claude

Every tool also accepts an optional `vault` param (see [Multi-vault configuration](#multi-vault-configuration)). Full parameters and behavior: [docs/TOOLS.md](docs/TOOLS.md).

| Tool | Purpose |
|---|---|
| `get_vault_context` | Read the vault's bootstrap document (`profile.md`); read this first |
| `list_notes` | List notes; optional `path` prefix filter (e.g. `projects/startup`) |
| `get_note` | Fetch a note by slug |
| `search_notes` | Full-text keyword search; optional `type` (`issue` / `doc`) filter |
| `list_todos` | List notes with open `- [ ]` checkboxes; optional `path` prefix filter |
| `create_note` | Create a note; `path` sets slug; defaults to `inbox/<title-slug>` |
| `update_note` | Overwrite an existing note by slug (regenerates the whole body) |
| `append_to_section` | Append content under a named `## heading` without regenerating the note |
| `edit_note` | Exact-string find/replace in a note's body; match must be unique unless `replace_all` is set |
| `edit_frontmatter` | Surgical frontmatter-only edit — `set` scalar fields (e.g. `status`) + add/remove `tags`/`related` — without regenerating the body |
| `move_note` | Move/rename a note to a new slug; updates `related` references and inline `[[wiki-links]]` in other notes |
| `delete_note` | Delete a note by slug |
| `note_history` | Commit history of a note in a station vault |
| `create_issue` | File an issue in a station vault, with a duplicate check (`confirm_new` to override) |
| `update_issue` | Change an issue's status or fields |
| `comment_issue` | Comment on an issue |
| `query_issues` | Find issues by status, project, repo, label, or staleness |

## Resources exposed to Claude

MCP resources are read-only and can be enumerated by clients at startup, making them useful for discoverability.

| Resource | Purpose |
|---|---|
| `vault://context` | Vault bootstrap document (`profile.md`). Read this first to orient to the vault. |
| `notes://index` | Index of all notes with titles, tags, dates, and links to each `note://` URI. |
| `note://{slug}` | Individual note content by slug (e.g. `note://projects/startup`). Discover slugs via `notes://index`. |

## Development

```bash
pnpm test         # run every workspace package's tests
pnpm typecheck    # typecheck without emitting (includes test sources)
pnpm build        # compile TypeScript to dist/
```

Run from the repo root these cover every workspace package; run from `server/` or `packages/station-api/` they cover that package only. `pnpm typecheck` and `pnpm test` are the two checks CI runs on every pull request.

The repo is a pnpm workspace with two packages:

- `server/` — the MCP server.
- `packages/station-api/` — `dossier-station-api`, the wire contract and typed client for [dossier-station](packages/station-api/README.md).
