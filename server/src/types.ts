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
 * A single named vault in the multi-vault registry. Every configured vault
 * gets its own runtime (NoteStore, SearchIndex, file watcher); see
 * docs/ARCHITECTURE.md.
 */
export interface VaultConfig {
  /** Slug-safe lowercase name; the value tools accept as their `vault` param. */
  name: string;
  /** Absolute path to the vault root (tilde already expanded). */
  path: string;
  /** Sync policy. Absent = local vault. `git-publication` marks a shared vault, which cannot be the default vault. */
  sync?: 'git-publication';
  /** Bootstrap doc filename, relative to the vault root. Defaults to `profile.md`. */
  contextFile: string;
}

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
