/**
 * Coerces an unknown input to string[] | undefined.
 *
 * Handles the common case where LLM clients pass tags/related as:
 * - A JSON-encoded array string: '["tag1","tag2"]'
 * - A comma-separated string: 'tag1, tag2'
 * - A single bare string: 'tag1'
 * - An already-correct array: ['tag1', 'tag2']
 */
export function coerceStringArray(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed === '') return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // not JSON — fall through to comma split
    }
    return trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return undefined;
}
