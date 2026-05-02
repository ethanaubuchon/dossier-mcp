import matter from 'gray-matter';

type ResolvedParams = { ok: true; title: string; content: string; tags?: string[]; related?: string[] };
type ResolveFailed = { ok: false; error: string };

/**
 * Resolves update_note parameters, supporting frontmatter-embedded content.
 *
 * When an agent receives a note via get_note (which returns raw markdown including
 * frontmatter) and passes it back to update_note, the frontmatter is embedded in the
 * content string rather than as separate params. This function handles that round-trip:
 * it extracts title/tags/related from frontmatter in content and strips the frontmatter
 * from the body whenever frontmatter is present. Explicit params always take precedence
 * over frontmatter values.
 */
export function resolveFrontmatterParams(params: {
  title: string | undefined;
  content: string;
  tags: string[] | undefined;
  related: string[] | undefined;
}): ResolvedParams | ResolveFailed {
  const { tags, related } = params;

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(params.content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Failed to parse note content: ${msg}` };
  }

  const hasFrontmatter = Object.keys(parsed.data).length > 0;

  const rawTitle = params.title ?? (hasFrontmatter ? parsed.data.title : undefined);
  const title = typeof rawTitle === 'string' ? rawTitle : undefined;
  if (!title) {
    if (hasFrontmatter) {
      return { ok: false, error: 'title is required — frontmatter was detected in content but no title field was found. Pass title as a separate param or add a title field to the frontmatter.' };
    }
    return { ok: false, error: 'title is required — pass it as a separate param or include it in frontmatter' };
  }

  const content = hasFrontmatter ? parsed.content.replace(/^\n/, '') : params.content;
  const resolvedTags = tags ?? (hasFrontmatter ? coerceStringArray(parsed.data.tags) : undefined);
  const resolvedRelated = related ?? (hasFrontmatter ? coerceStringArray(parsed.data.related) : undefined);

  return { ok: true, title, content, tags: resolvedTags, related: resolvedRelated };
}

/**
 * Coerces an unknown input to string[] | undefined.
 *
 * Handles the common case where LLM clients pass tags/related as:
 * - A JSON-encoded array string: '["tag1","tag2"]'
 * - A comma-separated string: 'tag1, tag2'
 * - A single bare string: 'tag1'
 * - An already-correct array: ['tag1', 'tag2']
 * - A JSON-encoded non-array (e.g. '42', '{"a":1}'): treated as a plain string, comma-split
 * - An empty array (`[]` or `'[]'`): coerced to `undefined` so downstream callers
 *   treat it as "preserve existing" rather than "clear all". This guards the
 *   round-trip pattern (get_note → modify → update_note) where LLMs often emit
 *   `tags: []` to mean "I didn't change tags."
 */
export function coerceStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  // Empty arrays are treated as "preserve existing" rather than "clear all".
  // This protects the round-trip pattern (get_note → modify → update_note) where
  // LLM clients commonly emit `tags: []` to mean "I didn't change tags." If
  // explicit clearing is ever needed, add an explicit sentinel (e.g. a dedicated
  // flag) rather than overloading the empty-array meaning.
  if (Array.isArray(val)) return val.length === 0 ? undefined : val.map(String);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.length === 0 ? undefined : parsed.map(String);
    } catch {
      // not JSON — fall through to comma split
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}
