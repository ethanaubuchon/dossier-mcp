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
import { createMcpServer, type VaultRuntime } from './mcp/server.js';
import { loadVaultConfig } from './config/loadVaultConfig.js';
import { resolveDefaultExcludeTags } from './config/excludeTags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Resolve the vault registry (DOSSIER_CONFIG → XDG config.yaml → NOTES_DIR fallback).
  // #89: every configured vault is wired into a live runtime (own store, index,
  // and watcher). A VaultConfigError here propagates out of main() to the
  // fail-fast .catch below.
  const registry = loadVaultConfig({
    env: process.env,
    defaultNotesDir: path.join(__dirname, '../../notes'),
  });
  // Env overrides config (mirrors NOTES_DIR). Unset env → config default;
  // explicit empty string → [] (per-vault opt-out).
  const defaultExcludeTags = resolveDefaultExcludeTags(process.env.DOSSIER_EXCLUDE_TAGS, registry.defaultExcludeTags);

  // Build one runtime per configured vault: a NoteStore (with its own chokidar
  // watcher) + a SearchIndex. Each vault's watcher rebuilds only that vault's
  // index (scoped rebuild).
  //
  // Per-iteration `const` bindings (vault/noteStore/searchIndex) mean each
  // change/watcherError closure captures its own store — no loop-alias bug.
  // This wiring (AC #4: one watcher per vault) is exercised by the stdio
  // end-to-end path, not jest — the routing tests skip initialize() to avoid
  // per-test chokidar poll-timer leaks (see multiVault.test.ts makeRuntime).
  const runtimes: VaultRuntime[] = [];
  for (const vault of registry.vaults) {
    const noteStore = new NoteStore(vault.path);
    const searchIndex = new SearchIndex();

    await noteStore.initialize();
    const allNotes = await noteStore.listWithContent();
    searchIndex.buildIndexWithContent(allNotes);

    noteStore.on('change', async () => {
      console.error(`[library] Vault "${vault.name}" change detected — rebuilding its search index...`);
      try {
        const notes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(notes);
        console.error(`[library] Search index for "${vault.name}" rebuilt (${notes.length} notes).`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const detail = code ? ` (${code})` : '';
        console.error(`[library] Failed to rebuild search index for "${vault.name}" after change${detail}:`, err);
      }
    });

    noteStore.on('watcherError', (err: unknown) => {
      console.error(`[library] File watcher error for vault "${vault.name}" — changes may not rebuild its index:`, err);
    });

    runtimes.push({
      name: vault.name,
      notesDir: vault.path,
      contextFile: vault.contextFile,
      noteStore,
      searchIndex,
    });
  }

  const server = createMcpServer(
    { vaults: runtimes, defaultVault: registry.defaultVault },
    { defaultExcludeTags },
  );
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Graceful shutdown — close every vault's watcher.
  const closeAll = async () => {
    await Promise.all(runtimes.map((r) => r.noteStore.close()));
  };
  process.on('SIGINT', async () => {
    await closeAll();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await closeAll();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('MCP server error:', err);
  process.exit(1);
});
