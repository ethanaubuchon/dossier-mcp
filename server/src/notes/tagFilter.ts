/**
 * Pure, case-insensitive tag-exclusion helpers used by the retrieval tools
 * (`list_notes`, `list_todos`) and the search index (`SearchIndex.search`,
 * which backs `search_notes`).
 *
 * Exclusion is tags-only and hard (matching items are dropped, not de-ranked).
 * An empty exclude set is always a no-op.
 */

/**
 * Build a reusable case-insensitive predicate that reports whether a note's
 * tags hit the exclude set. The lowercase Set is built once, so callers can
 * reuse the predicate across many notes (e.g. the search hot loop) without
 * rebuilding it per note. An empty exclude set yields a constant-false predicate.
 */
export function makeTagExcluder(excludeTags: string[]): (tags: string[]) => boolean {
  if (excludeTags.length === 0) return () => false;
  const excluded = new Set(excludeTags.map((t) => t.toLowerCase()));
  return (tags) => tags.some((t) => excluded.has(t.toLowerCase()));
}

/** True when any of `tags` (case-insensitively) is in `excludeTags`. */
export function hasExcludedTag(tags: string[], excludeTags: string[]): boolean {
  return makeTagExcluder(excludeTags)(tags);
}

/**
 * Drop items carrying any excluded tag. Generic over anything with
 * `frontmatter.tags` — fits `NoteListItem`, `SearchResult`, and `Note`.
 * Returns the input array unchanged when the exclude set is empty.
 */
export function filterByExcludedTags<T extends { frontmatter: { tags: string[] } }>(
  items: T[],
  excludeTags: string[],
): T[] {
  if (excludeTags.length === 0) return items;
  const isExcluded = makeTagExcluder(excludeTags);
  return items.filter((item) => !isExcluded(item.frontmatter.tags));
}
