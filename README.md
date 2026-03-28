# library

Personal knowledge management MCP server. Reads and writes notes in an Obsidian vault, exposing them to Claude Code via the Model Context Protocol.

## Setup

```bash
cd server
npm install
```

## MCP Configuration

The server runs as a stdio process spawned by Claude Code. Register it with:

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
