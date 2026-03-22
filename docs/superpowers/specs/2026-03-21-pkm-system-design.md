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
- GitHub private repo remains as a backup/history layer; home lab pushes periodically via cron

### MCP Server (this project)

Runs as a **stdio process** on each machine, spawned by Claude Code on demand. Points at `~/vault` locally — no network dependency, works offline.

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

## This Codebase: What Changes

### Remove
- `client/` — entire React/Vite frontend (not used in workflow)
- `server/src/routes/` — REST API routes (notes, search, settings)
- `compose.yml` client service
- HTTP server setup in `server/src/index.ts`

### Keep
- `server/src/notes/NoteStore.ts` — markdown file read/write
- `server/src/notes/noteBlockParser.ts` — parses `<note>` blocks from AI responses
- `server/src/search/SearchIndex.ts` — keyword search
- `server/src/mcp/server.ts` — MCP tools
- `server/src/mcp-entry.ts` — stdio entry point
- All tests

### Add
- `get_profile` MCP tool — fetches `profile.md` directly by path, so Claude can load personal context with a single targeted call

### MCP Tools (final set)

| Tool | Purpose |
|---|---|
| `get_profile` | Fetch `profile.md` for personal context |
| `list_notes` | List all notes with metadata |
| `get_note` | Fetch a note by slug |
| `search_notes` | Keyword search across vault |
| `create_note` | Create a new note |
| `update_note` | Update an existing note |
| `delete_note` | Delete a note |

## Vault Structure Conventions

- Each project gets a folder under `projects/` with an `index.md` as the entry point
- Notes use YAML frontmatter: `title`, `date`, `tags`, `related`
- Cross-note links use `[[slug]]` syntax (Obsidian-compatible, also stored in `related` frontmatter)
- `profile.md` lives at vault root and is never project-specific

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
