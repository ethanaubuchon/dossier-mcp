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
import { loadVaultConfig } from './config/loadVaultConfig.js';
import { resolveDefaultExcludeTags } from './config/excludeTags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Resolve the vault registry (DOSSIER_CONFIG → XDG config.yaml → NOTES_DIR fallback).
  // v1: only the default vault is wired into the single-vault runtime; #89/#90
  // consume the rest of the registry. A VaultConfigError here propagates out of
  // main() to the fail-fast .catch below.
  const registry = loadVaultConfig({
    env: process.env,
    defaultNotesDir: path.join(__dirname, '../../notes'),
  });
  const notesDir = registry.vaults.find((v) => v.name === registry.defaultVault)!.path;
  // Env overrides config (mirrors NOTES_DIR). Unset env → config default;
  // explicit empty string → [] (per-vault opt-out).
  const defaultExcludeTags = resolveDefaultExcludeTags(process.env.DOSSIER_EXCLUDE_TAGS, registry.defaultExcludeTags);

  const noteStore = new NoteStore(notesDir);
  const searchIndex = new SearchIndex();

  await noteStore.initialize();

  const allNotes = await noteStore.listWithContent();
  searchIndex.buildIndexWithContent(allNotes);

  noteStore.on('change', async () => {
    console.error('[library] Vault change detected — rebuilding search index...');
    try {
      const notes = await noteStore.listWithContent();
      searchIndex.buildIndexWithContent(notes);
      console.error(`[library] Search index rebuilt (${notes.length} notes).`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const detail = code ? ` (${code})` : '';
      console.error(`[library] Failed to rebuild search index after vault change${detail}:`, err);
    }
  });

  noteStore.on('watcherError', (err: unknown) => {
    console.error('[library] File watcher error — vault changes may not rebuild the index:', err);
  });

  const server = createMcpServer(noteStore, searchIndex, { notesDir, defaultExcludeTags });
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
