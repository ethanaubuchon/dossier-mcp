# library

Personal knowledge management MCP server. Reads and writes notes in an Obsidian vault via the [Model Context Protocol](https://modelcontextprotocol.io).

Built and tested with [Claude Code](https://claude.ai/code). Any MCP-compatible coding agent should work — the server uses standard stdio transport. Registration commands below are Claude Code-specific; other clients will have their own configuration method.

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

`get_profile` reads `$NOTES_DIR/profile.md` — a free-form markdown file at the vault root that gives the AI persistent context about you. Think of it as a briefing document the agent reads at the start of a session to understand who you are, what you're working on, and how you prefer to collaborate.

The file uses standard frontmatter followed by markdown:

```markdown
---
title: Your Name — Profile
date: '2026-01-01'
tags:
  - profile
  - personal
---
# Your Name

Brief bio, location, current role.

## Work

What you do, current projects, priorities.

## Preferences

How you like to work, communication style, tools.

## Current Focus

Active projects or goals the AI should be aware of.
```

The content is entirely up to you — write what would be useful for an AI collaborator to know. If `profile.md` doesn't exist, `get_profile` returns a clear error message rather than failing silently.

## Tools exposed to Claude

| Tool | Purpose |
|---|---|
| `get_profile` | Read `$NOTES_DIR/profile.md` for personal context |
| `list_notes` | List notes; optional `path` prefix filter (e.g. `projects/startup`) |
| `get_note` | Fetch a note by slug |
| `search_notes` | Full-text keyword search |
| `create_note` | Create a note; `path` sets slug; defaults to `inbox/<title-slug>` |
| `update_note` | Update an existing note by slug |
| `delete_note` | Delete a note by slug |

## Development

```bash
cd server
npm test          # run tests
npm run build     # compile TypeScript to dist/
```
