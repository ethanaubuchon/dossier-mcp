/**
 * MCP stdio entry point.
 *
 * Vaults come from a config file — `$DOSSIER_CONFIG` if set (it must exist),
 * else `${XDG_CONFIG_HOME:-~/.config}/dossier/config.yaml` — falling back to a
 * single vault at `NOTES_DIR` (or the repo's `notes/` dir if unset) when no
 * config file exists.
 *
 * Client registration examples: README.md, "MCP Configuration".
 * Startup and per-vault wiring: docs/ARCHITECTURE.md.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import { NoteStore } from './notes/NoteStore.js';
import { SearchIndex } from './search/SearchIndex.js';
import {
  createMcpServer,
  createStationRuntime,
  type LocalVaultRuntime,
  type VaultRuntime,
} from './mcp/server.js';
import { loadVaultConfig } from './config/loadVaultConfig.js';
import { resolveDefaultExcludeTags } from './config/excludeTags.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// `../package.json` is server/package.json from both src/ and dist/.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

async function main() {
  // Resolve the vault registry (DOSSIER_CONFIG → XDG config.yaml → NOTES_DIR fallback).
  // Every configured vault is wired into a live runtime (own store, index, and
  // watcher). A VaultConfigError here propagates out of main() to the fail-fast
  // .catch below.
  const registry = loadVaultConfig({
    env: process.env,
    defaultNotesDir: path.join(__dirname, '../../notes'),
  });
  // Env overrides config (mirrors NOTES_DIR). Unset env → config default;
  // explicit empty string → [] (per-vault opt-out).
  const defaultExcludeTags = resolveDefaultExcludeTags(process.env.DOSSIER_EXCLUDE_TAGS, registry.defaultExcludeTags);

  // Build one runtime per configured vault: a NoteStore (with its own chokidar
  // watcher) + a SearchIndex. Per-iteration `const` bindings
  // (vault/noteStore/searchIndex) mean each change/watcherError closure captures
  // its own store, so a watcher only ever rebuilds its own vault's index.
  const runtimes: VaultRuntime[] = [];
  const localRuntimes: LocalVaultRuntime[] = [];
  for (const vault of registry.vaults) {
    if (vault.type === 'station') {
      runtimes.push(createStationRuntime(vault));
      continue;
    }

    const noteStore = new NoteStore(vault.path);
    const searchIndex = new SearchIndex();

    await noteStore.initialize();
    const allNotes = await noteStore.listWithContent();
    searchIndex.buildIndexWithContent(allNotes);

    noteStore.on('change', async () => {
      console.error(`[dossier-mcp] Vault "${vault.name}" change detected — rebuilding its search index...`);
      try {
        const notes = await noteStore.listWithContent();
        searchIndex.buildIndexWithContent(notes);
        console.error(`[dossier-mcp] Search index for "${vault.name}" rebuilt (${notes.length} notes).`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const detail = code ? ` (${code})` : '';
        console.error(`[dossier-mcp] Failed to rebuild search index for "${vault.name}" after change${detail}:`, err);
      }
    });

    noteStore.on('watcherError', (err: unknown) => {
      console.error(`[dossier-mcp] File watcher error for vault "${vault.name}" — changes may not rebuild its index:`, err);
    });

    const runtime: LocalVaultRuntime = {
      type: 'local',
      name: vault.name,
      notesDir: vault.path,
      contextFile: vault.contextFile,
      noteStore,
      searchIndex,
    };
    runtimes.push(runtime);
    localRuntimes.push(runtime);
  }

  const server = createMcpServer(
    { vaults: runtimes, defaultVault: registry.defaultVault },
    { version, defaultExcludeTags },
  );
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Graceful shutdown — close every vault's watcher.
  const closeAll = async () => {
    await Promise.all(localRuntimes.map((r) => r.noteStore.close()));
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
