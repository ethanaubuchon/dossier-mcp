/**
 * Default-exclude tag configuration for retrieval tools (`search_notes`,
 * `list_notes`, `list_todos`). Kept in its own module — free of the
 * `import.meta`/fs machinery in config.ts — so it's directly unit-testable.
 */

/** Built-in default set of tags excluded from retrieval results. */
export const DEFAULT_EXCLUDE_TAGS = ['archived', 'historical'];

/**
 * Parse the `DOSSIER_EXCLUDE_TAGS` env var into a tag list.
 * - unset (`undefined`) → `undefined`, so the caller falls back to the config default
 * - explicit empty string (`""`) → `[]`, a deliberate per-vault opt-out (exclude nothing)
 * - otherwise comma-split, trimmed, blanks dropped
 */
export function parseExcludeTagsEnv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the effective default-exclude set: the `DOSSIER_EXCLUDE_TAGS` env var
 * wins over the config default (mirroring how `NOTES_DIR` overrides config).
 * Unset env → config default; explicit `""` → `[]` (opt-out, beats the config
 * default) — `??` is correct here because `parseExcludeTagsEnv` returns `[]`
 * (non-nullish) for `""` and only `undefined` when the env var is unset.
 */
export function resolveDefaultExcludeTags(envRaw: string | undefined, configDefault: string[]): string[] {
  return parseExcludeTagsEnv(envRaw) ?? configDefault;
}
