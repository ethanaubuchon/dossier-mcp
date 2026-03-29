# move_note Tool Design

## Problem

Slugs are immutable — `update_note` cannot change a note's location. Reorganizing the vault requires deleting and recreating the note, which loses the original creation date and breaks any `related` links pointing to the old slug.

## Solution

Add a `move_note` MCP tool backed by a `NoteStore.move()` method that relocates a note to a new slug while preserving all metadata and automatically updating references across the vault.

## NoteStore.move()

```
move(oldSlug: string, newSlug: string): Promise<{ note: Note; updatedRefs: string[] }>
```

**Steps:**
1. Read the note at `oldSlug` via `get()`. If not found, throw.
2. Create the target directory (`path.dirname(newPath)`) if needed.
3. Write the file to the new path, preserving all frontmatter (title, date, tags, related) and body content exactly as-is.
4. Delete the old file via `fs.unlink()`.
5. Prune empty parents on the old path via the existing `pruneEmptyParents()`.
6. Scan all notes (`listWithContent()`) for `related` fields containing `oldSlug`. For each match, replace `oldSlug` with `newSlug` in the `related` array and write the updated note back.
7. Return the note at its new slug and the list of slugs whose `related` fields were updated.

**The move is not atomic.** If step 4 fails after step 3, the note exists at both paths. If step 6 fails partway through, some references are updated and some aren't. This is acceptable — the vault is not a database, and partial state is recoverable by the agent. The alternative (transactional rollback) adds significant complexity for a scenario that is unlikely and non-catastrophic.

**Reference updating uses `related` fields only.** Inline `[[slug]]` wiki-links in note body content are not updated — they are free-form text and updating them reliably would require content parsing. The `related` frontmatter field is structured data and safe to update programmatically.

## MCP Tool: move_note

**Registration:**
```
server.tool('move_note', description, { slug, new_slug, force? }, handler)
```

**Parameters:**
- `slug` (string, required): The current slug of the note to move.
- `new_slug` (string, required): The target slug.
- `force` (boolean, optional, default false): If true, overwrite an existing note at the target slug. If false, return an error when the target exists.

**Handler logic:**
1. Validate both slugs (reuse `isValidSlug`).
2. If not `force`, check if a note exists at `new_slug`. If so, return `isError`: `"Note already exists at '<new_slug>' — pass force: true to overwrite, or choose a different slug."`
3. If `force` and a note exists at `new_slug`, delete it first via `noteStore.delete()`.
4. Call `noteStore.move(slug, new_slug)`.
5. Rebuild the search index.
6. Return a success message: `Moved note from "<slug>" to "<new_slug>". Updated references in N notes: [list of slugs].` (If no references were updated, omit that part.)

**Error handling:**
- Both slug params validated before any I/O.
- All NoteStore calls wrapped in try-catch, returning `isError` responses with real error messages.
- Follows the same patterns established in PR #36.

**Tool description** (shown to agents):
```
Move a note to a new location in the vault. Preserves all metadata (title, date, tags, related)
and automatically updates related fields in other notes that reference the old slug. Use force
to overwrite an existing note at the target location.
```

## Error Cases

| Scenario | Behavior |
|----------|----------|
| Source not found | `isError`: "Note '<slug>' not found." |
| Target exists, force=false | `isError`: "Note already exists at '<new_slug>' — pass force: true to overwrite, or choose a different slug." |
| Target exists, force=true | Delete target, then move. |
| Invalid slug (either param) | `isError`: slug validation error (existing pattern). |
| Source = target | `isError`: "Source and target slugs are the same." |
| Filesystem error (EACCES, etc.) | `isError`: "Failed to move note '<slug>': <real error message>" |

## Testing

**NoteStore.move() tests:**
- Basic move: note appears at new slug, gone from old slug, frontmatter preserved
- Empty parent cleanup after move (reuses pruneEmptyParents)
- Reference updating: other notes' `related` fields are rewritten
- Reference updating only touches notes that reference the old slug
- Move to nested path creates intermediate directories
- Move when source doesn't exist throws
- Move preserves original creation date

**MCP handler tests:**
- force=false rejects when target exists
- force=true overwrites target
- Same-slug rejection
- Success message includes reference update count
