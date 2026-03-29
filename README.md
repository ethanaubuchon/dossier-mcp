# library-mcp

Persistent, agent-managed context for Claude Code. Gives your AI agent structured memory it maintains itself — stored as Markdown in an Obsidian-compatible vault via the [Model Context Protocol](https://modelcontextprotocol.io).

Built and tested with [Claude Code](https://claude.ai/code). Any MCP-compatible coding agent should work — the server uses standard stdio transport. Registration commands below are Claude Code-specific; other clients will have their own configuration method.

## Concept

AI agents forget everything between sessions. Claude memory is project scoped. LibraryMCP gives your gives your agent a structured memory for context that needs to come with you across these boundries and a home for context that might not fit into one specific project.  The MCP links and indexes notes to only pull in context you ask about as needed and stores them in a single vault compatible with Obsidian, allowing you to easily review and edit the contents at any time.

## Philosophy

This tool is designed for **agent-as-author** use: Claude writes and maintains notes in your vault, building up a persistent cross-session and cross-project memory that you can optionally inspect in Obsidian or any Markdown viewer.

This is the inverse of tools like Obsidian MCP, where the agent reads notes *you* wrote. Here, the agent is the primary author. You direct conversations, the agent captures context, decisions, and knowledge — and picks it all back up next session without you repeating yourself. The result is a lightweight RAG you didn't have to build: structured, searchable, human-readable, and maintained by the agent as a side effect of working with you.

Architectural decisions, ongoing priorities, and working context that would otherwise be rebuilt from scratch, can be loaded into any new session by asking your agent to search for notes about them.  Context can be recorded for other projects without needing to break from your current session by simply writing or updating a note.  Sometimes research and exploration with an agent can produce context that doesn't fit in a project.  This can be the home for that context.

## Setup

```bash
cd server
npm install
```

## MCP Configuration

The following commands are for Claude Code. Other MCP clients will have their own way to register a stdio server — point them at the same binary with `NOTES_DIR` set.

Register with Claude Code:

```bash
claude mcp add -s user library -e NOTES_DIR=/path/to/your/vault -- <command>
```

### Dev mode (no build step)

Uses `tsx` to run TypeScript directly. Slower startup, no build required.

```bash
claude mcp add -s user library \
  -e NOTES_DIR=/path/to/your/vault \
  -- npx tsx /path/to/library/server/src/mcp-entry.ts
```

### Production mode

Build first, then run the compiled output with plain `node`.

```bash
cd server && npm run build
```

```bash
claude mcp add -s user library \
  -e NOTES_DIR=/path/to/your/vault \
  -- node /path/to/library/server/dist/mcp-entry.js
```

### Updating an existing registration

`claude mcp add` will error if `library` is already registered. Remove it first:

```bash
claude mcp remove library
```

Then re-add with the command above.

## Environment variables

| Variable | Description |
|---|---|
| `NOTES_DIR` | Absolute path to the vault root (e.g. `/path/to/your/vault`) |

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
| `create_note` | Create a note; `path` sets slug; defaults to `inbox/<title-slug>` |
| `update_note` | Update an existing note by slug |
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
npm test          # run tests
npm run build     # compile TypeScript to dist/
```
