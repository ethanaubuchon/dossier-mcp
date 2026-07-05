# dossier-mcp

AI agents forget everything between sessions, and Claude's built-in memory is project-scoped. dossier-mcp gives your agent a persistent, cross-project memory: architectural decisions, ongoing priorities, and context that doesn't belong to any one project — stored as Markdown in a vault you can read and edit via the [Model Context Protocol](https://modelcontextprotocol.io).

Built and tested with [Claude Code](https://claude.ai/code). Any MCP-compatible coding agent should work — the server uses standard stdio transport. Registration commands below are Claude Code-specific; other clients will have their own configuration method.

## Philosophy

This tool is designed for **agent-as-author** use: Claude writes and maintains notes in your vault, building up a persistent cross-session and cross-project memory that you can optionally inspect in Obsidian or any Markdown viewer.

This is the inverse of tools like Obsidian MCP, where the agent reads notes *you* wrote. Here, the agent is the primary author. You direct conversations, the agent captures context, decisions, and knowledge — and picks it all back up next session without you repeating yourself. The result is a lightweight RAG you didn't have to build: structured, searchable, human-readable, and maintained by the agent as a side effect of working with you.

Context persists across sessions and projects — architectural decisions, ongoing priorities, research that doesn't belong to any one repo — all of it available in any new session without rebuilding from scratch.

## Setup

```bash
cd server
pnpm install
```

## MCP Configuration

The following commands are for Claude Code. Other MCP clients will have their own way to register a stdio server — point them at the same binary with `NOTES_DIR` set.

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
| `NOTES_DIR` | Absolute path to the vault root (e.g. `/path/to/your/vault`) |
| `DOSSIER_EXCLUDE_TAGS` | Comma-separated tags to exclude from `search_notes`, `list_notes`, and `list_todos` results by default (case-insensitive). Overrides the built-in default (`archived,historical`). Set to an empty string to disable default exclusion for this vault. Callers can still override per request via each tool's `exclude_tags` param (`[]` includes everything; a list replaces the default). Notes remain directly reachable via `get_note` regardless. |

## profile.md

`get_vault_context` reads `$NOTES_DIR/profile.md` — a free-form markdown file at the vault root that serves as the bootstrap document for the AI. Think of it as an `AGENTS.md` for your notes: when the MCP server is activated, reading this file first orients the agent to the vault — how it's organized, what it contains, and how to navigate it effectively.

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

| Tool | Purpose |
|---|---|
| `get_vault_context` | Read `$NOTES_DIR/profile.md` — vault bootstrap document; read this first |
| `list_notes` | List notes; optional `path` prefix filter (e.g. `projects/startup`) |
| `get_note` | Fetch a note by slug |
| `search_notes` | Full-text keyword search |
| `list_todos` | List notes with open `- [ ]` checkboxes; optional `path` prefix filter |
| `create_note` | Create a note; `path` sets slug; defaults to `inbox/<title-slug>` |
| `update_note` | Overwrite an existing note by slug (regenerates the whole body) |
| `append_to_section` | Append content under a named `## heading` without regenerating the note |
| `edit_note` | Exact-string find/replace in a note's body; match must be unique unless `replace_all` is set |
| `edit_frontmatter` | Surgical frontmatter-only edit — `set` scalar fields (e.g. `status`) + add/remove `tags`/`related` — without regenerating the body |
| `move_note` | Move/rename a note to a new slug; updates `related` references and inline `[[wiki-links]]` in other notes |
| `delete_note` | Delete a note by slug |

## Resources exposed to Claude

MCP resources are read-only and can be enumerated by clients at startup, making them useful for discoverability.

| Resource | Purpose |
|---|---|
| `vault://context` | Vault bootstrap document (`profile.md`). Read this first to orient to the vault. |
| `notes://index` | Index of all notes with titles, tags, dates, and links to each `note://` URI. |
| `note://{slug}` | Individual note content by slug (e.g. `note://projects/startup`). Discover slugs via `notes://index`. |

## Development

```bash
cd server
pnpm test         # run tests
pnpm build        # compile TypeScript to dist/
```
