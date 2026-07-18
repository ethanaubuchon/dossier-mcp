/**
 * Pure multi-vault config logic — parsing, validation, and registry assembly.
 *
 * Free of `import.meta`/fs/os machinery (like `excludeTags.ts`) so it's directly
 * unit-testable under ts-jest. All I/O is injected: raw YAML text is read by the
 * caller, path-existence is an injected predicate, and the home dir is passed in.
 * The thin impure orchestration (resolving which file to read, reading it, wiring
 * `fs`/`os`) lives in `loadVaultConfig.ts`.
 */

import { load } from 'js-yaml';
import { DEFAULT_EXCLUDE_TAGS } from './excludeTags.js';
import type { VaultConfig, VaultRegistry } from '../types.js';

/** Synthetic name for the single vault synthesized from `NOTES_DIR` (no config file). */
export const FALLBACK_VAULT_NAME = 'default';

/** Slug-safe lowercase: leading alphanumeric, then alphanumerics/hyphens. */
const VAULT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Guidance for an empty / comment-only config file (a common user mistake). */
const EMPTY_CONFIG_MSG =
  'Config file is empty — expected a YAML mapping with a `vaults:` key (remove the file to use the NOTES_DIR fallback).';

/** Named failure codes for fail-fast startup validation. */
export type VaultConfigErrorCode =
  | 'config_not_found'
  | 'parse_error'
  | 'malformed'
  | 'no_vaults'
  | 'default_required'
  | 'default_unknown'
  | 'default_is_shared'
  | 'bad_vault_name'
  | 'path_missing';

/** Startup config error — carries a machine-readable `code` alongside the message. */
export class VaultConfigError extends Error {
  code: VaultConfigErrorCode;
  constructor(code: VaultConfigErrorCode, message: string) {
    super(message);
    this.name = 'VaultConfigError';
    this.code = code;
  }
}

/** Expand a leading `~` (or `~/…`) against the supplied home directory. */
export function expandTilde(p: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return homeDir + p.slice(1);
  return p;
}

interface BuildInput {
  /** Raw YAML config text, or `undefined` to synthesize the NOTES_DIR fallback. */
  rawConfig?: string;
  /** `NOTES_DIR` env value (used only in the fallback path). */
  notesDirEnv?: string;
  /** Ultimate fallback vault path when neither config nor `NOTES_DIR` is present. */
  defaultNotesDir: string;
  /** Home dir for `~` expansion. */
  homeDir: string;
  /** Injected existence check (fs in production, a stub in tests). */
  pathExists: (p: string) => boolean;
}

/**
 * Build a validated {@link VaultRegistry} from already-read inputs.
 *
 * - `rawConfig` undefined → synthesize one vault named `default` from
 *   `notesDirEnv ?? defaultNotesDir` (zero-migration: existing `NOTES_DIR`-only
 *   deployments behave exactly as before).
 * - `rawConfig` present → parse the YAML schema, expand paths, apply defaults,
 *   resolve the default vault, and validate (throwing {@link VaultConfigError}).
 */
export function buildVaultRegistry(input: BuildInput): VaultRegistry {
  const { rawConfig, notesDirEnv, defaultNotesDir, homeDir, pathExists } = input;

  if (rawConfig === undefined) {
    const path = notesDirEnv && notesDirEnv.length > 0 ? notesDirEnv : defaultNotesDir;
    return {
      vaults: [{ name: FALLBACK_VAULT_NAME, path, contextFile: 'profile.md' }],
      defaultVault: FALLBACK_VAULT_NAME,
      defaultExcludeTags: [...DEFAULT_EXCLUDE_TAGS],
    };
  }

  let parsed: unknown;
  try {
    parsed = load(rawConfig);
  } catch (err) {
    const msg = (err as Error).message;
    // js-yaml 5.x throws "expected a document, but the input is empty" for
    // empty / comment-only files (3.x/4.x returned undefined) — surface the
    // clear empty-file guidance rather than a generic parse error.
    if (/input is empty/i.test(msg)) {
      throw new VaultConfigError('malformed', EMPTY_CONFIG_MSG);
    }
    throw new VaultConfigError('parse_error', `Config is not valid YAML: ${msg}`);
  }
  if (parsed === null || parsed === undefined) {
    throw new VaultConfigError('malformed', EMPTY_CONFIG_MSG);
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VaultConfigError('malformed', 'Config must be a YAML mapping with a `vaults:` key.');
  }

  const root = parsed as Record<string, unknown>;
  const vaultsRaw = root.vaults;
  if (vaultsRaw === null || vaultsRaw === undefined) {
    throw new VaultConfigError('no_vaults', 'Config must define at least one vault under `vaults:`.');
  }
  if (typeof vaultsRaw !== 'object' || Array.isArray(vaultsRaw)) {
    throw new VaultConfigError('malformed', '`vaults:` must be a mapping of name → vault definition.');
  }

  const vaults: VaultConfig[] = Object.entries(vaultsRaw as Record<string, unknown>).map(
    ([name, def]) => parseVault(name, def, homeDir),
  );

  if (vaults.length === 0) {
    throw new VaultConfigError('no_vaults', 'Config must define at least one vault under `vaults:`.');
  }

  // Default vault: explicit key, or the sole vault when there's exactly one.
  const defaultVaultRaw = root.default_vault;
  let defaultVault: string;
  if (defaultVaultRaw === undefined || defaultVaultRaw === null) {
    if (vaults.length > 1) {
      throw new VaultConfigError(
        'default_required',
        `\`default_vault\` is required when more than one vault is configured (found ${vaults.length}).`,
      );
    }
    defaultVault = vaults[0].name;
  } else {
    defaultVault = String(defaultVaultRaw);
    if (!vaults.some((v) => v.name === defaultVault)) {
      throw new VaultConfigError(
        'default_unknown',
        `\`default_vault: ${defaultVault}\` does not name any configured vault.`,
      );
    }
  }

  // Structural leak guard: the default (write-narrow target) must not be a shared vault.
  const defaultDef = vaults.find((v) => v.name === defaultVault)!;
  if (defaultDef.sync === 'git-publication') {
    throw new VaultConfigError(
      'default_is_shared',
      `Default vault \`${defaultVault}\` cannot be \`sync: git-publication\` — shared vaults cannot be the default write target.`,
    );
  }

  // Path existence — after tilde expansion. `pathExists` is a directory check in
  // production (see loadVaultConfig), so a path pointing at a file fails here
  // rather than later inside NoteStore.
  for (const v of vaults) {
    if (!pathExists(v.path)) {
      throw new VaultConfigError('path_missing', `Vault \`${v.name}\` path is not an existing directory: ${v.path}`);
    }
  }

  const excludeRaw = root.exclude_tags;
  const defaultExcludeTags =
    excludeRaw === undefined || excludeRaw === null
      ? [...DEFAULT_EXCLUDE_TAGS]
      : parseExcludeTags(excludeRaw);

  return { vaults, defaultVault, defaultExcludeTags };
}

/** Parse + validate a single `vaults:` entry into a {@link VaultConfig}. */
function parseVault(name: string, def: unknown, homeDir: string): VaultConfig {
  if (!VAULT_NAME_RE.test(name)) {
    throw new VaultConfigError(
      'bad_vault_name',
      `Vault name \`${name}\` is not slug-safe — use lowercase letters, digits, and hyphens (must start alphanumeric).`,
    );
  }
  if (def === null || def === undefined || typeof def !== 'object') {
    throw new VaultConfigError('malformed', `Vault \`${name}\` must be a mapping with a \`path:\`.`);
  }
  const entry = def as Record<string, unknown>;
  const rawPath = entry.path;
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new VaultConfigError('malformed', `Vault \`${name}\` is missing a \`path:\`.`);
  }
  const sync = entry.sync;
  if (sync !== undefined && sync !== 'git-publication') {
    throw new VaultConfigError('malformed', `Vault \`${name}\` has unknown \`sync: ${String(sync)}\` (expected \`git-publication\`).`);
  }
  const contextFile =
    typeof entry.context_file === 'string' && entry.context_file.length > 0
      ? entry.context_file
      : 'profile.md';

  return {
    name,
    path: expandTilde(rawPath, homeDir),
    ...(sync === 'git-publication' ? { sync } : {}),
    contextFile,
  };
}

/** Coerce the global `exclude_tags` YAML value into a string list. */
function parseExcludeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new VaultConfigError('malformed', '`exclude_tags` must be a list of strings.');
  }
  return raw.map((t) => String(t));
}

/** Source of the config file, or a signal to use the NOTES_DIR fallback. */
export type ConfigSource = { kind: 'file'; path: string } | { kind: 'fallback' };

interface ResolveSourceDeps {
  homeDir: string;
  fileExists: (p: string) => boolean;
  /** Path join injected so the pure resolver stays free of the `path` module's platform quirks in tests. */
  join: (...parts: string[]) => string;
}

/**
 * Resolve which config file to read (pure — I/O predicates injected):
 *   1. `DOSSIER_CONFIG` → that path (must exist, else `config_not_found`).
 *   2. `${XDG_CONFIG_HOME | ~/.config}/dossier/config.yaml` if it exists.
 *   3. otherwise → fallback (synthesize a vault from `NOTES_DIR`).
 */
export function resolveConfigSource(
  env: { DOSSIER_CONFIG?: string; XDG_CONFIG_HOME?: string },
  deps: ResolveSourceDeps,
): ConfigSource {
  const explicit = env.DOSSIER_CONFIG;
  if (explicit && explicit.length > 0) {
    if (!deps.fileExists(explicit)) {
      throw new VaultConfigError('config_not_found', `DOSSIER_CONFIG points at a file that does not exist: ${explicit}`);
    }
    return { kind: 'file', path: explicit };
  }
  const xdgBase = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
    ? env.XDG_CONFIG_HOME
    : deps.join(deps.homeDir, '.config');
  const xdgPath = deps.join(xdgBase, 'dossier', 'config.yaml');
  if (deps.fileExists(xdgPath)) {
    return { kind: 'file', path: xdgPath };
  }
  return { kind: 'fallback' };
}
