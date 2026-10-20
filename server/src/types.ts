export interface NoteFrontmatter {
  title: string;
  date: string;
  tags: string[];
  related: string[];
  [key: string]: unknown;
}

export interface Note {
  slug: string;
  frontmatter: NoteFrontmatter;
  content: string;
  raw: string;
}

export interface NoteListItem {
  slug: string;
  frontmatter: NoteFrontmatter;
}

export interface SearchResult {
  slug: string;
  frontmatter: NoteFrontmatter;
  score: number;
  excerpt: string;
}

/**
 * A vault read from a local directory. Each one gets its own runtime
 * (NoteStore, SearchIndex, file watcher); see docs/ARCHITECTURE.md.
 */
export interface LocalVaultConfig {
  type: 'local';
  /** Slug-safe lowercase name; the value tools accept as their `vault` param. */
  name: string;
  /** Absolute path to the vault root (tilde already expanded). */
  path: string;
  /** Sync policy. Absent = personal vault. `git-publication` marks a shared vault. */
  sync?: 'git-publication';
  /** Bootstrap doc filename, relative to the vault root. Defaults to `profile.md`. */
  contextFile: string;
}

/** A dossier-station instance, reached over its HTTP API. Always a shared vault. */
export interface StationVaultConfig {
  type: 'station';
  name: string;
  /** Station root URL (http or https). */
  url: string;
  /** Name of the env var holding the API key; the key itself never appears in config. */
  apiKeyEnv: string;
  /** The key read from `apiKeyEnv` at startup. */
  apiKey: string;
  /** Per-request timeout; a request that exceeds it counts as unreachable. */
  timeoutMs: number;
  /** Bootstrap doc filename; read as the note slug without `.md`. Defaults to `profile.md`. */
  contextFile: string;
}

/** A single named vault in the multi-vault registry. */
export type VaultConfig = LocalVaultConfig | StationVaultConfig;

/**
 * The resolved multi-vault configuration: the set of named vaults, which one
 * is the default (write target / single-vault runtime anchor), and the global
 * default-exclude tag set (env `DOSSIER_EXCLUDE_TAGS` still overrides downstream).
 */
export interface VaultRegistry {
  vaults: VaultConfig[];
  /** Name of the default vault; always resolvable (validated at build time). */
  defaultVault: string;
  defaultExcludeTags: string[];
}
