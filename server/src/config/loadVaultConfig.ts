/**
 * Impure orchestration for the multi-vault config resolution chain.
 *
 * Thin by design: resolve which file to read (env / XDG / none), read it, and
 * delegate all parsing + validation to the pure `vaultConfig.ts`. Kept separate
 * from that module so the logic-heavy parts stay ts-jest-testable without fs/os.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildVaultRegistry, resolveConfigSource } from './vaultConfig.js';
import type { VaultRegistry } from '../types.js';

interface LoadOptions {
  /** Process env (injectable for tests). Reads `DOSSIER_CONFIG`, `XDG_CONFIG_HOME`, `NOTES_DIR`. */
  env?: NodeJS.ProcessEnv;
  /** Ultimate fallback vault path when neither a config file nor `NOTES_DIR` is present. */
  defaultNotesDir: string;
}

/**
 * Resolve the config source and build the vault registry. Throws
 * `VaultConfigError` (from the pure layer) on any invalid config — the caller
 * lets it propagate for fail-fast startup.
 */
export function loadVaultConfig(options: LoadOptions): VaultRegistry {
  const env = options.env ?? process.env;
  const homeDir = os.homedir();

  const source = resolveConfigSource(env, {
    homeDir,
    fileExists: fs.existsSync,
    join: path.join,
  });

  const rawConfig = source.kind === 'file' ? fs.readFileSync(source.path, 'utf-8') : undefined;

  return buildVaultRegistry({
    rawConfig,
    notesDirEnv: env.NOTES_DIR,
    defaultNotesDir: options.defaultNotesDir,
    homeDir,
    pathExists: isDirectory,
  });
}

/** A vault path must be an existing directory — a file (or missing path) fails validation. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
