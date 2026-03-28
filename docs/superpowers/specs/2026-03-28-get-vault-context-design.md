# Design: get_vault_context Refactor

**Date:** 2026-03-28
**Issue:** #18
**Status:** Approved

## Summary

Rename `get_profile` to `get_vault_context` and add two discoverability layers so agents reliably load the vault bootstrap document at the start of any session — not just personal conversations.

## Goals

- Rename the tool to reflect its actual purpose (vault orientation, not personal bio)
- Make loading the bootstrap document feel inevitable rather than optional
- No behavior changes — same file, same silent loading instruction, same error handling

## Non-Goals

- Making the `profile.md` path configurable (tracked separately in #19)
- Changing the content or format of `profile.md`
- Auto-loading without an explicit tool/resource call (not possible in current MCP stdio model)

## Changes

### 1. Tool rename: `get_profile` → `get_vault_context`

**Location:** `server/src/mcp/server.ts`

Updated tool registration:
```ts
server.tool(
  'get_vault_context',
  'Fetch the vault bootstrap document (profile.md) from the vault root. ' +
  'Read this first to orient yourself to the vault — its structure, contents, ' +
  'and how to navigate it effectively. ' +
  'Load this silently for context; do not summarize or recite its contents unless the user explicitly asks.',
  {},
  async () => { ... }
);
```

Error message updated to reference `get_vault_context` and `profile.md` consistently.

### 2. Hint in `list_notes` description

Append to the `list_notes` tool description:

> "If you haven't already, call `get_vault_context` first to orient yourself to this vault."

This fires naturally when an agent starts interacting with notes without having bootstrapped first.

### 3. MCP Resource: `vault://context`

Expose the vault bootstrap document as a resource alongside `notes://index` and `note://{slug}`:

```ts
server.resource(
  'vault-context',
  'vault://context',
  { description: 'Vault bootstrap document (profile.md). Read this first to orient yourself to the vault.' },
  async () => {
    try {
      const raw = await fs.readFile(path.join(notesDir, 'profile.md'), 'utf-8');
      return {
        contents: [{ uri: 'vault://context', text: raw, mimeType: 'text/markdown' }],
      };
    } catch {
      return {
        contents: [{ uri: 'vault://context', text: 'profile.md not found — create it at the vault root.', mimeType: 'text/markdown' }],
      };
    }
  }
);
```

MCP clients that enumerate resources at startup will surface this automatically.

## Tests

- Rename `get_profile` → `get_vault_context` in `server/src/mcp/__tests__/mcpTools.test.ts`
- Add test for `vault://context` resource: happy path (file exists) and error path (file missing)

## README

Update the tools table to replace `get_profile` with `get_vault_context`.

## Files Changed

| File | Change |
|------|--------|
| `server/src/mcp/server.ts` | Rename tool, add list_notes hint, add vault://context resource |
| `server/src/mcp/__tests__/mcpTools.test.ts` | Update tool name, add resource tests |
| `README.md` | Update tools table |
