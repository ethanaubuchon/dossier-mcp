/**
 * MCP stdio entry point — for Claude Desktop and other MCP clients.
 *
 * Claude Desktop config (~/.claude/claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "library": {
 *       "command": "node",
 *       "args": ["/path/to/library/server/dist/mcp-entry.js"],
 *       "env": { "NOTES_DIR": "/path/to/library/notes" }
 *     }
 *   }
 * }
 *
 * Or for dev (tsx):
 * {
 *   "mcpServers": {
 *     "library": {
 *       "command": "npx",
 *       "args": ["tsx", "/path/to/library/server/src/mcp-entry.ts"],
 *       "env": { "NOTES_DIR": "/path/to/library/notes" }
 *     }
 *   }
 * }
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { NoteStore } from './notes/NoteStore.js';
import { SearchIndex } from './search/SearchIndex.js';
import { createMcpServer } from './mcp/server.js';
import { loadConfig } from './config/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = await loadConfig();
  const notesDir = process.env.NOTES_DIR || config.notesDir || path.join(__dirname, '../../notes');

  const noteStore = new NoteStore(notesDir);
  const searchIndex = new SearchIndex();

  await noteStore.initialize();

  const allNotes = await noteStore.listWithContent();
  searchIndex.buildIndexWithContent(allNotes);

  noteStore.on('change', async () => {
    try {
      const notes = await noteStore.listWithContent();
      searchIndex.buildIndexWithContent(notes);
    } catch (err) {
      console.error('Failed to rebuild search index after vault change:', err);
    }
  });

  const server = createMcpServer(noteStore, searchIndex, notesDir);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    await noteStore.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await noteStore.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
