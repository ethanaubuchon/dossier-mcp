# get_vault_context Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename `get_profile` to `get_vault_context` and add two discoverability layers (list_notes hint + `vault://context` MCP resource) so agents reliably load the vault bootstrap document at the start of any session.

**Architecture:** Single file change to `server/src/mcp/server.ts` — rename the tool registration, append a hint to the `list_notes` description, and add a new resource. Tests live in `server/src/mcp/__tests__/mcpTools.test.ts`. README tools table updated last.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Jest/ts-jest

---

## Files

| File | Change |
|------|--------|
| `server/src/mcp/server.ts` | Rename tool, add list_notes hint, add vault://context resource |
| `server/src/mcp/__tests__/mcpTools.test.ts` | Rename describe block, add resource tests |
| `README.md` | Update tools table |

---

### Task 1: Rename get_profile → get_vault_context

**Files:**
- Modify: `server/src/mcp/server.ts:28-43`
- Modify: `server/src/mcp/__tests__/mcpTools.test.ts:254-277`

- [ ] **Step 1: Update the tool registration in server.ts**

In `server/src/mcp/server.ts`, replace the `server.tool('get_profile', ...)` block (lines 28–43) with:

```ts
server.tool(
  'get_vault_context',
  'Fetch the vault bootstrap document (profile.md) from the vault root. ' +
  'Read this first to orient yourself to the vault — its structure, contents, ' +
  'and how to navigate it effectively. ' +
  'Load this silently for context; do not summarize or recite its contents unless the user explicitly asks.',
  {},
  async () => {
    try {
      const raw = await fs.readFile(path.join(notesDir, 'profile.md'), 'utf-8');
      return { content: [{ type: 'text', text: raw }] };
    } catch {
      return {
        isError: true,
        content: [{ type: 'text', text: 'profile.md not found — create it at the vault root to use this tool.' }],
      };
    }
  }
);
```

- [ ] **Step 2: Rename the test describe block**

In `server/src/mcp/__tests__/mcpTools.test.ts`, change line 254 from:

```ts
describe('get_profile', () => {
```

to:

```ts
describe('get_vault_context', () => {
```

The test bodies are unchanged — they test the underlying file operations directly and are not coupled to the tool name.

- [ ] **Step 3: Run tests to confirm they pass**

```bash
cd server && npm test
```

Expected: all 65 tests pass, no failures.

- [ ] **Step 4: Commit**

```bash
git add server/src/mcp/server.ts server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "feat: rename get_profile to get_vault_context"
```

---

### Task 2: Add vault://context resource (TDD)

**Files:**
- Modify: `server/src/mcp/__tests__/mcpTools.test.ts` — add new describe block after get_vault_context tests
- Modify: `server/src/mcp/server.ts` — add resource after existing resources section

- [ ] **Step 1: Write failing tests for vault://context resource**

Add the following describe block at the end of the outer `describe('MCP tool logic ...')` block in `server/src/mcp/__tests__/mcpTools.test.ts`, just before the closing `});`:

```ts
describe('vault://context resource', () => {
  test('reads profile.md when it exists', async () => {
    await fs.writeFile(
      path.join(dir, 'profile.md'),
      '# Vault\nHow to use this vault.'
    );
    const raw = await fs.readFile(path.join(dir, 'profile.md'), 'utf-8');
    expect(raw).toContain('Vault');
    expect(raw).toContain('How to use this vault.');
  });

  test('returns error text when profile.md is missing', async () => {
    const profilePath = path.join(dir, 'profile.md');
    let readError: Error | null = null;
    try {
      await fs.readFile(profilePath, 'utf-8');
    } catch (e) {
      readError = e as Error;
    }
    expect(readError).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to confirm they pass**

```bash
cd server && npm test
```

Expected: all tests pass (these tests exercise the same fs operations the resource will use — they are green by design to establish the baseline).

- [ ] **Step 3: Add vault://context resource to server.ts**

In `server/src/mcp/server.ts`, add the following after the `notes-index` resource and before the `noteTemplate` declaration (around line 207):

```ts
server.resource(
  'vault-context',
  'vault://context',
  { description: 'Vault bootstrap document (profile.md). Read this first to orient yourself to the vault — its structure, contents, and how to navigate it.' },
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

- [ ] **Step 4: Run tests to confirm they still pass**

```bash
cd server && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/mcp/server.ts server/src/mcp/__tests__/mcpTools.test.ts
git commit -m "feat: add vault://context MCP resource for vault bootstrap document"
```

---

### Task 3: Add discoverability hint to list_notes

**Files:**
- Modify: `server/src/mcp/server.ts:45-59`

- [ ] **Step 1: Update list_notes tool description**

In `server/src/mcp/server.ts`, change the `list_notes` description (line 47) from:

```ts
'List notes in the knowledge base, sorted by date (newest first). Optionally filter by slug prefix to scope results to a folder.',
```

to:

```ts
'List notes in the knowledge base, sorted by date (newest first). Optionally filter by slug prefix to scope results to a folder. If you haven\'t already, call get_vault_context first to orient yourself to this vault.',
```

- [ ] **Step 2: Run tests to confirm nothing broke**

```bash
cd server && npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/mcp/server.ts
git commit -m "feat: hint at get_vault_context in list_notes description"
```

---

### Task 4: Update README tools table

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the tools table**

In `README.md`, find the tools table and replace the `get_profile` row:

```markdown
| `get_profile` | Read `$NOTES_DIR/profile.md` for personal context |
```

with:

```markdown
| `get_vault_context` | Read `$NOTES_DIR/profile.md` — vault bootstrap document; read this first |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update tools table to reflect get_vault_context rename"
```

---

### Task 5: Open PR

- [ ] **Step 1: Push branch and open PR**

```bash
git push -u origin feat/get-vault-context
gh pr create --title "feat: rename get_profile to get_vault_context with discoverability improvements" --body "$(cat <<'EOF'
## Summary

- Renames \`get_profile\` → \`get_vault_context\` to reflect its role as a vault bootstrap document rather than a personal bio tool
- Adds \`vault://context\` MCP resource so clients that enumerate resources at startup surface it automatically
- Adds a hint in the \`list_notes\` description nudging agents to call \`get_vault_context\` first
- Updates README tools table

Closes #18
EOF
)"
```
